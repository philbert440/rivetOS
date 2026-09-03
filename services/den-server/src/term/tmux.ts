// tmux mux layer for den PTYs (plan: rivethub-embedded-terminal T1).
//
// When `term.mux` resolves to 'tmux', the manager's PTY is a tmux CLIENT on a
// dedicated per-den socket (`-L rivet-<hash>`); the harness lives in the tmux
// server and survives den restarts, browser detaches and the idle/detached
// reapers. A user can attach the same session from their own terminal with
// `tmux -L <socket> attach -t <session>`.
//
// Everything tmux touches goes through the TmuxCtl seam: production uses the
// execFileSync implementation below (no shell, 250ms timeout), tests inject a
// scripted fake so unit tests never spawn a real tmux.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Per-den tmux socket name (T1 fix): a fixed `-L rivet` socket is per-uid, so
 *  two den processes on one node (an overlapping restart, parallel tests)
 *  would share ONE tmux server and each other's sessions. Keyed on the state
 *  dir + port so every den gets its own server; stable across restarts of the
 *  same den so persisted sessions stay reachable. */
export function tmuxSocketName(stateDir: string, port: number): string {
  const hash = createHash('sha1').update(`${stateDir}:${port}`).digest('hex').slice(0, 8)
  return `rivet-${hash}`
}

/** The tmux binary is missing, too old, hung, or its server is unreachable.
 *  Distinct from "no such session" (exit status 1): callers must fail closed
 *  on this — never treat it as "session absent, go create". */
export class TmuxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TmuxUnavailableError'
  }
}

/** The tmux command surface the manager uses. Sync: the manager's spawn path
 *  is synchronous, and every invocation is a sub-10ms local socket call
 *  bounded by the execFileSync timeout in the real implementation.
 *
 *  Error contract: "not found" (exit status 1) collapses to false/[]; every
 *  other failure (ETIMEDOUT, ENOENT, nonzero≠1 status) throws
 *  TmuxUnavailableError so POST/DELETE fail closed instead of
 *  creating/skipping. */
export interface TmuxCtl {
  /** True when a session with this (encoded) name exists on our socket. */
  hasSession(name: string): boolean
  /** Kill the session; no-throw when it is already gone. */
  killSession(name: string): void
  /** All sessions on our socket (empty when the server isn't running).
   *  Memoized ~1s by the real implementation: /term/list is polled. */
  listSessions(): TmuxSessionInfo[]
  /** Drop the listSessions memo. The manager calls this before a spawn's
   *  create-vs-attach decision — that decision needs a fresh view, not a
   *  cached one. Optional: fakes without a memo don't need it. */
  refresh?(): void
  /** Stamp a session option on an already-existing session
   *  (`set-option -t =<name>`). Used to adopt pre-fix untagged sessions;
   *  create stamps tags in the new-session command chain instead (no `-t`,
   *  because tmux resolves `-t =<name>` before `new-session` has created it). */
  setOption?(name: string, option: string, value: string): void
}

export interface TmuxSessionInfo {
  /** Encoded tmux session name (decode with decodeTmuxName). */
  name: string
  /** `#{session_activity}` — epoch seconds of last client/pane activity.
   *  Display-only (merged list rows); NEVER a liveness/idle signal — a quiet
   *  harness at a prompt looks idle, so GC tracks detach time itself. */
  activity: number
  /** `#{session_created}` — epoch seconds. */
  created: number
  /** `#{pane_pid}` — first pane's shell pid, when the query provides it. */
  pid?: number
  /** The `@rivet_command` session option ('' when unset). Stamped atomically
   *  at create. Untagged sessions whose name round-trips as a den session key
   *  are den's (pre-fix creates) and are adopted on attach; names that do not
   *  decode as a den key are foreign — never listed, attached or GC'd. */
  command: string
  /** The `@rivet_user` session option ('' when unset): the den-stamped routed
   *  identity that created the session, or 'owner'. Attach refuses a mismatch. */
  user: string
}

// ---------------------------------------------------------------------------
// Session-name encoding
// ---------------------------------------------------------------------------
//
// tmux rejects `.` and `:` in `-s` names; den session keys allow both
// (canonical keys are `<harness>:<uuid>`). The mapping must be REVERSIBLE
// (list() decodes persisted rows back to den session keys), so `_` itself is
// escaped first — the naive `:`→`__` mapping collides with literal `__`.
//   `_` → `__`   then   `:` → `_c`   `.` → `_d`
// Encoded names contain `_` only in those three digraphs, so decoding is an
// unambiguous left-to-right scan. Keys with chars outside the den session
// alphabet fall back to `~` + base64url (`~` is legal in tmux names, illegal
// in den session keys, and absent from base64url — an unambiguous marker).
// NEVER derive the den session key from the tmux name on the spawn path —
// PtyRecord stores both; decoding exists for list() rows only.

