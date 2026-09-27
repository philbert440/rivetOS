import { createHash } from 'node:crypto'
import { safeJson } from './helpers.js'

/**
 * Fields that identify one message content for occurrence counting.
 * `toolArgs` omitted and `undefined` hash as an empty field; `null` does not
 * (it is the JSON token `null`), matching `eventIdFromContent`.
 */
export interface OccurrenceKey {
  role: string
  content: string
  toolName?: string
  toolArgs?: unknown
}

function tupleFields(parts: OccurrenceKey): string[] {
  return [
    parts.role,
    parts.content,
    parts.toolName ?? '',
    parts.toolArgs === undefined ? '' : safeJson(parts.toolArgs),
  ]
}

function sha256(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * Stable SHA-256 hex of the fields that define a message with no native id.
 * Same shape as kimi's `contentHashEventId`: NUL-joined fields, utf8, hex.
 * Same payload twice → same id → the den skips the second insert.
 *
 * `occurrence`, when passed, is an extra NUL field so callers that want the
 * hash itself to vary per repeat (S3b-2) do not have to build a second id.
 * Omitting it keeps the previous hash.
 */
export function eventIdFromContent(parts: {
  sessionKey: string
  role: string
  content: string
  toolName?: string
  toolArgs?: unknown
  occurrence?: number
}): string {
  const fields = [parts.sessionKey, ...tupleFields(parts)]
  if (parts.occurrence !== undefined) fields.push(String(parts.occurrence))
  return sha256(fields.join('\0'))
}

/**
 * SHA-256 hex of `role`, `content`, `toolName`, `toolArgs` only (NUL-joined).
 * Session and occurrence are not part of the hash; Claude puts those in the
 * `claude-code:<session>:occ:<hash>:<n>` id around it.
 */
export function contentTupleHash(parts: OccurrenceKey): string {
  return sha256(tupleFields(parts).join('\0'))
}

/**
 * 0-based index of the last row in `rows` that matches `key`.
 * Pass the inclusive prefix that ends at the row being identified — the
 * current event is the last match. No match returns 0.
 */
export function occurrenceIndex(rows: readonly OccurrenceKey[], key: OccurrenceKey): number {
  const want = tupleFields(key).join('\0')
  let count = 0
  for (const row of rows) {
    if (tupleFields(row).join('\0') === want) count += 1
  }
  return count === 0 ? 0 : count - 1
}
