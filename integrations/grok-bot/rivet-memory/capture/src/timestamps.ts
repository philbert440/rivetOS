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
