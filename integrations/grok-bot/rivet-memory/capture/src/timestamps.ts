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

export function parseFlexibleTime(raw: unknown): string | undefined {
  const epoch = parseEpochMs(raw)
  if (epoch) return epoch
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString()
  if (typeof raw === 'string' && raw.trim()) {
    const grok = parseGrokTimestamp(raw.trim())
    if (grok) return grok
    const dt = new Date(raw.trim())
    if (!Number.isNaN(dt.getTime())) return dt.toISOString()
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** send_message / communicate_update `result.success.timestamp` (epoch ms). */
export function extractToolResultTimestamp(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined
  const result = isRecord(part.result) ? part.result : part
  const success = isRecord(result.success) ? result.success : undefined
  return (
    parseFlexibleTime(success?.timestamp) ??
    parseFlexibleTime(result.timestamp) ??
    parseFlexibleTime(part.timestamp)
  )
}

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
): string | undefined {
  const userLike = role === 'user' || role === 'human'
  if (userLike) {
    const tag = extractTimestampTag(rawText)
    if (tag) return tag
  }
  if (isRecord(rec)) {
    const stored = parseFlexibleTime(rec.created_at ?? rec.createdAt ?? rec.timestampMs)
    if (stored) return stored
  }
  for (const part of parts) {
    const stamped = extractToolResultTimestamp(part)
    if (stamped) return stamped
  }
  return undefined
}

/**
 * Every output row gets a time. Order:
 * 1. explicit stamp on this record
 * 2. inherit nearest earlier stamp + (position delta) ms
 * 3. look ahead to the nearest later stamp − (position delta) ms
 * 4. file mtime − (lastPosition − position) ms (Date.now() if mtime unknown)
 */
export function deriveCreatedAt(args: {
  explicit?: string
  position: number
  earlier?: { time: string; position: number }
  later?: { time: string; position: number }
  fileMtimeMs?: number
  maxPosition: number
}): string {
  if (args.explicit) return args.explicit
  if (args.earlier) {
    return addMs(args.earlier.time, Math.max(0, args.position - args.earlier.position))
  }
  if (args.later) {
    return addMs(args.later.time, -Math.max(0, args.later.position - args.position))
  }
  const end = args.fileMtimeMs ?? Date.now()
  const back = Math.max(0, args.maxPosition - args.position)
  return new Date(end - back).toISOString()
}
