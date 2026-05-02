/**
 * Minimal 5-field cron parser: minute hour day-of-month month day-of-week.
 *
 * Supports `*`, `*\/N`, `a-b`, `a-b/N`, comma-lists, and bare numbers.
 * POSIX rule: when both day-of-month and day-of-week are restricted,
 * the entry matches when *either* matches; otherwise both must match.
 */

export interface CronSchedule {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    let step = 1
    let range = part
    const stepMatch = /^(.+)\/(\d+)$/.exec(part)
    if (stepMatch) {
      range = stepMatch[1]
      step = parseInt(stepMatch[2], 10)
      if (!Number.isFinite(step) || step < 1) throw new Error(`invalid step "${part}"`)
    }
    let start: number
    let end: number
    if (range === '*') {
      start = min
      end = max
    } else if (range.includes('-')) {
      const [s, e] = range.split('-').map((v) => parseInt(v, 10))
      if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error(`invalid range "${part}"`)
      start = s
      end = e
    } else {
      const n = parseInt(range, 10)
      if (!Number.isFinite(n)) throw new Error(`invalid value "${part}"`)
      if (step === 1) {
        if (n < min || n > max) throw new Error(`value ${n} out of range ${min}-${max}`)
        out.add(n)
        continue
      }
      start = n
      end = max
    }
    if (start < min || end > max || start > end) {
      throw new Error(`range ${start}-${end} out of bounds ${min}-${max}`)
    }
    for (let i = start; i <= end; i += step) out.add(i)
  }
  if (out.size === 0) throw new Error(`empty field "${field}"`)
  return out
}

export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}`)
  }
  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 6),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
}

function dayMatches(cron: CronSchedule, d: Date): boolean {
  const dom = d.getDate()
  const dow = d.getDay()
  if (cron.domRestricted && cron.dowRestricted) {
    return cron.daysOfMonth.has(dom) || cron.daysOfWeek.has(dow)
  }
  return cron.daysOfMonth.has(dom) && cron.daysOfWeek.has(dow)
}

/**
 * Compute the next firing time strictly after `from`.
 * Searches minute-by-minute; bounded to ~4 years to catch impossible expressions.
 */
export function nextCronFiring(cron: CronSchedule, from: Date): Date {
  const d = new Date(from.getTime() + 60_000)
  d.setSeconds(0, 0)
  const limit = 366 * 24 * 60 * 4
  for (let i = 0; i < limit; i++) {
    if (
      cron.months.has(d.getMonth() + 1) &&
      dayMatches(cron, d) &&
      cron.hours.has(d.getHours()) &&
      cron.minutes.has(d.getMinutes())
    ) {
      return new Date(d)
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error('no firing time found within 4 years')
}
