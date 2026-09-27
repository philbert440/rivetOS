import { createHash } from 'node:crypto'
import { safeJson } from './helpers.js'

/**
 * Stable SHA-256 hex of the fields that define a message with no native id.
 * Same shape as kimi's `contentHashEventId`: NUL-joined fields, utf8, hex.
 * Same payload twice → same id → the den skips the second insert.
 */
export function eventIdFromContent(parts: {
  sessionKey: string
  role: string
  content: string
  toolName?: string
  toolArgs?: unknown
}): string {
  const material = [
    parts.sessionKey,
    parts.role,
    parts.content,
    parts.toolName ?? '',
    parts.toolArgs === undefined ? '' : safeJson(parts.toolArgs),
  ].join('\0')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}
