/**
 * Relative time windows (`window=today`, `last_7d`, …) shared by the memory
 * tools and HTTP routes of every backend.
 */

export const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Time-window shortcuts (parity with Hermes rivet-memory v0.3)
// ---------------------------------------------------------------------------

/**
 * Named `window=` values for memory_browse / memory_search.
 * Resolve to UTC ISO bounds anchored at the process local timezone midnight,
 * so agents avoid the "UTC midnight = previous evening local" trap.
 */
export const WINDOW_CHOICES = [
  'today',
  'yesterday',
  'this_morning',
  'this_week',
  'last_24h',
  // Rolling multi-day ranges (not calendar weeks). Critical on Mon/Tue when
  // this_week is almost empty — "what did we do last week / recently" needs
  // these instead of inventing since= bare dates (UTC midnight trap).
  'last_7d',
  'last_14d',
] as const

export type WindowChoice = (typeof WINDOW_CHOICES)[number]

export function isWindowChoice(value: string): value is WindowChoice {
  return (WINDOW_CHOICES as readonly string[]).includes(value)
}

/**
 * Normalize free-form window strings agents commonly invent:
 * spaces/hyphens → underscores, lower-case, strip punctuation noise.
 * Also maps a few natural-language synonyms onto WINDOW_CHOICES.
 *
 * Returns null when the input is empty after cleanup.
 */
export function normalizeWindowInput(raw: string): string | null {
  let s = raw.trim().toLowerCase()
  if (!s) return null

  // Common multi-word / hyphen forms → snake_case tokens first.
  s = s
    .replace(/\blast\s*24\s*(?:h(?:ours?)?)?\b/g, 'last_24h')
    .replace(/\blast\s+day\b/g, 'last_24h')
    .replace(/\blast\s*(?:7|seven)\s*d(?:ays?)?\b/g, 'last_7d')
    .replace(/\blast\s*(?:14|fourteen)\s*d(?:ays?)?\b/g, 'last_14d')
    .replace(/\bpast\s*(?:7|seven)\s*d(?:ays?)?\b/g, 'last_7d')
    .replace(/\bpast\s*(?:14|fourteen)\s*d(?:ays?)?\b/g, 'last_14d')
    .replace(/\blast\s+week\b/g, 'last_7d')
    .replace(/\bpast\s+week\b/g, 'last_7d')
    .replace(/\blast\s+two\s+weeks?\b/g, 'last_14d')
    .replace(/\bpast\s+two\s+weeks?\b/g, 'last_14d')
    .replace(/\bthis\s+morning\b/g, 'this_morning')
    .replace(/\bthis\s+week\b/g, 'this_week')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  if (!s) return null

  // Synonyms that still differ after cleanup.
  const aliases: Record<string, WindowChoice> = {
    last24h: 'last_24h',
    last_24_hours: 'last_24h',
    last_24hours: 'last_24h',
    last_day: 'last_24h',
    past_24h: 'last_24h',
    morning: 'this_morning',
    week: 'this_week',
    // Rolling 7d — not "previous calendar Mon–Sun". Agents invent these
    // constantly for "what did we do last week / recently".
    last_week: 'last_7d',
    past_week: 'last_7d',
    last7d: 'last_7d',
    last_7_days: 'last_7d',
    last_7days: 'last_7d',
    past_7d: 'last_7d',
    past_7_days: 'last_7d',
    last14d: 'last_14d',
    last_14_days: 'last_14d',
    last_14days: 'last_14d',
    past_14d: 'last_14d',
    past_14_days: 'last_14d',
    last_two_weeks: 'last_14d',
    past_two_weeks: 'last_14d',
  }
  // Prefer explicit key list over `aliases[s]` truthiness — without
  // noUncheckedIndexedAccess, indexed access is typed as always-defined.
  for (const [key, value] of Object.entries(aliases)) {
    if (key === s) return value
  }
  return s
}

/** Human-readable list of valid window= values for error messages. */
export function formatWindowChoices(): string {
  return WINDOW_CHOICES.map((c) => `"${c}"`).join(', ')
}