const SAFE_KEY_RE = /^[a-zA-Z0-9:_.-]+$/

/** Encode a den session key for tmux. Throws on keys whose encoding would
 *  start with `-`: tmux targets are passed as `-t =<name>`, but `-s <name>`
 *  at create still goes through tmux's option parser — reject instead of
 *  relying on `--` placement. */
export function encodeTmuxName(key: string): string {
  if (key.startsWith('-')) throw new Error(`tmux session name must not start with '-': ${key}`)
  if (!SAFE_KEY_RE.test(key)) return `~${Buffer.from(key, 'utf8').toString('base64url')}`
  return key.replace(/_/g, '__').replace(/:/g, '_c').replace(/\./g, '_d')
}

export function decodeTmuxName(name: string): string {
  if (name.startsWith('~')) {
    try {
      return Buffer.from(name.slice(1), 'base64url').toString('utf8')
    } catch {
      return name
    }
  }
  let out = ''
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '_' && i + 1 < name.length) {
      const n = name[i + 1]
      if (n === '_') {
        out += '_'
        i++
        continue
      }
      if (n === 'c') {
        out += ':'
        i++
        continue
      }
      if (n === 'd') {
        out += '.'
        i++
        continue
      }
    }
    out += name[i]
  }
  return out
}

/** True when `name` round-trips through den's tmux encoding as a legal den
 *  session key. On den's private `-L rivet-<hash>` socket that is proof the
 *  session is den's, even if `@rivet_command` was never stamped (pre-fix
 *  creates). A raw underscore (`a_b`) or a `.`/':' that encoding would have
 *  rewritten does NOT round-trip. The `~` + base64url fallback in
 *  `encodeTmuxName` is for keys outside the den alphabet — those never
 *  round-trip as den names, so `~` is rejected up front. */
export function isDenTmuxName(name: string): boolean {
  if (!name || name.startsWith('~')) return false
  try {
    const decoded = decodeTmuxName(name)
    if (
      !/^[a-zA-Z0-9:_.-]{1,120}$/.test(decoded) ||
      decoded.startsWith('-') ||
      decoded.startsWith('task:')
    )
      return false
    return encodeTmuxName(decoded) === name
  } catch {
    return false
  }
}

export type ExistingTmuxDisposition = 'attach' | 'adopt' | 'foreign' | 'user-mismatch'

/** How spawn should treat a session that already exists on den's socket. */
export function classifyExistingTmuxSession(
  s: TmuxSessionInfo,
  routedUser?: string,
): ExistingTmuxDisposition {
  const want = routedUser ?? 'owner'
  // Once @rivet_command is set, an unset @rivet_user means 'owner' — a
  // routed non-owner must not attach. Pre-fix sessions have BOTH tags
  // empty and take the adopt path below.
  if (s.command) {
    const have = s.user || 'owner'
    if (have !== want) return 'user-mismatch'
    return 'attach'
  }
  if (s.user && s.user !== want) return 'user-mismatch'
  if (isDenTmuxName(s.name)) {
    // Untagged + decodable: only the node owner may adopt. A routed
    // non-owner POSTing the same session key would otherwise claim
    // another user's running harness (credentials included).
    if (want !== 'owner') return 'user-mismatch'
    return 'adopt'
  }
  return 'foreign'
}

/** Sourced by the CREATE harness wrapper; `$0` is the env file. */
export const TMUX_ENV_WRAP_SCRIPT = 'set -a; . "$0"; set +a; rm -f "$0"; exec "$@"'

const LOCALE_KEYS = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const

/** The key that decides the codeset: first of LC_ALL, LC_CTYPE, LANG that is
 *  set and non-empty (same rule as tmux and glibc); undefined when none is. */
export function localeDecidingKey(env: Record<string, string>): string | undefined {
  return LOCALE_KEYS.find((k) => env[k])
}

/** Rewrite the deciding locale key to C.UTF-8 unless it is already UTF-8;
 *  with none set, LANG=C.UTF-8. Returns the keys it changed. */
export function ensureUtf8Locale(env: Record<string, string>): string[] {
  const deciding = localeDecidingKey(env)
  if (deciding === undefined) {
    env.LANG = 'C.UTF-8'
    return ['LANG']
  }
  if (/utf-?8/i.test(env[deciding])) return []
  env[deciding] = 'C.UTF-8'
  return [deciding]
}

/** tmux client argv for CREATE. `-u` (immediately after `tmux`) forces the
 *  client to UTF-8 regardless of den's own locale, so the RivetHub pane
 *  renders box-drawing and other non-ASCII even when den started as LANG=C.
 *  Tags and `set-environment -r` are chained
 *  WITHOUT `-t` — in a command sequence tmux resolves `-t =<name>` before
 *  `new-session` has created the session, so the stamp is silently dropped.
 *  The sequence's current session after `new-session` is the one just made.
 *  Keep `-t =<name>` only on later, separate ctl calls. */
