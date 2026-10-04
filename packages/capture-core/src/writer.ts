import { readFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  captureRedactionFromEnv,
  redactMessage,
  resolveCaptureRedaction,
  type ResolvedCaptureRedaction,
} from './redaction.js'
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
const CHUNK_OVER_LIMIT = 'chunk exceeds maxChunkBytes after elision'

/** Keys memory_get_full and the capture server still need after metadata elision. */
const METADATA_KEEP = new Set([
  'event_id',
  'session_jsonl_path',
  'session_jsonl_line',
  'session_sqlite_path',
  'session_sqlite_part_id',
  'truncated',
  'ordinal',
  'native_event_id',
  'source',
  'metadata_elided',
  'full_metadata_bytes',
])

function keepMetadataKey(key: string): boolean {
  return METADATA_KEEP.has(key) || /^full_.+_length$/.test(key)
}

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

/**
 * Only an explicit `enabled` key on options overrides the env. `redaction: {}`
 * or `{ builtins: false }` without `enabled` must not silently disable an
 * env opt-in — docs say only `{ enabled: false }` wins over the env.
 */
function resolveWriterRedaction(opts: CaptureWriterOptions): ResolvedCaptureRedaction | null {
  if (opts.redaction !== undefined && opts.redaction.enabled !== undefined) {
    return resolveCaptureRedaction(opts.redaction)
  }
  return resolveCaptureRedaction(captureRedactionFromEnv())
}

/** Same header as `USER_TOKEN_HEADER` in `@rivetos/types` (this package has no dependencies). */
const USER_TOKEN_HEADER = 'x-rivetos-user-token'

/** A directory name for a user id, whatever characters the id has. */
function spoolNameFor(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 32)
}

export function createCaptureWriter(opts: CaptureWriterOptions): CaptureWriter {
  // A session spawned for another user proves it to the den with its token,
  // and spools to a directory of that user's own: a spooled batch is replayed
  // by whoever next writes from the same directory, and must not be replayed
  // as anyone else.
  const user = opts.user
  const dir =
    opts.spoolDir ??
    (user
      ? join(homedir(), '.rivetos', 'capture-spool-users', spoolNameFor(user.id))
      : join(homedir(), '.rivetos', 'capture-spool'))
  const fetch = opts.fetch ?? globalThis.fetch
  const requested = opts.maxChunkBytes ?? DEFAULT_CHUNK_BYTES
  const maxChunkBytes =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_CHUNK_BYTES
  const redaction = resolveWriterRedaction(opts)
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
  const metaElided = new WeakSet<CaptureMessage>()
  const elideToolArgs = (message: CaptureMessage): CaptureMessage => {
    if (elided.has(message)) return message
    // Nothing to drop. Mark it so a later pass moves on to metadata.
    if (message.tool_args === undefined) {
      elided.add(message)
      return message
    }
    const serialized = JSON.stringify(message.tool_args)
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
  const elideMetadata = (message: CaptureMessage): CaptureMessage => {
    if (metaElided.has(message)) return message
    const metadata = message.metadata ?? {}
    const bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8')
    log(`elided metadata for event ${message.event_id} (${String(bytes)} bytes)`)
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (keepMetadataKey(key)) kept[key] = value
    }
    kept.metadata_elided = true
    kept.full_metadata_bytes = bytes
    const next: CaptureMessage = { ...message, metadata: kept }
    elided.add(next)
    metaElided.add(next)
    return next
  }
  /**
   * Tool args first, then metadata. Returns the same object once neither
   * elision can change it, so the caller can stop.
   */
  const shrinkSingleton = (
    message: CaptureMessage,
    isLast: boolean,
    batch: CaptureBatch,
  ): CaptureMessage => {
    let current = message
    if (fits(batch, [current], isLast)) return current
    if (!elided.has(current)) current = elideToolArgs(current)
    if (fits(batch, [current], isLast)) return current
    if (!metaElided.has(current)) current = elideMetadata(current)
    return current
  }
  const splitChunks = (batchIn: CaptureBatch): CaptureBatch[] => {
    // Header bytes do not depend on messages. A settings blob that already
    // exceeds the budget would make every chunk undeliverable.
    let batch = batchIn
    if (batch.settings !== undefined && encodedBytes(chunkFor(batch, [], true)) > maxChunkBytes) {
      const bytes = Buffer.byteLength(JSON.stringify(batch.settings), 'utf8')
      log(`elided settings (${String(bytes)} bytes)`)
      batch = { ...batch, settings: { _elided: true, bytes } }
    }
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
        const next = shrinkSingleton(only, true, batch)
        if (next === only) break
        last[0] = next
        continue
      }
      const peeled = last.pop()
      if (peeled === undefined) break
      groups.push([peeled])
    }
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]
      if (group.length !== 1) continue
      const isLast = index === groups.length - 1
      if (fits(batch, group, isLast)) continue
      groups[index] = [shrinkSingleton(group[0], isLast, batch)]
    }
    return groups.map((msgs, index) => chunkFor(batch, msgs, index === groups.length - 1))
  }
  const post = async (body: string): Promise<CaptureResult> => {
    const response = await fetch(`${opts.denUrl.replace(/\/$/, '')}/api/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { [USER_TOKEN_HEADER]: user.token } : {}),
      },
      body,
    })
    if (!response.ok) await response.body?.cancel().catch(log)
    // A token the den does not know (the node restarted since this session
    // was spawned) is not a bad batch: keep it for the user's next session.
    if (user && (response.status === 401 || response.status === 403)) {
      throw new Error(`capture HTTP ${String(response.status)} (user token not accepted)`)
    }
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
      let messages = batch.messages
      if (redaction) {
        let redactedSpans = 0
        messages = messages.map((message) => {
          const result = redactMessage(message, redaction)
          redactedSpans += result.count
          return result.message
        })
        if (redactedSpans > 0) {
          log(`redacted ${String(redactedSpans)} spans`)
        }
      }
      const prepared: CaptureBatch = { ...batch, messages: messages.map(capMessage) }
      const chunks = splitChunks(prepared)
      const base = (opts.now ?? (() => new Date()))()
      let inserted = 0
      let skipped = 0
      let conversationId = ''
      const files: string[] = []
      for (const [index, chunk] of chunks.entries()) {
        // Never post or spool a body the server will refuse. Earlier chunks
        // may already have been delivered; they are idempotent. This return
        // is not an acknowledgement, so the caller must not advance.
        if (encodedBytes(chunk) > maxChunkBytes) {
          log(CHUNK_OVER_LIMIT)
          return { spooled: false, error: CHUNK_OVER_LIMIT }
        }
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
