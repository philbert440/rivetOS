/**
 * Per-harness accent colors so the bots are recognizable at a glance.
 * Keyed by harness id (and roster-command alias). Unknown ids fall back
 * to the house emerald. Used for drawer dots and chat avatars.
 */

export const ACCENT_CLAUDE = '#CC785C'
export const ACCENT_GROK = '#9ca3af'
export const ACCENT_CODEX = '#5b8def'
export const ACCENT_KIMI = '#8b7cf6'
export const ACCENT_HERMES = '#e0a340'
export const ACCENT_OPENCODE = '#2dd4bf'
export const ACCENT_PI = '#f472b6'
export const ACCENT_FALLBACK = '#34d399'

/** String-keyed so opencode/pi compile before those ids land in HARNESS_IDS. */
export const HARNESS_ACCENTS: Record<string, string> = {
  'claude-code': ACCENT_CLAUDE,
  claude: ACCENT_CLAUDE,
  'grok-build': ACCENT_GROK,
  grok: ACCENT_GROK,
  codex: ACCENT_CODEX,
  'kimi-code': ACCENT_KIMI,
  kimi: ACCENT_KIMI,
  hermes: ACCENT_HERMES,
  opencode: ACCENT_OPENCODE,
  pi: ACCENT_PI,
}

export function harnessAccent(command?: string): string {
  const c = (command ?? '').toLowerCase()
  if (!c) return ACCENT_FALLBACK
  const exact = HARNESS_ACCENTS[c]
  if (exact) return exact
  const keys = Object.keys(HARNESS_ACCENTS).sort((a, b) => b.length - a.length)
  for (const id of keys) {
    if (c.includes(id)) return HARNESS_ACCENTS[id]
  }
  return ACCENT_FALLBACK
}
