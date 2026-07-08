// Operator-owned terminal roster (~/.rivetos/den-term.json).
//
// The HTTP API accepts only roster KEYS — argv, cwd and env never travel over
// the wire in either direction. Every command is spawned directly from its
// argv array (no shell interpolation anywhere), so the roster file is the one
// and only place an operator defines what a den terminal can run.
//
// The file is re-read lazily (stat per lookup, parse only on change) so
// operator edits take effect without a restart. A malformed file is rejected
// loudly and the built-in defaults are used instead — a typo must never turn
// into "terminals silently gone" or, worse, a half-parsed roster.

import { statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

export interface RosterEntry {
  /** Human label shown by the viewer. */
  label: string
  /** argv — spawned directly, never via a shell. */
  cmd: string[]
  /** true: the PTY is expected to run a den-aware harness (gets a synthetic
   *  session.end on exit if the harness never sent one). false: plain
   *  process, no synthetic events ever. */
  room: boolean
  /** Working directory override (default: top-level roster cwd). */
  cwd?: string
  /** Extra env for this entry (layered over the top-level roster env). */
  env?: Record<string, string>
}

export interface TermRoster {
  /** Key spawned when POST /term omits `command`. */
  default: string
  commands: Record<string, RosterEntry>
  /** Default working directory for all entries. */
  cwd: string
  /** Env layered over the inherited service env for all entries. */
  env: Record<string, string>
}

export interface RosterProvider {
  /** Current roster — re-reads the config file when it changed on disk. */
  get(): TermRoster
}

// Keys travel in URLs and JSON — keep them boring (mirrors server.ts safeKey).
const KEY_RE = /^[\w.-]{1,32}$/

export function defaultRoster(): TermRoster {
  return {
    default: 'claude',
    cwd: homedir(),
    env: {},
    commands: {
      // Harnesses run non-interactively (driven by chat inject / a PTY the
      // viewer attaches to), so they must not block on approval prompts:
      //   - grok:   bypassPermissions mode auto-approves tools + edits
      //   - hermes: --yolo bypasses command approval, --accept-hooks
      //             auto-approves config hooks (else it prompts, or exits
      //             non-zero when it can't reach a TTY)
      // claude trusts its cwd via ~/.claude.json and needs no flag here.
      claude: { label: 'Claude Code', cmd: ['claude'], room: true },
      grok: {
        label: 'Grok Build',
        cmd: ['grok', '--permission-mode', 'bypassPermissions'],
        room: true,
      },
      hermes: { label: 'Hermes', cmd: ['hermes', '--yolo', '--accept-hooks'], room: true },
      shell: { label: 'Shell', cmd: ['bash', '-l'], room: false },
    },
  }
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === 'string')

function parseEntry(raw: unknown): RosterEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (typeof e.label !== 'string' || e.label.length === 0) return null
  if (
    !Array.isArray(e.cmd) ||
    e.cmd.length === 0 ||
    !e.cmd.every((a) => typeof a === 'string' && a.length > 0)
  )
    return null
  if (e.room !== undefined && typeof e.room !== 'boolean') return null
  if (e.cwd !== undefined && (typeof e.cwd !== 'string' || e.cwd.length === 0)) return null
  if (e.env !== undefined && !isStringMap(e.env)) return null
  const entry: RosterEntry = {
    label: e.label,
    cmd: e.cmd as string[],
    room: e.room === true,
  }
  if (typeof e.cwd === 'string') entry.cwd = e.cwd
  if (e.env !== undefined && isStringMap(e.env)) entry.env = e.env
  return entry
}

/** Strictly validate a parsed den-term.json; null = malformed (caller falls
 *  back to defaults). Anything invalid rejects the WHOLE file — a partially
 *  honored roster would hide the operator's mistake. */
export function parseRoster(raw: unknown): TermRoster | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.commands !== 'object' || r.commands === null || Array.isArray(r.commands))
    return null
  const commands: Record<string, RosterEntry> = {}
  for (const [key, value] of Object.entries(r.commands)) {
    if (!KEY_RE.test(key)) return null
    const entry = parseEntry(value)
    if (!entry) return null
    commands[key] = entry
  }
  const keys = Object.keys(commands)
  if (keys.length === 0) return null
  if (r.default !== undefined && typeof r.default !== 'string') return null
  const def = typeof r.default === 'string' && r.default in commands ? r.default : keys[0]
  if (r.cwd !== undefined && (typeof r.cwd !== 'string' || r.cwd.length === 0)) return null
  if (r.env !== undefined && !isStringMap(r.env)) return null
  return {
    default: def,
    commands,
    cwd: typeof r.cwd === 'string' ? r.cwd : homedir(),
    env: r.env !== undefined && isStringMap(r.env) ? r.env : {},
  }
}

/** Lazy-reloading roster source. Missing file = built-in defaults (quiet);
 *  malformed file = defaults + one loud log per bad edit. */
export function createRosterProvider(
  configFile: string,
  log: (msg: string) => void = console.error,
): RosterProvider {
  // cache keyed on (mtimeMs, size) — a re-save with identical stat is served
  // from cache, any content change (size or mtime) triggers a re-parse
  let cached: { mtimeMs: number; size: number; roster: TermRoster } | null = null
  return {
    get(): TermRoster {
      let stat: { mtimeMs: number; size: number }
      try {
        const s = statSync(configFile)
        stat = { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        cached = null
        return defaultRoster()
      }
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
        return cached.roster
      let roster: TermRoster | null
      try {
        roster = parseRoster(JSON.parse(readFileSync(configFile, 'utf8')))
      } catch {
        roster = null
      }
      if (!roster) {
        log(`[den-server] term: ${configFile} is malformed — using the built-in roster`)
        roster = defaultRoster()
      }
      cached = { ...stat, roster }
      return roster
    },
  }
}
