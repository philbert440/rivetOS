/**
 * Media — resolves message attachments into multimodal content.
 *
 * Handles image download, disk persistence, base64 encoding,
 * and building ContentPart arrays for the LLM. The runtime
 * calls resolveAttachments() and gets back structured content
 * without knowing anything about image formats or URLs.
 */

import type { Channel, InboundMessage, ContentPart } from '@rivetos/types'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'

const log = logger('Media')

export interface MediaResult {
  /** Content to send to the LLM — plain text or multimodal parts */
  userContent: string | ContentPart[]
  /** Paths to saved image files (for history/memory references) */
  savedImagePaths: string[]
}

/**
 * Resolve message attachments into LLM-ready content.
 *
 * - Downloads remote images and saves to disk
 * - Base64 encodes for LLM consumption
 * - Returns plain text if no image attachments
 */
export async function resolveAttachments(
  message: InboundMessage,
  channel: Channel,
  imageDir: string,
): Promise<MediaResult> {
  const savedImagePaths: string[] = []

  if (!message.attachments?.length || !channel.resolveAttachment) {
    return { userContent: message.text, savedImagePaths }
  }

  const parts: ContentPart[] = []
  if (message.text) {
    parts.push({ type: 'text', text: message.text })
  }

  for (const attachment of message.attachments) {
    if (attachment.type !== 'photo') continue

    const resolved = await channel.resolveAttachment(attachment)
    if (!resolved) continue

    // Save to disk
    await mkdir(imageDir, { recursive: true })
    const ext = (resolved.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg')
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
    const filePath = join(imageDir, fileName)

    if (resolved.data) {
      await writeFile(filePath, Buffer.from(resolved.data, 'base64'))
    } else if (resolved.url) {
      try {
        const imgRes = await fetch(resolved.url)
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer())
          await writeFile(filePath, buf)
          resolved.data = buf.toString('base64')
        }
      } catch (err: any) {
        log.error(`Failed to download image from ${resolved.url}: ${err.message}`)
      }
    }

    savedImagePaths.push(filePath)

    // Build image part for LLM
    if (resolved.data) {
      parts.push({
        type: 'image',
        data: resolved.data,
        mimeType: resolved.mimeType ?? 'image/jpeg',
      })
    } else if (resolved.url) {
      parts.push({
        type: 'image',
        url: resolved.url,
        mimeType: resolved.mimeType ?? 'image/jpeg',
      })
    }
  }

  const userContent = parts.some((p) => p.type === 'image') ? parts : message.text
  return { userContent, savedImagePaths }
}

/**
 * Build a history-safe content string from a message and its saved images.
 * Uses file path references instead of base64 to avoid bloating history.
 */
export function buildHistoryContent(text: string, savedImagePaths: string[]): string {
  if (savedImagePaths.length === 0) return text
  const refs = savedImagePaths.map((p) => `[image:${p}]`).join(' ')
  return text ? `${text}\n${refs}` : refs
}
