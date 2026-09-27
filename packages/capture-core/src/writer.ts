import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deadLetter, spoolBatch, spoolFiles } from './spool.js'
import type {
  CaptureBatch,
  CaptureMessage,
  CaptureResult,
  CaptureWriter,
  CaptureWriterOptions,
} from './types.js'

class CaptureClientError extends Error {}

const CONTENT_LIMIT = 16_000
const DEFAULT_CHUNK_BYTES = 768 * 1024

/**
 * Same cut as the den's capture writer: 16,000 UTF-16 units, no inline marker,
 * and one unit back when the cut would split a high surrogate.
 */
function capField(text: string): { text: string; truncated: boolean; fullLength: number } {
  if (text.length <= CONTENT_LIMIT) return { text, truncated: false, fullLength: text.length }
  const charCode = text.charCodeAt(CONTENT_LIMIT - 1)
  const cut = charCode >= 0xd800 && charCode <= 0xdbff ? CONTENT_LIMIT - 1 : CONTENT_LIMIT
  return { text: text.slice(0, cut), truncated: true, fullLength: text.length }
}

function capMessage(message: CaptureMessage): CaptureMessage {
  const content = capField(message.content)
  const tool = message.tool_result === undefined ? undefined : capField(message.tool_result)
  if (!content.truncated && !tool?.truncated) return message
  const metadata: Record<string, unknown> = { ...message.metadata }
  if (content.truncated) metadata.full_content_length = content.fullLength
  if (tool?.truncated) metadata.full_tool_result_length = tool.fullLength
  metadata.truncated = true
  return {
    ...message,
    content: content.text,
    ...(tool ? { tool_result: tool.text } : {}),
    metadata,
  }
}

function chunkFor(batch: CaptureBatch, messages: CaptureMessage[], isLast: boolean): CaptureBatch {
  if (isLast || batch.finalize === undefined) return { ...batch, messages }
  const { finalize: _finalize, ...rest } = batch
  return { ...rest, messages }
}

function encodedBytes(batch: CaptureBatch): number {
  return Buffer.byteLength(JSON.stringify(batch), 'utf8')
}

export function createCaptureWriter(opts: CaptureWriterOptions): CaptureWriter {
  const dir = opts.spoolDir ?? join(homedir(), '.rivetos', 'capture-spool')
  const fetch = opts.fetch ?? globalThis.fetch
  const requested = opts.maxChunkBytes ?? DEFAULT_CHUNK_BYTES
  const maxChunkBytes =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_CHUNK_BYTES
  const log = (error: unknown): void => {
    try {
      opts.log?.(String(error))
    } catch {
      /* Logging must not interrupt capture. */
    }
  }
  const fits = (batch: CaptureBatch, messages: CaptureMessage[], isLast: boolean): boolean =>
    encodedBytes(chunkFor(batch, messages, isLast)) <= maxChunkBytes
  const elided = new WeakSet<CaptureMessage>()
  const elideToolArgs = (message: CaptureMessage): CaptureMessage => {
    if (elided.has(message)) return message
    const serialized = message.tool_args === undefined ? '' : JSON.stringify(message.tool_args)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    log(`elided tool_args for event ${message.event_id} (${String(bytes)} bytes)`)
    const next: CaptureMessage = {
      ...message,
      tool_args: { _elided: true, bytes },
      metadata: { ...message.metadata, full_tool_args_length: bytes },
    }
    elided.add(next)
    return next
  }
  const splitChunks = (batch: CaptureBatch): CaptureBatch[] => {
    const messages = batch.messages
    if (messages.length === 0) return [chunkFor(batch, [], true)]
    const groups: CaptureMessage[][] = []
    let current: CaptureMessage[] = []
    const pushCurrent = (): void => {
      if (current.length === 0) return
      groups.push(current)
      current = []
    }
    for (const original of messages) {
      const aloneFits = fits(batch, [original], false) || fits(batch, [original], true)
      const message = aloneFits ? original : elideToolArgs(original)
      const solo = !aloneFits
      if (solo || (current.length > 0 && !fits(batch, [...current, message], false))) {
        pushCurrent()
        current = [message]
        if (solo) pushCurrent()
        continue
      }
      current = [...current, message]
    }
    pushCurrent()
    let guard = 0
    while (guard < messages.length + 2) {
      guard += 1
      const last = groups[groups.length - 1]
      if (fits(batch, last, true)) break
      if (last.length <= 1) {
        const only = last[0]
        if (elided.has(only)) break
        last[0] = elideToolArgs(only)
        continue
      }
      const peeled = last.pop()
      if (peeled === undefined) break
      groups.push([peeled])
    }
    return groups.map((msgs, index) => chunkFor(batch, msgs, index === groups.length - 1))
  }
  const post = async (body: string): Promise<CaptureResult> => {
    const response = await fetch(`${opts.denUrl.replace(/\/$/, '')}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!response.ok) await response.body?.cancel().catch(log)
    if (response.status >= 400 && response.status < 500) {
      throw new CaptureClientError(`capture HTTP ${response.status}`)
    }
    if (!response.ok) throw new Error(`capture HTTP ${response.status}`)
    return (await response.json()) as CaptureResult
  }
  const replay: CaptureWriter['replay'] = async (options) => {
    let replayed = 0
    let dead = 0
    try {
      const files = await spoolFiles(dir)
      const requestedMax = options?.max ?? 50
      const max = Number.isFinite(requestedMax) ? Math.max(0, Math.floor(requestedMax)) : 50
      for (const file of files.slice(0, max)) {
        try {
          const body = await readFile(join(dir, file), 'utf8')
          await post(body)
          await unlink(join(dir, file))
          replayed++
        } catch (error) {
          log(error)
          if (error instanceof CaptureClientError) {
            await deadLetter(dir, file)
            dead++
          } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            break
          }
        }
      }
      return { replayed, remaining: (await spoolFiles(dir)).length, dead }
    } catch (error) {
      log(error)
      return { replayed, remaining: (await spoolFiles(dir).catch(() => [])).length, dead }
    }
  }
  return {
    replay,
    async write(batch) {
      await replay({ max: 50 })
      const prepared: CaptureBatch = { ...batch, messages: batch.messages.map(capMessage) }
      const chunks = splitChunks(prepared)
      const base = (opts.now ?? (() => new Date()))()
      let inserted = 0
      let skipped = 0
      let conversationId = ''
      const files: string[] = []
      for (const [index, chunk] of chunks.entries()) {
        try {
          const result = await post(JSON.stringify(chunk))
          inserted += result.inserted
          skipped += result.skipped
          if (result.conversation_id) conversationId = result.conversation_id
        } catch (error) {
          log(error)
          if (error instanceof CaptureClientError) throw error
          try {
            const file = await spoolBatch(dir, chunk, new Date(base.getTime() + index))
            files.push(file)
          } catch (spoolError) {
            const message = `capture spool failed; batch was not saved: ${String(spoolError)}`
            log(message)
            return { spooled: false, error: message }
          }
        }
      }
      if (files.length > 0) return { spooled: true, file: files[0] ?? '', files }
      return { ok: true, conversation_id: conversationId, inserted, skipped }
    },
  }
}
