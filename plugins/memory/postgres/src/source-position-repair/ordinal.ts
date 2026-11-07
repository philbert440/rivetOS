import { createHash } from 'node:crypto'

/** Same stride grok-bot capture uses: `ordinal = position * 1000 + sub`. */
export const SOURCE_ORDINAL_STRIDE = 1000

const BACKFILL_SOURCE_ID = /^readtranscript:([^:]+):(\d+)(?::(\d+))?$/

export function sourceOrdinal(position: number, sub: number): number {
  if (!Number.isInteger(position) || position < 0) {
    throw new Error(`invalid source position ${String(position)}`)
  }
  if (!Number.isInteger(sub) || sub < 0 || sub >= SOURCE_ORDINAL_STRIDE) {
    throw new Error(`invalid source sub-index ${String(sub)}`)
  }
  return position * SOURCE_ORDINAL_STRIDE + sub
}

export function sourceSubIndex(position: number, ordinal: number): number | undefined {
  if (!Number.isInteger(position) || !Number.isInteger(ordinal) || position < 0 || ordinal < 0) {
    return undefined
  }
  const sub = ordinal - position * SOURCE_ORDINAL_STRIDE
  if (sub < 0 || sub >= SOURCE_ORDINAL_STRIDE) return undefined
  if (sourceOrdinal(position, sub) !== ordinal) return undefined
  return sub
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * NUL-joined SHA-256 matching `@rivetos/capture-core` `eventIdFromContent`
 * with `occurrence`. Local copy because this package is CJS and capture-core
 * is ESM. `ordinal.test.ts` pins equality, including grok-bot's
 * `content || toolResult` input.
 */
export function derivedCaptureEventId(parts: {
  sessionKey: string
  role: string
  content: string
  toolName?: string | null
  toolArgs?: unknown
  ordinal: number
}): string {
  const fields = [
    parts.sessionKey,
    parts.role,
    parts.content,
    parts.toolName ?? '',
    parts.toolArgs === undefined ? '' : safeJson(parts.toolArgs),
    String(parts.ordinal),
  ]
  return createHash('sha256').update(fields.join('\0'), 'utf8').digest('hex')
}

/** Same material as `ingestEventId` in write-tools.ts; pinned in ordinal.test.ts. */
export function derivedIngestEventId(parts: {
  sessionId: string
  agent: string
  role: string
  content: string
  ordinal: number
  toolName?: string | null
}): string {
  const material = [
    parts.sessionId,
    parts.agent,
    parts.role,
    parts.content,
    String(parts.ordinal),
    parts.toolName ?? '',
  ].join('\0')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

export function rewriteBackfillSourceId(
  sourceId: string,
  fromPosition: number,
  toPosition: number,
  sub: number,
): string | undefined {
  const match = BACKFILL_SOURCE_ID.exec(sourceId)
  if (!match) return undefined
  const slug = match[1]
  const pos = Number.parseInt(match[2], 10)
  const rawSub = match.at(3)
  const parsedSub =
    rawSub === undefined || rawSub.length === 0 ? undefined : Number.parseInt(rawSub, 10)
  if (pos !== fromPosition) return undefined
  if (parsedSub !== undefined && parsedSub !== sub) return undefined
  const base = `readtranscript:${slug}:${String(toPosition)}`
  return parsedSub === undefined ? base : `${base}:${String(sub)}`
}