/**
 * Convert a window name to `(since, before)` UTC ISO timestamps.
 *
 * Anchoring uses the process local timezone (or the local TZ of `now` when
 * injected for tests). Matches Hermes `resolve_window` semantics:
 * - today / this_morning → local midnight → now
 * - yesterday → local yesterday midnight → local today midnight
 * - this_week → local Monday midnight → now (ISO week, Mon=start)
 * - last_24h → rolling 24h from now
 * - last_7d / last_14d → rolling N×24h from now (not calendar weeks)
 *
 * Unknown names after {@link normalizeWindowInput} throw — silent no-op was
 * a daily-use footgun (agents thought they time-bounded, got full history).
 */
export function resolveWindow(
  window: string,
  now: Date = new Date(),
): { since: string | null; before: string | null } {
  const normalized = normalizeWindowInput(window)
  if (!normalized) {
    throw new Error(`Invalid window="" — expected one of: ${formatWindowChoices()}`)
  }
  if (!isWindowChoice(normalized)) {
    throw new Error(
      `Unknown window="${window}"` +
        (normalized !== window.trim().toLowerCase() ? ` (normalized to "${normalized}")` : '') +
        `. Expected one of: ${formatWindowChoices()}`,
    )
  }

  const startOfLocalDay = (d: Date): Date => {
    const x = new Date(d.getTime())
    x.setHours(0, 0, 0, 0)
    return x
  }

  const todayLocal = startOfLocalDay(now)

  switch (normalized) {
    case 'today':
    case 'this_morning':
      // "this morning" shares today's lower bound; agents narrow the result set.
      return { since: todayLocal.toISOString(), before: null }
    case 'yesterday': {
      const yest = new Date(todayLocal.getTime())
      yest.setDate(yest.getDate() - 1)
      return {
        since: yest.toISOString(),
        before: todayLocal.toISOString(),
      }
    }
    case 'this_week': {
      // ISO week — Monday start. JS getDay(): 0=Sun..6=Sat.
      // On Mon/Tue this is almost empty — prefer last_7d for "recent work".
      const monday = new Date(todayLocal.getTime())
      const day = monday.getDay()
      const daysFromMonday = day === 0 ? 6 : day - 1
      monday.setDate(monday.getDate() - daysFromMonday)
      return { since: monday.toISOString(), before: null }
    }
    case 'last_24h': {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      return { since: since.toISOString(), before: null }
    }
    case 'last_7d': {
      const since = new Date(now.getTime() - 7 * MS_PER_DAY)
      return { since: since.toISOString(), before: null }
    }
    case 'last_14d': {
      const since = new Date(now.getTime() - 14 * MS_PER_DAY)
      return { since: since.toISOString(), before: null }
    }
    default: {
      // Exhaustiveness — isWindowChoice already filtered.
      const _exhaustive: never = normalized
      throw new Error(
        `Unknown window="${String(_exhaustive)}". Expected one of: ${formatWindowChoices()}`,
      )
    }
  }
}

/**
 * Apply `window=` when neither explicit `since` nor `before` was supplied.
 * Explicit bounds always win (Hermes parity).
 *
 * Throws on unknown `window` values (see {@link resolveWindow}) so tools
 * surface a clear error instead of silently dropping the time filter.
 */
export function applyWindowArgs(args: { window?: unknown; since?: unknown; before?: unknown }): {
  since: string | undefined
  before: string | undefined
} {
  const explicitSince = typeof args.since === 'string' && args.since ? args.since : undefined
  const explicitBefore = typeof args.before === 'string' && args.before ? args.before : undefined
  if (explicitSince || explicitBefore) {
    return { since: explicitSince, before: explicitBefore }
  }
  if (typeof args.window === 'string' && args.window) {
    const { since, before } = resolveWindow(args.window)
    return {
      since: since ?? undefined,
      before: before ?? undefined,
    }
  }
  return { since: undefined, before: undefined }
}