export function tmuxCreateArgv(opts: {
  socket: string
  confPath: string
  name: string
  cwd: string
  cols: number
  rows: number
  envPairs: string[]
  envFile: string
  harness: string[]
  command: string
  user: string
  unsetKeys: string[]
  /** Test/integration only: `new-session -d` so the chain runs without
   *  attaching a client (the live PTY path omits `-d`). */
  detached?: boolean
}): string[] {
  const unsetChain: string[] = []
  for (const k of opts.unsetKeys) {
    unsetChain.push(';', 'set-environment', '-r', k)
  }
  return [
    'tmux',
    '-u',
    '-L',
    opts.socket,
    '-f',
    opts.confPath,
    'new-session',
    ...(opts.detached ? ['-d'] : []),
    '-s',
    opts.name,
    '-c',
    opts.cwd,
    '-x',
    String(opts.cols),
    '-y',
    String(opts.rows),
    ...opts.envPairs,
    '--',
    '/bin/sh',
    '-c',
    TMUX_ENV_WRAP_SCRIPT,
    opts.envFile,
    ...opts.harness,
    ';',
    'set-option',
    '@rivet_command',
    opts.command,
    ';',
    'set-option',
    '@rivet_user',
    opts.user,
    ...unsetChain,
  ]
}

/** tmux client argv for ATTACH. `-u` forces the client to UTF-8 regardless
 *  of den's own locale. `-t =<name>` is required here: this is a
 *  separate invocation against a session that already exists. */
export function tmuxAttachArgv(socket: string, confPath: string, name: string): string[] {
  return ['tmux', '-u', '-L', socket, '-f', confPath, 'attach-session', '-t', `=${name}`]
}

// ---------------------------------------------------------------------------
// Binary detection + version probe + generated config
// ---------------------------------------------------------------------------

/** which(1)-style lookup over PATH with fs.access — no shell. Returns the
 *  absolute path of the first executable REGULAR FILE match (a directory or
 *  device named `tmux` is not a binary), null when absent. */
export function findOnPath(name: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isFile()) continue
      return candidate
    } catch {
      // not here — keep looking
    }
  }
  return null
}

/** `tmux -V` version probe. The create form relies on `new-session -e` and
 *  session option chaining, which need tmux ≥ 3.2 — an older binary must read
 *  as "unavailable", not half-work. Returns the parsed [major, minor] or null
 *  (binary broke, timed out, or an unparseable/`next-` version string). */
