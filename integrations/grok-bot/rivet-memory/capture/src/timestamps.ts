import { INHERIT_STEP_MS } from './types.js'

export { INHERIT_STEP_MS }

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

/**
 * Parse a Grok Bot wall-clock stamp such as
 * `Sunday, Sep 27, 2026, 4:06 PM (UTC-4)` into an absolute ISO-8601 UTC time.
 * The parenthetical offset is respected (UTC-4, UTC+5:30, UTC, UTC+0).
 */
export function parseGrokTimestamp(raw: string): string | undefined {
  const text = raw.trim()
  const m =
    /^(?:\w+,\s+)?(\w+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s*\(\s*UTC\s*([+-]\d{1,2}(?::\d{2})?)?\s*\)$/i.exec(
      text,
    )
  if (!m) return undefined
  const monthKey = m[1].toLowerCase()
  if (!Object.hasOwn(MONTHS, monthKey)) return undefined
  const month = MONTHS[monthKey]
  const day = Number(m[2])
  const year = Number(m[3])
  let hour = Number(m[4])
  const minute = Number(m[5])
  const second = m[6] ? Number(m[6]) : 0
  const ampm = m[7].toUpperCase()
  if (ampm === 'PM' && hour < 12) hour += 12
  if (ampm === 'AM' && hour === 12) hour = 0
  const offsetMin = parseUtcOffsetMinutes(m[8] || '+0')
  const utcMs = Date.UTC(year, month, day, hour, minute, second) - offsetMin * 60_000
  const dt = new Date(utcMs)
  if (Number.isNaN(dt.getTime())) return undefined
  return dt.toISOString()
}

export function parseUtcOffsetMinutes(raw: string): number {
  const m = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw.trim())
  if (!m) return 0
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0))
}

export function extractTimestampTag(text: string): string | undefined {
  const m = /<timestamp>\s*([^<]+?)\s*<\/timestamp>/i.exec(text)
  if (!m) return undefined
  return parseGrokTimestamp(m[1])
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

/**
 * Epoch seconds/ms as a number or numeric string (send_message
 * `result.success.timestamp`, store.db `timestampMs`).
 */
export function parseEpochMs(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    const dt = new Date(ms)
    return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString()
  }
  if (typeof raw === 'string' && /^\d{10,16}$/.test(raw.trim())) {
    return parseEpochMs(Number(raw.trim()))
  }
  return undefined
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** Known shapes only: epoch, Date, Grok wall-clock, ISO-8601. No `new Date(any)`. */
export function parseKnownTime(raw: unknown): string | undefined {
  const epoch = parseEpochMs(raw)
  if (epoch) return epoch
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString()
  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim()
    const grok = parseGrokTimestamp(text)
    if (grok) return grok
    if (ISO_RE.test(text)) {
      const dt = new Date(text)
      if (!Number.isNaN(dt.getTime())) return dt.toISOString()
    }
  }
  return undefined
}

export function parseFlexibleTime(raw: unknown): string | undefined {
  return parseKnownTime(raw)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * send_message / communicate_update `result.success.timestamp` only (epoch).
 * Ignores result.timestamp / part.timestamp / free-form date strings.
 */
export function extractToolResultTimestamp(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined
  const result = isRecord(part.result) ? part.result : part
  const success = isRecord(result.success) ? result.success : undefined
  return parseEpochMs(success?.timestamp)
}

export type ExplicitTimeSource = 'tag' | 'tool_epoch' | 'stored'

/**
 * Explicit wall-clock for one source record. `<timestamp>` on user/hidden
 * text only — assistant/tool quotes are ignored. Record-level created_at
 * (store/voice) and tool-result epoch stamps are first-class sources.
 */
export function recordExplicitTime(
  rec: unknown,
  rawText: string,
  role: string,
  parts: unknown[],
): { time: string; source: ExplicitTimeSource } | undefined {
  const userLike = role === 'user' || role === 'human'
  if (userLike) {
    const tag = extractTimestampTag(rawText)
    if (tag) return { time: tag, source: 'tag' }
  }
  if (isRecord(rec)) {
    const stored = parseKnownTime(rec.created_at ?? rec.createdAt ?? rec.timestampMs)
    if (stored) return { time: stored, source: 'stored' }
  }
  for (const part of parts) {
    const stamped = extractToolResultTimestamp(part)
    if (stamped) return { time: stamped, source: 'tool_epoch' }
  }
  return undefined
}

const EQUAL_SPAN_STEP_MS = 1

export type DerivedTime = {
  time: string
  source: 'tag' | 'tool_epoch' | 'stored' | 'inherited' | 'interpolated' | 'lookahead' | 'mtime'
}

/**
 * Every output row gets a time. Order:
 * 1. explicit stamp on this record
 * 2. interpolate evenly between the previous and next real stamps
 * 3. after the last stamp, inherit at INHERIT_STEP_MS per position
 * 4. look ahead from the first later stamp − INHERIT_STEP_MS per position
 * 5. file mtime − (lastPosition − position) ms (Date.now() if mtime unknown)
 */
export function deriveCreatedAt(args: {
  explicit?: { time: string; source: ExplicitTimeSource }
  position: number
  earlier?: { time: string; position: number }
  later?: { time: string; position: number }
  fileMtimeMs?: number
  maxPosition: number
}): DerivedTime {
  if (args.explicit) return { time: args.explicit.time, source: args.explicit.source }
  if (args.earlier && args.later) {
    const t0 = Date.parse(args.earlier.time)
    const t1 = Date.parse(args.later.time)
    const span = args.later.position - args.earlier.position
    if (t1 > t0 && span > 0) {
      const t = t0 + ((t1 - t0) * (args.position - args.earlier.position)) / span
      return { time: new Date(t).toISOString(), source: 'interpolated' }
    }
    return {
      time: addMs(
        args.earlier.time,
        EQUAL_SPAN_STEP_MS * Math.max(0, args.position - args.earlier.position),
      ),
      source: 'inherited',
    }
  }
  if (args.earlier) {
    return {
      time: addMs(
        args.earlier.time,
        INHERIT_STEP_MS * Math.max(0, args.position - args.earlier.position),
      ),
      source: 'inherited',
    }
  }
  if (args.later) {
    return {
      time: addMs(
        args.later.time,
        -INHERIT_STEP_MS * Math.max(0, args.later.position - args.position),
      ),
      source: 'lookahead',
    }
  }
  const end = args.fileMtimeMs ?? Date.now()
  const back = Math.max(0, args.maxPosition - args.position)
  return { time: new Date(end - back).toISOString(), source: 'mtime' }
}
