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
  if (Object.hasOwn(HARNESS_ACCENTS, c)) return HARNESS_ACCENTS[c]
  // Bounded match: a harness key may appear as one of at most two delimited
  // tokens (`pi-cli`, `rivet-kimi`, `opencode:ses_…`), never as a substring
  // (`gippity`, `copilot`) and never buried in a longer name
  // (`opencode-migration-helper`).
  const tokens = c.split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.length <= 2) {
    const keys = Object.keys(HARNESS_ACCENTS).sort((a, b) => b.length - a.length)
    for (const id of keys) {
      if (tokens.includes(id) && Object.hasOwn(HARNESS_ACCENTS, id)) {
        return HARNESS_ACCENTS[id]
      }
    }
  }
  return ACCENT_FALLBACK
}