export function tmuxVersion(bin: string): [number, number] | null {
  try {
    const out = execFileSync(bin, ['-V'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /(\d+)\.(\d+)/.exec(out)
    if (!m) return null
    return [Number(m[1]), Number(m[2])]
  } catch {
    return null
  }
}

/** True when the binary at `bin` is new enough for the den spawn form. */
export function tmuxSupported(bin: string): boolean {
  const v = tmuxVersion(bin)
  return v !== null && (v[0] > 3 || (v[0] === 3 && v[1] >= 2))
}

/** Our own minimal tmux.conf, written once per process to
 *  <stateDir>/den/tmux.conf. When the user opts INTO their own ~/.tmux.conf
 *  it is sourced FIRST and every persistence-critical setting is re-asserted
 *  after it — a user conf that flips `destroy-unattached on` must not silently
 *  void the "sessions survive detach" contract. `status off` because the
 *  embedded pane is a single window and the status bar would eat a row — a
 *  user attaching externally can toggle it back on with
 *  `tmux set -g status on` for their own client. */
export function tmuxConfContent(userConf: boolean): string {
  const lines = [
    // the user's own settings load first…
    ...(userConf ? ['source-file -q ~/.tmux.conf'] : []),
    // …then the persistence contract is (re-)asserted over them
    'set -g default-terminal "tmux-256color"',
    'set -g destroy-unattached off',
    'set -g exit-empty off',
    'set -g remain-on-exit off',
    'set -g history-limit 50000',
    'set -g window-size latest',
    'set -g status off',
    'set -g escape-time 10',
    'set -g focus-events on',
    'set -g mouse on',
    'set -g extended-keys on',
    "# wheel: forward to apps that track the mouse; alt-screen apps without mouse get arrows (today's behaviour); normal screen scrolls tmux history",
    'bind -n WheelUpPane if -F "#{mouse_any_flag}" "send-keys -M" "if -F \'#{alternate_on}\' \'send-keys -N 3 Up\' \'copy-mode -e; send-keys -M\'"',
    'bind -n WheelDownPane if -F "#{mouse_any_flag}" "send-keys -M" "if -F \'#{alternate_on}\' \'send-keys -N 3 Down\' \'send-keys -M\'"',
    "# no tmux context menu on right-click — the pane's own right-click paste stays in charge",
    'unbind -n MouseDown3Pane',
    'set -s set-clipboard on',
  ]
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Real implementation (execFileSync — no shell, bounded wait)
// ---------------------------------------------------------------------------

/** Tight bound for local-socket calls: a wedged tmux server must not stall
 *  the single-threaded den event loop on polled/request paths. */
const TMUX_TIMEOUT_MS = 250

/** listSessions/hasSession memo: /term/list is polled by RivetHub and
 *  hasSession rides exit paths — fork-bombing tmux on every call is not an
 *  option on a single-threaded loop. */
const TMUX_MEMO_MS = 1000

/** The execFileSync shape the ctl needs — injectable so tests can script
 *  exit-1 vs ETIMEDOUT/ENOENT behavior without a real tmux. */
export type TmuxExec = (
  bin: string,
  args: string[],
  opts: { encoding: 'utf8'; timeout: number; stdio: ['ignore', 'pipe', 'ignore'] },
) => string

/** TmuxCtl backed by the real tmux binary (absolute path from findOnPath —
 *  never a bare name resolved per-call). Every call is execFileSync with a
 *  250ms timeout, no shell, `-u -L <socket> -f <conf>` on EVERY argv (–u forces UTF-8 so -F tab
 *  separators survive LANG=C — see run()) (a ctl call
 *  is what starts the server on first use — without our conf the server would
 *  come up with `exit-empty on` and the persistence contract is lost), and
 *  `-t =<name>` targets (`=` forces an exact match; a bare `-t name` is a
 *  prefix/fnmatch target, so `has-session -t a` would match `ab`).
 *
 *  Error classification (the TmuxCtl contract): exit status 1 is "not found"
 *  (no server, no session) → false/[]; ANYTHING else — ETIMEDOUT, ENOENT,
 *  another exit status — throws TmuxUnavailableError so callers fail closed. */
export function createRealTmuxCtl(
  binary: string,
  socket: string,
  confPath: string,
  execFn: TmuxExec = execFileSync,
): TmuxCtl {
  const run = (args: string[]): string | null => {
    try {
      // `-u` forces UTF-8, exactly as the new-session spawn argv does. Without
      // it, a den running under LANG=C (systemd sets no UTF-8 locale) makes
      // tmux render the TAB field separator in `-F` output as `_`, so every
      // list-sessions row parses as one field: name = the whole mangled line,
      // command = '' → /term/list drops the row (needs a command) and
      // spawn-or-get's `find(name === tmuxName)` never matches, wrongly
      // throwing "session exists but is not listable" for a live session while
      // has-session (a boolean, no -F output) stays truthful. (2026-09-03)
      return execFn(binary, ['-u', '-L', socket, '-f', confPath, ...args], {
        encoding: 'utf8',
        timeout: TMUX_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (e) {
      const err = e as { status?: unknown; code?: unknown }
      // exit status 1 = "no server / no such session" — the safe fallback
      if (typeof err.status === 'number' && err.status === 1) return null
      throw new TmuxUnavailableError(`tmux ctl failed (${args[0]}): ${String(e)}`)
    }
  }

  let memo: { at: number; sessions: TmuxSessionInfo[] } | undefined
  const listFresh = (): TmuxSessionInfo[] => {
    const stdout = run([
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_activity}\t#{session_created}\t#{pane_pid}\t#{@rivet_command}\t#{@rivet_user}',
    ])
    if (stdout === null) return []
    const out: TmuxSessionInfo[] = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const [name, activity, created, pid, command, ...user] = line.split('\t')
      const info: TmuxSessionInfo = {
        name,
        activity: Number(activity) || 0,
        created: Number(created) || 0,
        command: command || '',
        user: user.join('\t'),
      }
      const pidNum = Number(pid)
      if (Number.isFinite(pidNum) && pidNum > 0) info.pid = pidNum
      out.push(info)
    }
    return out
  }

  return {
    hasSession(name) {
      return run(['has-session', '-t', `=${name}`]) !== null
    },
    killSession(name) {
      run(['kill-session', '-t', `=${name}`])
    },
    listSessions() {
      if (memo && Date.now() - memo.at < TMUX_MEMO_MS) return memo.sessions
      const sessions = listFresh()
      memo = { at: Date.now(), sessions }
      return sessions
    },
    refresh() {
      memo = undefined
    },
    setOption(name, option, value) {
      run(['set-option', '-t', `=${name}:`, option, value]) // set-option takes a target-pane: `=name:` is the exact-match SESSION form (`=name` alone → "no such session")
      memo = undefined
    },
  }
}
