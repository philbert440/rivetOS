// PTY lifecycle manager: spawn roster commands, cap concurrency, ring-buffer
// scrollback, reap detached/exited PTYs, audit everything.
//
// Mux layer (T1): when `term.mux` resolves to 'tmux' (default when a tmux
// binary is on PATH), the PTY spawned here is a tmux CLIENT on a per-den
// `-L rivet-<hash>` socket (`tmux new-session … -- <argv>` at create,
// `tmux attach-session -t =<name>` when the session already exists) and the
// harness lives in the tmux server — it survives den restarts, browser
// detaches and the reapers, and a user can attach from their own terminal
// (`tmux -L <socket> attach -t <session>`). Under tmux the detached/idle
// reapers DETACH den's client
// (SIGHUP, audit `detach`) instead of killing the harness, kill() kills the
// tmux session, and list() merges in client-less tmux sessions as
// `persisted:true` rows. `mux:'none'` is byte-identical to the pre-T1
// behavior. See term/tmux.ts for the control seam and name encoding.
//
// Security posture (this is a shell as the service user behind a web page —
// every rule here is deliberate):
//   - only roster KEYS come in over HTTP; argv/cwd/env are operator-owned
//   - argv is spawned directly, never through a shell (tmux CREATE wraps the
//     harness in `/bin/sh -c` only to source a 0600 env file — credentials
//     never appear on the tmux client argv / `ps`)
//   - RIVET_DEN_SESSION / RIVET_DEN_TOKEN are OMITTED when empty — the hook
//     adapter treats an empty string as a real session id (S2 review)
//   - every spawn/kill/exit is appended to ${stateDir}/term-audit.log
//
// Attachment (attach(id, cb, onExit?)) feeds live output + the exit
// notification to a subscriber (the WS /term channel in term/ws.ts) and holds
// off BOTH reapers while at least one subscriber is attached: the detached-TTL
// (by definition) and the idle-TTL — a harness someone is looking at is never
// SIGHUP'd out from under them for being quiet. The idle clock restarts on the
// last detach.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { DenConfig } from '../config.js'
import type { PtyProc, PtySpawn } from './pty.js'
import type { TermRoster } from './roster.js'
import {
  createRealTmuxCtl,
  decodeTmuxName,
  encodeTmuxName,
  findOnPath,
  TmuxUnavailableError,
  tmuxSocketName,
  tmuxSupported,
  tmuxConfContent,
  type TmuxCtl,
  type TmuxSessionInfo,
} from './tmux.js'

export class TermSpawnError extends Error {
  constructor(
    public readonly code: 'unknown-command' | 'cap' | 'user-mismatch' | 'tmux-unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'TermSpawnError'
  }
}

export interface TermManagerDeps {
  spawn: PtySpawn
  /** Current roster (lazily re-read by the provider). */
  roster: () => TermRoster
  /** Feed a synthetic protocol event into the den (session.end on PTY exit). */
  ingest: (ev: Record<string, unknown>) => void
  /** Is this den session's room live (exists and hasn't seen session.end)?
   *  The synthetic end fires only for live rooms — a harness that never
   *  emitted anything must not gain a phantom ended room, and one that ended
   *  cleanly must not end twice. Default: fire. */
  roomOpen?: (denSession: string) => boolean
  /** Does this harness already have an on-disk session with this id? Decides
   *  --resume vs --session-id on re-spawn (#318 review). Default: never. */
  sessionExists?: (command: string, id: string) => boolean
  /** tmux control seam (T1): injected by tests so unit tests never spawn a
   *  real tmux. Omitted = the execFileSync implementation on a per-den
   *  `-L rivet-<hash>` socket (when mux resolves to tmux). Its presence also
   *  counts as "tmux is available" for mux detection. */
  tmuxCtl?: TmuxCtl
  /** Write a 0600 env file used by the tmux CREATE harness wrapper.
   *  Default: writeFileSync(path, body, { mode: 0o600 }). Tests inject a
   *  capture so they can assert contents without reading the real fs. */
  writeEnvFile?: (path: string, body: string) => void
  log: (msg: string) => void
  now?: () => number
}

export interface PtyInfo {
  id: string
  denSession: string
  command: string
  /** Child pid. Absent on client-less persisted rows when tmux didn't
   *  report a pane pid — never a fake 0. */
  pid?: number
  attached: number
  createdAt: number
  /** Last geometry reported by a live client. Absent on client-less
   *  persisted rows — unknown, not 0. */
  cols?: number
  rows?: number
  state: 'running' | 'exited'
  exitCode?: number | null
  lastOutputTs: number
  /** Mux layer under this PTY. Present only when 'tmux' — under 'none' the
   *  wire shape stays byte-identical to before T1. */
  mux?: 'tmux'
  /** /term/list only: a tmux session with NO den client — it outlived a den
   *  restart/detach (reattach with POST /term {session}). Never set on live
   *  client rows (those report `reattached` instead). */
  persisted?: boolean
  /** This live client's tmux session already existed when den (re)attached
   *  (the harness survived a den restart/detach). */
  reattached?: boolean
  /** Den-stamped routed identity (#561); absent for the node owner. Lets
   *  list consumers show WHOSE terminal this is, not just where it ran. */
  routedUser?: string
}

type DataSubscriber = (data: string | Buffer) => void
type ExitSubscriber = (exitCode: number | null) => void

interface PtyRecord {
  id: string
  denSession: string
  command: string
  room: boolean
  argv: string[]
  cwd: string
  remote: string
  pid: number
  proc: PtyProc
  scrollback: Buffer[]
  scrollbackSize: number
  attached: Set<DataSubscriber>
  exitWatchers: Set<ExitSubscriber>
  createdAt: number
  cols: number
  rows: number
  lastOutputTs: number
  /** Per-user routing: the RIVETOS_USER_ID this PTY was spawned with, or
   *  undefined for the node owner. Reuse across identities is refused. */
  routedUser?: string
  /** tmux session name (encoded) backing this PTY when mux is tmux; the den
   *  PTY is a tmux CLIENT of this session. Never decode this back into
   *  denSession on the spawn path — both are stored here. */
  tmuxName?: string
  /** The tmux session already existed at spawn time (attach-session): the
   *  harness is already running, so no --resume/--session-id flags were
   *  passed and the ready-gate starts open. Surfaced as `reattached`. */
  persisted?: boolean
  state: 'running' | 'exited'
  exitCode?: number | null
  detachTimer?: NodeJS.Timeout
  /** Fires when lastActivityTs is older than idleTtlMs (activity-based
   *  auto-close). Suspended while a viewer is attached; re-armed with a full
   *  window on the last detach. */
  idleTimer?: NodeJS.Timeout
  sigkillTimer?: NodeJS.Timeout
  reapTimer?: NodeJS.Timeout
  /** Ready-gate (seamless 5g): a chat inject that arrives before the harness
   *  TUI can accept stdin is dropped. We buffer injects until first output has
   *  settled, then flush — so the FIRST chat turn to a fresh harness lands. */
  ready: boolean
  injectBuffer: { text: string; submit: boolean }[]
  readyTimer?: NodeJS.Timeout
  /** Pending delayed inject writes (paste/CR). Tracked so kill/close cancels
   *  them — an untracked CR could otherwise fire into a shutting-down PTY. */
  injectTimers: NodeJS.Timeout[]
  /** Serialization watermark (ms, `now()` clock): the earliest a ready-path
   *  inject may start so back-to-back turns keep text→CR→text→CR ordering
   *  instead of interleaving pastes ahead of CRs (same guarantee as the
   *  buffered flush). */
  injectNextAtMs: number
  /** Max(lastOutputTs, last inject) — the LRU-eviction signal. Bumped on BOTH
   *  stdout AND chat inject so an actively-chatted (but unattached) harness
   *  isn't evicted between a send and its reply (#316 review). */
  lastActivityTs: number
}

export interface TermManager {
  /** Throws TermSpawnError ('unknown-command' → 404, 'cap' → 409,
   *  'user-mismatch' → 403). `routedUser` is the den-stamped identity — the
   *  reuse guard compares IT, never a value inferred from the env map. */
  spawn(
    rosterKey: string | undefined,
    cols: number,
    rows: number,
    remote: string,
    session?: string,
    resume?: string,
    envOverride?: Record<string, string>,
    routedUser?: string,
  ): PtyInfo
  list(): PtyInfo[]
  get(id: string): PtyInfo | undefined
  /** PTY id linked to a den session, while its record exists. */
  ptyForSession(denSession: string): string | undefined
  /** SIGHUP → SIGKILL(3s); exited records are reaped immediately. Under tmux
   *  the SESSION is killed (the harness), then the client. Also resolves
   *  `tmux-<name>` ids (persisted client-less rows from list()) and den
   *  session keys, so a detached/persisted session can always be stopped.
   *  false = unknown id. Throws TmuxUnavailableError when tmux itself is
   *  unreachable — DELETE fails closed instead of skipping the kill. */
  kill(id: string): boolean
  /** Subscribe to live output; holds off BOTH the detached-TTL and idle-TTL
   *  reapers while at least one subscriber is attached (the last detach
   *  restarts both windows). `onExit` (optional) fires once when the child
   *  exits, after the final output has fanned out. Returns a detach fn;
   *  null = unknown id. */
  attach(id: string, cb: DataSubscriber, onExit?: ExitSubscriber): (() => void) | null
  scrollback(id: string): Buffer | undefined
  write(id: string, data: string | Buffer): boolean
  /** Like write, but for chat injects: buffered until the harness TUI is
   *  ready (first output settled) so the first turn isn't dropped (5g). When
   *  `submit`, the text and its CR are written as two separate PTY writes
   *  (bracketed paste + delayed CR) so the harness actually sends the turn.
   *  `interrupt` first sends Esc to cancel the harness's in-flight turn, then
   *  pastes after a settle — RivetHub's "inject now" on a queued message. */
  inject(id: string, text: string, submit: boolean, interrupt?: boolean): boolean
  /** Resize the child and record the new dimensions (hello frames report them). */
  resize(id: string, cols: number, rows: number): boolean
  /** Flow control for saturated viewers — no-op on backends without pause. */
  pause(id: string): boolean
  resume(id: string): boolean
  /** Count of running PTYs (what the cap is enforced against). */
  active(): number
  /** Clear all timers and SIGHUP running PTYs (server shutdown / tests). */
  close(): void
}

const SIGKILL_DELAY_MS = 3000

/** Detach path backstop: a tmux client that ignores SIGHUP is SIGKILLed
 *  after ~1s (the SESSION in the tmux server is never touched by this). */
const DETACH_SIGKILL_MS = 1000

/** Sweep interval for detached-harness exit notification when session GC is
 *  off (gcMs 0): nothing is killed at that cadence, but a harness that dies
 *  while detached still ends its room within a minute. */
const END_SWEEP_MS = 60_000

/** Max chat injects buffered before a fresh harness is ready (#316 review) —
 *  a real turn is a handful; well beyond that is a client spamming. */
const INJECT_BUFFER_MAX = 32

/** Bracketed-paste markers (DEC 2004). A chat turn is written between them so
 *  the harness TUI treats multi-line text as one literal block, then the
 *  submit CR is written separately — a CR fused onto the same write is
 *  swallowed by the TUI's paste heuristic as a newline (does not submit). */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const SUBMIT_CR = '\r'
const DEFAULT_INJECT_SUBMIT_DELAY_MS = 80

/** Interrupt-inject: a lone Esc cancels the harness's in-flight turn
 *  (Claude/grok TUIs), then the paste waits out the TUI's cancel/teardown
 *  redraw — pasting into that frame gets swallowed. An idle harness treats
 *  the stray Esc as a no-op, so racing a turn that just finished is safe. */
const INTERRUPT_ESC = '\x1b'
const INTERRUPT_SETTLE_MS = 400

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * How each harness pins/resumes a session id so the join key, its on-disk
 * store filename, and the drawer id are ALL the same value. Keyed on the
 * roster command. A new conversation spawns with `sessionFlag <id>` (forcing
 * the harness's native id = our join key); reopening a harness session spawns
 * with `resumeFlag <id>`. Ids must be valid UUIDs (Claude requires it for
 * --session-id), so RivetHub generates UUID conversation ids.
 */
const HARNESS_FLAGS: Partial<Record<string, { sessionFlag?: string; resumeFlag: string }>> = {
  claude: { sessionFlag: '--session-id', resumeFlag: '--resume' },
  grok: { sessionFlag: '--session-id', resumeFlag: '--resume' },
  // Hermes can --resume an existing session but has NO flag to pin a NEW
  // session's id — so no sessionFlag: a fresh hermes chat gets its own id
  // (can't equal the join key), reopening resumes cleanly.
  hermes: { resumeFlag: '--resume' },
  // Kimi is in the same position, with a differently-spelled resume flag:
  // `-S, --session [id]` resumes an EXISTING session (an unknown id fails with
  // `Session "…" not found`) and there is no --session-id to pin a new one.
  kimi: { resumeFlag: '--session' },
  // dsh (DeepSeek Harness) also mints its own id (`session-<uuid>` under
  // ~/.dsh/sessions/). `--resume` is an APP flag after `--profile tui`, not a
  // launcher pin — there is no --session-id. Fresh spawn: `dsh --profile tui`;
  // reopen: `dsh --profile tui --resume <native-id>`.
  dsh: { resumeFlag: '--resume' },
}

/** Set an env var only when the value is non-empty. NEVER pass '' through:
 *  the hook adapter treats an empty RIVET_DEN_SESSION as a real session id. */
const setNonEmpty = (env: Record<string, string>, key: string, value: string): void => {
  if (value !== '') env[key] = value
}

/** Non-secret keys that MAY ride tmux `-e` (visible on argv / `ps`). */
const TMUX_E_ALLOW = new Set([
  'RIVET_DEN_SESSION',
  'RIVETOS_SESSION_KEY',
  'RIVET_DEN_NAME',
  'RIVET_DEN_URL',
  'COLORTERM',
])

/** Named credential-class keys — never on `-e`, always the env file. */
const CREDENTIAL_NAMED = new Set([
  'RIVET_DEN_TOKEN',
  'RIVETOS_PG_URL',
  'RIVETOS_ENV_FILE',
  'RIVETOS_USER_ID',
])

const CREDENTIAL_RE = /(TOKEN|SECRET|PASSWORD|KEY|_URL)$/

/** Credential-class: named keys, or TOKEN/SECRET/PASSWORD/KEY/_URL suffix,
 *  except the explicit `-e` allow-list (RIVETOS_SESSION_KEY, RIVET_DEN_URL). */
const isCredentialKey = (k: string): boolean => {
  if (TMUX_E_ALLOW.has(k)) return false
  return CREDENTIAL_NAMED.has(k) || CREDENTIAL_RE.test(k)
}

/** Sourced by the CREATE harness wrapper; `$0` is the env file. */
const ENV_WRAP_SCRIPT = 'set -a; . "$0"; set +a; rm -f "$0"; exec "$@"'

/** Env files left behind when a tmux client dies before `exec`; swept at construct. */
const ENV_STALE_MS = 10 * 60 * 1000

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export function createTermManager(config: DenConfig, deps: TermManagerDeps): TermManager {
  const now = deps.now ?? Date.now
  const records = new Map<string, PtyRecord>()
  const bySession = new Map<string, string>()
  const auditFile = join(config.stateDir, 'term-audit.log')
  mkdirSync(config.stateDir, { recursive: true })
  // Leftovers from a tmux client that died before the wrapper `exec`/`rm`.
  try {
    const staleDir = resolve(join(config.stateDir, 'den', 'env'))
    for (const name of readdirSync(staleDir)) {
      if (!name.endsWith('.env')) continue
      const p = join(staleDir, name)
      try {
        const st = statSync(p)
        if (st.isFile() && now() - st.mtimeMs > ENV_STALE_MS) unlinkSync(p)
      } catch {
        // best-effort
      }
    }
  } catch {
    // env dir absent
  }
  const writeEnvFile =
    deps.writeEnvFile ??
    ((path: string, body: string): void => {
      writeFileSync(path, body, { mode: 0o600 })
    })

  // tmux mux resolution (T1) — once, at construction. An explicit
  // `term.mux: 'none'` opts out; an explicit 'tmux' with a missing/too-old
  // binary fails every spawn with tmux-unavailable (#19); unset = auto, used
  // when available (injected ctl, or a ≥3.2 binary found on PATH — `-e`
  // session env needs 3.2), with exactly one fallback log line when it isn't.
  let tmux: TmuxCtl | undefined
  let tmuxConfPath = ''
  let tmuxSocket = ''
  let tmuxUnavailableReason = ''
  const muxWanted = config.term.mux !== 'none'
  const muxExplicit = config.term.mux === 'tmux'
  if (muxWanted) {
    tmuxSocket = tmuxSocketName(config.stateDir, config.port)
    try {
      const dir = join(config.stateDir, 'den')
      mkdirSync(dir, { recursive: true })
      tmuxConfPath = join(dir, 'tmux.conf')
      writeFileSync(tmuxConfPath, tmuxConfContent(config.term.tmuxUserConf ?? false))
      if (deps.tmuxCtl) {
        tmux = deps.tmuxCtl
      } else {
        const bin = findOnPath('tmux')
        if (!bin) tmuxUnavailableReason = 'tmux not found on PATH'
        else if (!tmuxSupported(bin))
          tmuxUnavailableReason = `tmux at ${bin} is older than 3.2 (the create form needs new-session -e)`
        else tmux = createRealTmuxCtl(bin, tmuxSocket, tmuxConfPath)
      }
    } catch (e) {
      tmuxUnavailableReason = `failed to write tmux.conf (${String(e)})`
    }
    if (!tmux) {
      if (muxExplicit)
        deps.log(
          `[den-server] terminal mux: term.mux is 'tmux' but ${tmuxUnavailableReason} — terminal spawns will fail (tmux-unavailable)`,
        )
      else
        deps.log(
          `[den-server] terminal mux: ${tmuxUnavailableReason} — falling back to direct PTY (sessions will not survive den restarts)`,
        )
    } else {
      deps.log(
        `[den-server] terminal mux: tmux on socket ${tmuxSocket} — sessions persist across detaches and den restarts; ` +
          `LRU eviction and the reapers detach den clients but no longer bound harnesses (only RIVETOS_DEN_TERM_SESSION_GC_MS does). ` +
          `Attach externally: tmux -L ${tmuxSocket} attach -t <session>`,
      )
    }
  }
  const mux: 'tmux' | 'none' = tmux ? 'tmux' : 'none'
  /** Auto mode only: one log line the first time a spawn hits a dead tmux
   *  mid-life and falls back to a direct spawn for that call. */
  let tmuxFallbackLogged = false
  /** Per-denSession serialization of the has-session→spawn decision (#1):
   *  two racing POST /term {session} must not both take the create branch.
   *  The spawn path is fully synchronous, so in-process the critical section
   *  is already atomic — this set is the explicit guard that keeps it that
   *  way (and fails loudly if the path ever grows an await). */
  const spawnInflight = new Set<string>()

  const submitDelayMs = config.term.injectSubmitDelayMs ?? DEFAULT_INJECT_SUBMIT_DELAY_MS

  const laterWrite = (r: PtyRecord, data: string, atMs: number): void => {
    const fire = (): void => {
      if (r.state === 'running') r.proc.write(data)
    }
    if (atMs <= 0) {
      fire()
      return
    }
    const t = setTimeout(() => {
      const i = r.injectTimers.indexOf(t)
      if (i >= 0) r.injectTimers.splice(i, 1)
      fire()
    }, atMs)
    t.unref()
    r.injectTimers.push(t)
  }

  /** Write a chat inject to a live PTY. `submit` sends the turn: the text goes
   *  in one bracketed-paste write, then the CR in a separate delayed write so
   *  the harness TUI registers it as an Enter keystroke and not a pasted
   *  newline. `submit:false` writes the text verbatim (partial input). `startMs`
   *  staggers a queued flush so multiple buffered turns keep text→CR→text→CR
   *  ordering instead of interleaving all pastes ahead of all CRs. */
  const submitWrite = (r: PtyRecord, text: string, submit: boolean, startMs = 0): void => {
    laterWrite(r, submit ? `${PASTE_START}${text}${PASTE_END}` : text, startMs)
    if (submit) laterWrite(r, SUBMIT_CR, startMs + submitDelayMs)
  }

  const auditLine = (line: Record<string, unknown>): void => {
    try {
      appendFileSync(auditFile, JSON.stringify(line) + '\n')
    } catch (e) {
      // an unwritable audit log must not take terminals down, but it must
      // never be silent either
      deps.log(`[den-server] term: FAILED to write audit log ${auditFile}: ${String(e)}`)
    }
  }

  const audit = (
    action: 'spawn' | 'kill' | 'exit' | 'detach',
    r: PtyRecord,
    extra: Record<string, unknown> = {},
  ): void => {
    auditLine({
      ts: now(),
      action,
      id: r.id,
      denSession: r.denSession,
      command: r.command,
      argv: r.argv,
      cwd: r.cwd,
      pid: r.pid,
      remote: r.remote,
      // `remote` proves the machine; only the den-stamped identity proves the
      // user — without it the audit trail can't answer "whose session was
      // this?" on a multi-user node.
      ...(r.routedUser !== undefined ? { routedUser: r.routedUser } : {}),
      ...extra,
    })
  }

  const clearTimers = (r: PtyRecord): void => {
    for (const key of [
      'detachTimer',
      'idleTimer',
      'sigkillTimer',
      'reapTimer',
      'readyTimer',
    ] as const) {
      const t = r[key]
      if (t) clearTimeout(t)
      r[key] = undefined
    }
    // Cancel pending inject writes too — a delayed CR must not fire into a
    // killed/closing PTY (close() SIGHUPs but leaves state 'running').
    for (const t of r.injectTimers) clearTimeout(t)
    r.injectTimers = []
  }

  const reap = (r: PtyRecord): void => {
    clearTimers(r)
    records.delete(r.id)
    // Only clear the session alias if it STILL points at this pty: a
    // spawn-or-get after this pty exited (but before its linger reap) may
    // have replaced the mapping with a live pty — reaping must not orphan it
    // (#311 review).
    if (bySession.get(r.denSession) === r.id) bySession.delete(r.denSession)
  }

  const escalate = (r: PtyRecord): void => {
    if (r.state !== 'running') return
    r.proc.kill('SIGHUP')
    r.sigkillTimer = setTimeout(() => {
      r.sigkillTimer = undefined
      if (r.state === 'running') r.proc.kill('SIGKILL')
    }, SIGKILL_DELAY_MS)
    r.sigkillTimer.unref()
  }

  /** Under tmux the reapers DETACH den's client instead of killing the
   *  harness: SIGHUP ends the tmux client process; the session (and the
   *  harness inside it) lives on in the tmux server and is reattached by
   *  the next POST /term for its den session. The SIGKILL backstop (~1s)
   *  only ever hits a STUCK client process — never the session. */
  const detachClient = (r: PtyRecord, reason: string): void => {
    if (r.state !== 'running') return
    audit('detach', r, { reason })
    r.proc.kill('SIGHUP')
    r.sigkillTimer = setTimeout(() => {
      r.sigkillTimer = undefined
      if (r.state === 'running') r.proc.kill('SIGKILL')
    }, DETACH_SIGKILL_MS)
    r.sigkillTimer.unref()
  }

  // ── tmux session tracking, end-notification and GC ─────────────────────
  //
  // A tmux session outlives its den PtyRecord by design, so den tracks what
  // it knows about each session separately: whether a client is attached,
  // when the last one detached (den's OWN clock — tmux's session_activity
  // marks a quiet harness at a prompt as idle and is never a GC signal),
  // and whether the room's synthetic session.end already fired.
  interface KnownTmux {
    denSession: string
    command: string
    room: boolean
    routedUser?: string
    /** now() when den's last client exited; undefined while a client runs. */
    lastDetachTs?: number
    /** First time this process saw the session (GC grace after a restart). */
    firstSeenTs: number
    endSent: boolean
  }
  const knownTmux = new Map<string, KnownTmux>()

  /** Fire the synthetic session.end for a detached tmux-backed session whose
   *  harness is gone — exactly once, and only for a live room (same rule as
   *  the direct-spawn exit path). */
  const maybeEndSession = (name: string): void => {
    const k = knownTmux.get(name)
    if (!k || k.endSent) return
    k.endSent = true
    if (!k.room || !(deps.roomOpen?.(k.denSession) ?? true)) return
    deps.ingest({
      v: 1,
      session: k.denSession,
      type: 'session.end',
      ts: now(),
      harness: 'rivetos',
    })
  }

  // Session sweep (T1): tmux sessions survive restarts/detaches by design.
  // Every tick (a) ends rooms whose harness died while detached — no den
  // client means no onExit to notice — and (b) when sessionGcMs > 0, kills
  // sessions idle past that window. Eligibility requires den-tagged
  // (@rivet_command) sessions, no running den client, and a den-tracked
  // detach older than gcMs; ctl errors are caught so a wedged tmux never
  // stalls the loop. With gcMs 0 only (a) runs — nothing is ever killed.
  const gcMs = config.term.sessionGcMs ?? 0
  let sweepTimer: NodeJS.Timeout | undefined
  if (tmux) {
    const ctl = tmux
    sweepTimer = setInterval(
      () => {
        let sessions: TmuxSessionInfo[]
        try {
          sessions = ctl.listSessions()
        } catch (e) {
          deps.log(`[den-server] term: session sweep skipped — tmux unavailable (${String(e)})`)
          return
        }
        const liveNames = new Set(sessions.map((s) => s.name))
        // (a) harness exit while detached: known session now GONE with no
        // den client → close the room once.
        for (const [name, k] of knownTmux) {
          if (k.lastDetachTs !== undefined && !liveNames.has(name)) maybeEndSession(name)
        }
        // sessions den didn't create in this process (restart survivors):
        // track first sighting so GC eligibility runs from then, never from
        // before den was even up.
        for (const s of sessions) {
          if (!knownTmux.has(s.name)) {
            knownTmux.set(s.name, {
              denSession: decodeTmuxName(s.name),
              command: s.command,
              room: false, // room state is in-memory — after a restart there is none
              routedUser: s.user && s.user !== 'owner' ? s.user : undefined,
              firstSeenTs: now(),
              endSent: false,
            })
          }
        }
        // prune dead-and-notified entries so the map stays bounded
        for (const [name, k] of knownTmux) {
          if (k.endSent && !liveNames.has(name)) knownTmux.delete(name)
        }
        // (b) GC — opt-in via sessionGcMs; 0 = sessions live until killed
        if (gcMs <= 0) return
        const cutoff = now() - gcMs
        for (const s of sessions) {
          // never kill a session that isn't den's (no @rivet_command tag) —
          // a name alone is never proof of ownership
          if (!s.command) continue
          const hasDenClient = [...records.values()].some(
            (r) => r.tmuxName === s.name && r.state === 'running',
          )
          if (hasDenClient) continue
          const k = knownTmux.get(s.name)
          const since = k?.lastDetachTs ?? k?.firstSeenTs ?? now()
          if (since > cutoff) continue
          try {
            ctl.killSession(s.name)
            auditLine({
              ts: now(),
              action: 'kill',
              id: `tmux-${s.name}`,
              denSession: decodeTmuxName(s.name),
              command: s.command,
              reason: 'session-gc',
              ...(k?.routedUser !== undefined ? { routedUser: k.routedUser } : {}),
            })
            deps.log(
              `[den-server] term: session-gc killed tmux session ${s.name} (detached > ${gcMs}ms, no den client)`,
            )
            maybeEndSession(s.name)
          } catch (e) {
            deps.log(`[den-server] term: session-gc failed to kill ${s.name}: ${String(e)}`)
          }
        }
      },
      gcMs > 0 ? Math.min(gcMs, 3_600_000) : END_SWEEP_MS,
    )
    sweepTimer.unref()
  }

  const armDetachedTtl = (r: PtyRecord): void => {
    if (r.state !== 'running' || r.attached.size > 0 || r.detachTimer) return
    r.detachTimer = setTimeout(() => {
      r.detachTimer = undefined
      if (r.attached.size === 0) {
        // tmux-backed pty: detach den's client, the session survives (audit
        // `detach`). A direct pty (mux none, or auto-mode fallback) dies.
        if (r.tmuxName) detachClient(r, 'detached-ttl')
        else {
          audit('kill', r, { reason: 'detached-ttl' })
          escalate(r)
        }
      }
    }, config.term.detachedTtlMs)
    r.detachTimer.unref()
  }

  /** Activity-based auto-close: re-arm from `from` (default lastActivityTs)
   *  every time activity lands (stdout, inject, write). Attached viewers
   *  suspend it; the last detach re-arms from now() — NOT lastActivityTs — so
   *  closing a tab on a long-quiet harness starts a fresh window instead of
   *  killing on the spot (the detached-TTL governs that case). 0 = off. */
  const armIdleTtl = (r: PtyRecord, from: number = r.lastActivityTs): void => {
    if (r.idleTimer) {
      clearTimeout(r.idleTimer)
      r.idleTimer = undefined
    }
    const ttl = config.term.idleTtlMs
    if (ttl <= 0 || r.state !== 'running') return
    const remaining = from + ttl - now()
    r.idleTimer = setTimeout(
      () => {
        r.idleTimer = undefined
        if (r.state !== 'running') return
        // Re-check against wall clock: activity may have advanced lastActivityTs
        // without re-arming (defensive — all activity paths re-arm today).
        if (now() - r.lastActivityTs < ttl) {
          armIdleTtl(r)
          return
        }
        // Attached viewer → suspend (no timer) until the last detach re-arms.
        if (r.attached.size > 0) return
        // tmux-backed pty: detach den's client, the session survives (audit
        // `detach`). A direct pty (mux none, or auto-mode fallback) dies.
        if (r.tmuxName) detachClient(r, 'idle-ttl')
        else {
          audit('kill', r, { reason: 'idle-ttl' })
          escalate(r)
        }
      },
      Math.max(0, remaining),
    )
    r.idleTimer.unref()
  }

  /** Bump lastActivityTs and re-arm the idle reaper. Shared by onData / inject / write. */
  const touchActivity = (r: PtyRecord): void => {
    r.lastActivityTs = now()
    armIdleTtl(r)
  }

  const appendScrollback = (r: PtyRecord, data: string | Buffer): void => {
    const cap = config.term.scrollbackBytes
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (chunk.length >= cap) {
      r.scrollback = [chunk.subarray(chunk.length - cap)]
      r.scrollbackSize = cap
      return
    }
    r.scrollback.push(chunk)
    r.scrollbackSize += chunk.length
    while (r.scrollbackSize > cap) {
      const excess = r.scrollbackSize - cap
      const head = r.scrollback[0]
      if (head.length <= excess) {
        r.scrollback.shift()
        r.scrollbackSize -= head.length
      } else {
        r.scrollback[0] = head.subarray(excess)
        r.scrollbackSize -= excess
      }
    }
  }

  const info = (r: PtyRecord): PtyInfo => {
    const out: PtyInfo = {
      id: r.id,
      denSession: r.denSession,
      command: r.command,
      pid: r.pid,
      attached: r.attached.size,
      createdAt: r.createdAt,
      cols: r.cols,
      rows: r.rows,
      state: r.state,
      lastOutputTs: r.lastOutputTs,
    }
    if (r.state === 'exited') out.exitCode = r.exitCode
    // Only stamped when tmux actually backs THIS pty — under 'none' (or an
    // auto-mode direct fallback) the descriptor stays byte-identical to
    // before T1.
    if (r.tmuxName) out.mux = 'tmux'
    if (r.persisted) out.reattached = true
    if (r.routedUser !== undefined) out.routedUser = r.routedUser
    return out
  }

  /** The /term/list row for a den-tagged tmux session with NO den client:
   *  persisted, running, attached:0. pid/cols/rows are omitted when unknown
   *  (never fake 0s — the row exists so a client can reattach, not to report
   *  stale geometry). */
  const persistedRow = (s: TmuxSessionInfo): PtyInfo => ({
    id: `tmux-${s.name}`,
    denSession: decodeTmuxName(s.name),
    command: s.command,
    attached: 0,
    createdAt: s.created * 1000,
    state: 'running',
    lastOutputTs: s.activity * 1000,
    mux: 'tmux',
    persisted: true,
    ...(s.pid !== undefined ? { pid: s.pid } : {}),
    ...(s.user && s.user !== 'owner' ? { routedUser: s.user } : {}),
  })

  /** Same id forms as kill(): pty-* record, bySession alias, tmux-<name>,
   *  and a bare den-session key (encoded). Live records win. */
  type PersistedInfo = TmuxSessionInfo
  const isLiveRecord = (hit: PtyRecord | PersistedInfo): hit is PtyRecord => 'proc' in hit
  const resolveId = (id: string): PtyRecord | PersistedInfo | undefined => {
    const aliased = bySession.get(id)
    const r = records.get(id) ?? (aliased ? records.get(aliased) : undefined)
    if (r) return r
    if (!tmux) return undefined
    let name: string | undefined
    if (id.startsWith('tmux-')) name = id.slice('tmux-'.length)
    else if (/^[a-zA-Z0-9:_.-]{1,120}$/.test(id) && !id.startsWith('-')) {
      try {
        name = encodeTmuxName(id)
      } catch {
        return undefined
      }
    }
    if (!name) return undefined
    const s = tmux.listSessions().find((x) => x.name === name)
    if (s && s.command) return s
    return undefined
  }

  const onExit = (r: PtyRecord, exitCode: number | null): void => {
    if (r.state === 'exited') return
    r.state = 'exited'
    r.exitCode = exitCode
    clearTimers(r)
    audit('exit', r, { exitCode })
    if (tmux && r.tmuxName) {
      // Under tmux a detaching CLIENT exits while the harness lives on in
      // the tmux server — that is not a harness exit. Mark the detach on
      // den's own clock (GC eligibility + sweep), drop the session alias
      // NOW so the next POST /term takes the attach path (never reuses a
      // dead client), and reap immediately: there is nothing to linger for
      // — the scrollback replay belongs to tmux, not den's ring.
      const known = knownTmux.get(r.tmuxName)
      if (known) known.lastDetachTs = now()
      if (bySession.get(r.denSession) === r.id) bySession.delete(r.denSession)
      // If the session is ALREADY gone (kill path, or a harness that died
      // with its client) end the room now; if it still looks alive the
      // sweep re-checks — a session mid-teardown can read as alive here,
      // and tmux being unreachable must read as "unknown", never as "end".
      let alive: boolean
      try {
        alive = tmux.hasSession(r.tmuxName)
      } catch {
        alive = true
      }
      if (!alive) maybeEndSession(r.tmuxName)
      // notify after the final data fan-out (see below) — then reap now
      for (const w of [...r.exitWatchers]) w(exitCode)
      reap(r)
      return
    }
    // a den-aware harness normally emits its own session.end; if it died
    // without one (crash, SIGKILL), close the room so it doesn't look alive
    // forever. Roomless (room:false) PTYs never get synthetic events.
    if (r.room && (deps.roomOpen?.(r.denSession) ?? true)) {
      deps.ingest({
        v: 1,
        session: r.denSession,
        type: 'session.end',
        ts: now(),
        harness: 'rivetos',
      })
    }
    // notify after the final data fan-out (data events precede exit) so
    // attached WS clients see output frames, then the exit frame — copy the
    // set: a watcher's reaction is usually to detach
    for (const w of [...r.exitWatchers]) w(exitCode)
    r.reapTimer = setTimeout(() => {
      r.reapTimer = undefined
      reap(r)
    }, config.term.exitLingerMs)
    r.reapTimer.unref()
  }

  return {
    spawn(rosterKey, cols, rows, remote, session, resume, envOverride, routedUser): PtyInfo {
      // Spawn-or-get: a conversation's PTY is a singleton keyed by `session`.
      // Re-entering Terminal (or chat inject) for a live conversation reuses
      // the same harness rather than spawning a second (seamless modes).
      if (session) {
        // `task:` is the task engine's reserved conversation namespace
        // (ros_conversations.session_key) — a seamless chat session must not
        // collide with it (#311 review). A leading '-' is rejected too: it
        // encodes into a tmux name tmux's option parser would eat (#3).
        if (
          !/^[a-zA-Z0-9:_.-]{1,120}$/.test(session) ||
          session.startsWith('task:') ||
          session.startsWith('-')
        )
          throw new TermSpawnError('unknown-command', `invalid session id: ${session}`)
        const existingId = bySession.get(session)
        const existing = existingId ? records.get(existingId) : undefined
        if (existing && existing.state === 'running') {
          // Never hand one user's live harness to another identity: the
          // running child carries the first spawner's memory env.
          if (existing.routedUser !== routedUser)
            throw new TermSpawnError('user-mismatch', `session ${session} is owned by another user`)
          return info(existing)
        }
      }
      const roster = deps.roster()
      const key = rosterKey ?? roster.default
      const entry = roster.commands[key] as (typeof roster.commands)[string] | undefined
      if (!entry) throw new TermSpawnError('unknown-command', `unknown command: ${key}`)
      // Explicit tmux mode with no usable binary/server fails every spawn —
      // the operator asked for persistence; silently downgrading would lose
      // it without a trace (#19). Auto mode already logged its fallback.
      // Checked BEFORE the LRU eviction below — a spawn that throws must
      // never evict a healthy pty.
      if (muxExplicit && !tmux)
        throw new TermSpawnError(
          'tmux-unavailable',
          `term.mux is 'tmux' but ${tmuxUnavailableReason}`,
        )
      const running = [...records.values()].filter((r) => r.state === 'running')
      if (running.length >= config.term.maxPtys) {
        // LRU pool (seamless 5g): at the cap, evict the least-recently-ACTIVE
        // idle pty so a new conversation can spawn. The evicted conversation
        // goes cold — its transcript is durable in memory and a later open
        // respawns it (spawn-or-get). Never evict a pty that is:
        //   - attached (a Terminal view is watching), OR
        //   - still booting / holding buffered injects (a first turn is
        //     queued), OR
        //   - recently active — lastActivityTs is bumped on BOTH output AND
        //     chat inject, so a conversation you're actively chatting (whose
        //     harness is unattached — inject doesn't attach) isn't evicted
        //     mid-thread just because it's quiet between the send and the
        //     reply (#316 review — the eviction signal must include chat, not
        //     just stdout).
        // If every running pty is protected, the cap is real. Brief maxPtys+1
        // until the victim exits is acceptable for a soft cap.
        const victim = running
          .filter((r) => r.attached.size === 0 && r.ready && r.injectBuffer.length === 0)
          .sort((a, b) => a.lastActivityTs - b.lastActivityTs)
          .at(0)
        if (!victim)
          throw new TermSpawnError('cap', `pty limit reached (${config.term.maxPtys}); all active`)
        audit('kill', victim, { reason: 'lru-evict' })
        escalate(victim)
      }

      const id = `pty-${randomBytes(4).toString('hex')}`
      // The conversation join key IS the den session, so den (?session), the
      // capture hooks (RIVETOS_SESSION_KEY), and this PTY all share one id.
      const denSession = session ?? `den-${id}`
      const cwd = entry.cwd ?? roster.cwd

      // tmux reattach path (T1): if a tmux session for this den session
      // already exists on our socket, the harness is STILL RUNNING (it
      // survived a den restart / browser detach / reaper). The spawn becomes
      // an attach: no --resume/--session-id flags reach the harness and the
      // record is marked reattached. Checked BEFORE the sessionExists/resume
      // logic below, which only applies to a genuinely fresh tmux session.
      // The decision takes a FRESH view (refresh) — never the 1s memo — and
      // runs under the per-session guard so two racing POSTs can't both take
      // the create branch. A ctl failure is "tmux unavailable", NEVER
      // "session absent, go create" (#1): explicit mode fails the spawn;
      // auto mode falls back to a direct PTY for this call (one log line).
      let tmuxName: string | undefined
      let persisted = false
      if (tmux) {
        if (spawnInflight.has(denSession))
          throw new TermSpawnError('cap', `spawn already in flight for session ${denSession}`)
        spawnInflight.add(denSession)
        try {
          tmuxName = encodeTmuxName(denSession)
          tmux.refresh?.()
          let existing: TmuxSessionInfo | undefined
          try {
            existing = tmux.listSessions().find((s) => s.name === tmuxName)
          } catch (e) {
            if (!(e instanceof TmuxUnavailableError)) throw e
            if (muxExplicit)
              throw new TermSpawnError('tmux-unavailable', `tmux unavailable: ${e.message}`)
            if (!tmuxFallbackLogged) {
              tmuxFallbackLogged = true
              deps.log(
                `[den-server] terminal mux: tmux became unavailable mid-life (${e.message}) — spawning this PTY direct; it will NOT survive den restarts`,
              )
            }
            tmuxName = undefined
          }
          if (existing) {
            // never attach a session that isn't den's: a name alone is not
            // proof of ownership — the @rivet_command tag is (#7)
            if (!existing.command)
              throw new TermSpawnError(
                'tmux-unavailable',
                `tmux session ${tmuxName} exists without den tags — refusing to attach a foreign session`,
              )
            // an untagged-by-this-user persisted session is the owner's live
            // pane with the owner's credentials — never join it (#7)
            const owner = existing.user || 'owner'
            if (owner !== (routedUser ?? 'owner'))
              throw new TermSpawnError(
                'user-mismatch',
                `tmux session for ${denSession} is owned by another user`,
              )
            persisted = true
          }
        } catch (e) {
          spawnInflight.delete(denSession)
          throw e
        }
      }
      const env: Record<string, string> = {}
      // Keys the manager SETS OR OVERRIDES for the harness — under tmux,
      // non-credential keys ride as `-e KEY=VAL` so an EXISTING tmux server
      // adopts the per-session values; credential-class keys go in the env
      // file. The outer PTY env still seeds a NEW server.
      const tmuxEnvKeys = new Set<string>()
      // Never clone per-user DB maps or admin URLs into a shell (#564).
      const ptyEnvDeny =
        /^(RIVETOS_USER_DBS|RIVETOS_TEAM_PG_ADMIN_URL|RIVETOS_DEN_DEVICES_PG_ADMIN_URL)$/
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !ptyEnvDeny.test(k)) env[k] = v
      }
      Object.assign(env, roster.env, entry.env ?? {})
      for (const k of Object.keys(roster.env ?? {})) if (!ptyEnvDeny.test(k)) tmuxEnvKeys.add(k)
      for (const k of Object.keys(entry.env ?? {})) if (!ptyEnvDeny.test(k)) tmuxEnvKeys.add(k)
      setNonEmpty(env, 'RIVET_DEN_SESSION', denSession)
      if (env.RIVET_DEN_SESSION) tmuxEnvKeys.add('RIVET_DEN_SESSION')
      // Capture hooks key the transcript on this — chat reads the same
      // conversation the terminal is running (seamless modes join key).
      if (session) setNonEmpty(env, 'RIVETOS_SESSION_KEY', session)
      if (env.RIVETOS_SESSION_KEY) tmuxEnvKeys.add('RIVETOS_SESSION_KEY')
      setNonEmpty(env, 'RIVET_DEN_TOKEN', config.token)
      if (env.RIVET_DEN_TOKEN) tmuxEnvKeys.add('RIVET_DEN_TOKEN')
      // Gateway TLS (#491): a TLS den answers https only — hand the spawned
      // harness's den hook the live scheme (the hook trusts the Rivet CA).
      // Predicate MUST match server.ts tlsReady (cert+key paths non-empty);
      // a divergence hands harnesses a single-scheme URL the den won't serve.
      const denScheme = config.tls.certPath.trim() && config.tls.keyPath.trim() ? 'https' : 'http'
      env.RIVET_DEN_URL = `${denScheme}://127.0.0.1:${config.port}`
      env.RIVET_DEN_NAME = `${hostname()}:${key}`
      // The outer PTY stays xterm-256color; inside the pane tmux presents
      // default-terminal (tmux-256color) itself. TERM deliberately does NOT
      // ride `-e`: on an already-running server it would override the conf's
      // tmux-256color INSIDE panes and break TUI terminfo (#11).
      env.TERM = 'xterm-256color'
      env.COLORTERM = 'truecolor'
      tmuxEnvKeys.add('RIVET_DEN_URL')
      tmuxEnvKeys.add('RIVET_DEN_NAME')
      tmuxEnvKeys.add('COLORTERM')

      // Harness session pinning/resume (seamless drawer): make the harness's
      // native session id equal our join key, so its on-disk store file and
      // the drawer id line up. Only for UUID ids (Claude requires it).
      // Skipped when persisted — the tmux session already has a RUNNING
      // harness; passing --resume would respawn a second one.
      const flags = HARNESS_FLAGS[key]
      let argv = entry.cmd
      if (flags && !persisted) {
        // Prefer --resume: an explicit resume request, or a session that
        // already exists in the harness's store (e.g. a re-spawn after LRU
        // eviction — store existence is the ground truth, not the caller's
        // hint, #318 review). --resume takes the id verbatim (hermes ids
        // aren't UUIDs).
        const resumeId =
          resume || (session && deps.sessionExists?.(key, session) ? session : undefined)
        if (resumeId) {
          argv = [...entry.cmd, flags.resumeFlag, resumeId]
        } else if (session && flags.sessionFlag && UUID_RE.test(session)) {
          // A genuinely-new conversation pins its id (claude/grok — needs a
          // UUID). Harnesses with no sessionFlag (hermes) can't pin: the fresh
          // session gets the harness's own id.
          argv = [...entry.cmd, flags.sessionFlag, session]
        }
      }

      // Per-user routing (device→user, server.ts): the override lands last so
      // a mapped device's memory env (RIVETOS_PG_URL / RIVETOS_ENV_FILE)
      // outranks the node owner's process env and roster env. The owner's
      // values for these keys are removed first — an envFile-only override
      // must not leave the owner's RIVETOS_PG_URL visible to capture, which
      // prefers the env var over the env file. Credential-class keys never
      // ride `-e` (argv/`ps`); they go in a 0600 env file the harness wrapper
      // sources. Deletions are `unset KEY` in that file AND a chained
      // `set-environment -t =<name> -u KEY` so an already-running tmux
      // server's global env (the first spawner's, possibly the node owner's
      // credentials) does not leak into this user's session (#6).
      const tmuxEnvDeleted: string[] = []
      if (envOverride) {
        delete env.RIVETOS_PG_URL
        delete env.RIVETOS_ENV_FILE
        delete env.RIVETOS_USER_ID
        if (!('RIVETOS_PG_URL' in envOverride)) tmuxEnvDeleted.push('RIVETOS_PG_URL')
        if (!('RIVETOS_ENV_FILE' in envOverride)) tmuxEnvDeleted.push('RIVETOS_ENV_FILE')
        if (!('RIVETOS_USER_ID' in envOverride)) tmuxEnvDeleted.push('RIVETOS_USER_ID')
        Object.assign(env, envOverride)
        for (const k of Object.keys(envOverride)) if (!ptyEnvDeny.test(k)) tmuxEnvKeys.add(k)
      }

      // tmux spawn form (T1): den's PTY runs a tmux CLIENT of the session
      // named by the den session key. Two distinct forms (#1):
      //   attach (session exists): `attach-session -t =<name>` — read-only:
      //     no -e (a reattach does NOT refresh a running harness's env), no
      //     -c/-x/-y (window-size latest applies the client's own PTY size),
      //     no harness argv, no option churn.
      //   create: `new-session -s <name>` (NEVER -A: a stale/raced existence
      //     check must fail the create loudly, not silently mint a second
      //     harness with no resume flags). `-e` carries only non-credential
      //     vars the manager set/overrode; credential-class keys ride a
      //     0600 env file sourced by `/bin/sh -c` around the harness so they
      //     never appear on argv. The PTY env below still carries the full
      //     computed env for a fresh server. The @rivet_command/@rivet_user
      //     tags (and set-environment -u for deletions) are CHAINED onto the
      //     same invocation (`;` tokens) so they land atomically with the
      //     create — a post-fork set-option races the client and can fail
      //     before the session exists (#8).
      let spawnArgv = argv
      // CREATE only: absolute env-file path so `. "$0"` does not depend on pane cwd.
      let envFile: string | undefined
      let envFileBody = ''
      let envDir: string | undefined
      if (tmux && tmuxName) {
        if (persisted) {
          spawnArgv = [
            'tmux',
            '-L',
            tmuxSocket,
            '-f',
            tmuxConfPath,
            'attach-session',
            '-t',
            `=${tmuxName}`,
          ]
        } else {
          const envPairs: string[] = []
          const envFileLines: string[] = []
          for (const k of tmuxEnvKeys) {
            if (!Object.hasOwn(env, k)) continue
            if (isCredentialKey(k)) {
              envFileLines.push(`${k}=${shellSingleQuote(env[k])}`)
            } else {
              envPairs.push('-e', `${k}=${env[k]}`)
            }
          }
          for (const k of tmuxEnvDeleted) envFileLines.push(`unset ${k}`)
          envDir = resolve(join(config.stateDir, 'den', 'env'))
          envFile = join(envDir, `${tmuxName}.env`)
          envFileBody = envFileLines.join('\n') + (envFileLines.length ? '\n' : '')
          const unsetChain: string[] = []
          for (const k of tmuxEnvDeleted) {
            unsetChain.push(';', 'set-environment', '-t', `=${tmuxName}`, '-u', k)
          }
          spawnArgv = [
            'tmux',
            '-L',
            tmuxSocket,
            '-f',
            tmuxConfPath,
            'new-session',
            '-s',
            tmuxName,
            '-c',
            cwd,
            '-x',
            String(cols),
            '-y',
            String(rows),
            ...envPairs,
            '--',
            '/bin/sh',
            '-c',
            ENV_WRAP_SCRIPT,
            envFile,
            ...argv,
            ';',
            'set-option',
            '-t',
            `=${tmuxName}`,
            '@rivet_command',
            key,
            ';',
            'set-option',
            '-t',
            `=${tmuxName}`,
            '@rivet_user',
            routedUser ?? 'owner',
            ...unsetChain,
          ]
        }
      }
      let proc: PtyProc
      // Env-file write + spawn share one try/finally so EACCES/ENOSPC cannot
      // leak spawnInflight (a leaked flag wedges the denSession with 'cap').
      try {
        if (envFile && envDir) {
          mkdirSync(envDir, { recursive: true, mode: 0o700 })
          try {
            chmodSync(envDir, 0o700)
          } catch {
            // umask / non-posix fs — mode on mkdir is best-effort
          }
          writeEnvFile(envFile, envFileBody)
        }
        proc = deps.spawn(spawnArgv, { cwd, env, cols, rows })
      } catch (e) {
        if (envFile) {
          try {
            unlinkSync(envFile)
          } catch {
            // best-effort: client failed before exec — don't leave credentials
          }
        }
        throw e
      } finally {
        spawnInflight.delete(denSession)
      }
      if (tmux && tmuxName) {
        // den's own picture of the session: end-notification and GC work off
        // this, never off tmux's activity clock.
        knownTmux.set(tmuxName, {
          denSession,
          command: key,
          room: entry.room,
          routedUser,
          firstSeenTs: now(),
          endSent: false,
        })
      }
      const r: PtyRecord = {
        id,
        denSession,
        command: key,
        room: entry.room,
        argv,
        cwd,
        remote,
        pid: proc.pid,
        proc,
        scrollback: [],
        scrollbackSize: 0,
        routedUser,
        tmuxName,
        persisted,
        attached: new Set(),
        exitWatchers: new Set(),
        createdAt: now(),
        cols,
        rows,
        lastOutputTs: now(),
        state: 'running',
        // An attach (session already existed) reattaches a RUNNING harness:
        // the first output is tmux's attach redraw, which would fire the
        // ready-gate settle too early — an attach is immediately ready.
        ready: persisted,
        injectBuffer: [],
        injectTimers: [],
        injectNextAtMs: 0,
        lastActivityTs: now(),
      }
      records.set(id, r)
      bySession.set(denSession, id)
      proc.onData((data) => {
        r.lastOutputTs = now()
        touchActivity(r)
        // Ready-gate: on the FIRST output, wait a short settle for the TUI to
        // finish its initial render, then flush any buffered chat injects.
        if (!r.ready && !r.readyTimer) {
          r.readyTimer = setTimeout(() => {
            r.readyTimer = undefined
            // the proc may have died during the settle window (#316 review)
            if (r.state !== 'running') {
              r.injectBuffer = []
              return
            }
            r.ready = true
            // Stagger so a multi-turn buffer flushes text→CR→text→CR in order
            // (each turn's paste + its own CR before the next turn's paste).
            const pending = r.injectBuffer
            r.injectBuffer = []
            pending.forEach((d, i) => submitWrite(r, d.text, d.submit, i * submitDelayMs * 2))
            // Continue the chain: a ready-path inject arriving right after the
            // flush must queue behind the last staggered turn, not race it.
            r.injectNextAtMs = now() + pending.length * submitDelayMs * 2
          }, config.term.injectReadyMs)
          r.readyTimer.unref()
        }
        appendScrollback(r, data)
        for (const cb of r.attached) cb(data)
      })
      proc.onExit((exitCode) => onExit(r, exitCode))
      audit('spawn', r, tmux && tmuxName ? { mux, tmuxName, persisted } : {})
      armDetachedTtl(r)
      armIdleTtl(r)
      // room:true entries get their den room immediately: harness hooks only
      // fire on the first prompt, and the viewer can't offer a terminal to
      // type that prompt into until a session window exists. The harness's
      // own events land in the same room via RIVET_DEN_SESSION and take over.
      if (entry.room)
        deps.ingest({
          v: 1,
          session: denSession,
          type: 'session.start',
          title: entry.label,
          name: env.RIVET_DEN_NAME,
          harness: 'rivetos',
          ts: now(),
        })
      return info(r)
    },

    list: () => {
      const rows = [...records.values()].map(info)
      // Merge in tmux sessions on our socket that have NO den record (they
      // outlived a den restart / detach). Exactly ONE row per denSession: any
      // record (running or exited) claims its tmux name, so a detached
      // session never appears twice (#10). Only den-tagged sessions
      // (@rivet_command) are listed — a bare name is never proof of
      // ownership (#7). A tmux failure degrades the answer to den's own
      // records instead of failing the poll (#9).
      if (tmux) {
        const claimed = new Set<string>()
        for (const r of records.values()) if (r.tmuxName) claimed.add(r.tmuxName)
        let sessions: TmuxSessionInfo[] = []
        try {
          sessions = tmux.listSessions()
        } catch (e) {
          deps.log(
            `[den-server] term: listSessions failed — listing den records only (${String(e)})`,
          )
        }
        for (const s of sessions) {
          if (claimed.has(s.name)) continue
          if (!s.command) continue
          rows.push(persistedRow(s))
        }
      }
      return rows
    },
    get: (id) => {
      // Same id forms as kill() so DELETE's denyIfForbidden cannot be skipped
      // by passing a den-session key (or the bySession alias).
      try {
        const hit = resolveId(id)
        if (!hit) return undefined
        return isLiveRecord(hit) ? info(hit) : persistedRow(hit)
      } catch {
        // tmux unreachable — DELETE fails closed on get() === undefined
        return undefined
      }
    },
    ptyForSession: (denSession) => bySession.get(denSession),

    kill(id): boolean {
      const hit = resolveId(id)
      if (!hit) return false
      if (!isLiveRecord(hit)) {
        // No den record: a persisted row (`tmux-<name>`) or a den session
        // key — the session (and its harness) is killable even with no den
        // client (#4). Only den-tagged sessions are killable this way; ctl
        // failures propagate so DELETE fails closed instead of silently
        // skipping (#9).
        if (!tmux) return false
        const s = hit
        const name = s.name
        tmux.killSession(name)
        auditLine({
          ts: now(),
          action: 'kill',
          id: `tmux-${name}`,
          denSession: decodeTmuxName(name),
          command: s.command,
          reason: 'request',
          ...(s.user && s.user !== 'owner' ? { routedUser: s.user } : {}),
        })
        // a kill is a harness exit: end the room (guarded, fires once)
        maybeEndSession(name)
        // escalate any client that still believes it's attached (defensive —
        // a claimed session never reaches this branch)
        for (const rec of records.values())
          if (rec.tmuxName === name && rec.state === 'running') escalate(rec)
        return true
      }
      const r = hit
      if (r.state === 'exited') {
        reap(r)
        return true
      }
      // Unlink the den session NOW, not at exit: a respawn racing this kill
      // (model change) must get a NEW pty from spawn-or-get, never the dying
      // one — SIGHUP→SIGKILL can take seconds (grok review, PR #349).
      if (bySession.get(r.denSession) === r.id) bySession.delete(r.denSession)
      audit('kill', r, { reason: 'request' })
      // tmux: kill the SESSION (the harness), not just den's client — DELETE
      // /term semantics are unchanged from the caller's view. The SIGHUP →
      // SIGKILL escalation on the client PTY below is the backstop. Ordered
      // kill-session FIRST so the client's exit sees the session gone and the
      // synthetic session.end still fires as it does under mux:none.
      if (tmux && r.tmuxName) {
        try {
          tmux.killSession(r.tmuxName)
        } catch {
          // session may already be gone — the escalation below still applies
        }
      }
      escalate(r)
      return true
    },

    attach(id, cb, onExit) {
      const r = records.get(id)
      if (!r) return null
      r.attached.add(cb)
      if (onExit) r.exitWatchers.add(onExit)
      if (r.detachTimer) {
        clearTimeout(r.detachTimer)
        r.detachTimer = undefined
      }
      // Suspend the idle reaper on the 0→1 transition too (not only when it
      // next fires) so "attached ⇒ no idle timer" holds immediately and
      // symmetrically with the detached-TTL above. Activity while attached
      // may re-arm it; the fire-time attached check makes that harmless.
      if (r.idleTimer) {
        clearTimeout(r.idleTimer)
        r.idleTimer = undefined
      }
      let detached = false
      return () => {
        if (detached) return
        detached = true
        r.attached.delete(cb)
        if (onExit) r.exitWatchers.delete(onExit)
        if (r.attached.size === 0) {
          armDetachedTtl(r)
          // Last viewer gone: (re)start the idle window from now — whether
          // the reaper was suspended or a re-armed timer is still pending.
          armIdleTtl(r, now())
        }
      }
    },

    scrollback(id) {
      const r = records.get(id)
      return r ? Buffer.concat(r.scrollback) : undefined
    },

    write(id, data): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      // Keystrokes count as activity for idle-TTL (and LRU).
      touchActivity(r)
      r.proc.write(data)
      return true
    },

    inject(id, text, submit, interrupt = false): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      // Chat activity protects this pty from LRU eviction (#316 review): a
      // conversation being chatted is unattached (inject doesn't attach) but
      // must not be evicted between the send and the harness's reply. Also
      // re-arms idle-TTL so a live chat turn keeps the harness alive.
      touchActivity(r)
      // Ready-gate (5g): before the harness TUI is up, buffer instead of
      // writing into the void; the onData settle timer flushes it.
      if (r.ready) {
        // Serialize against any in-flight turn so paste/CR pairs never
        // interleave (paste₁, paste₂, CR₁, CR₂) when two injects land within
        // one submit delay — parallel API clients or a UI without a send lock.
        let startMs = Math.max(0, r.injectNextAtMs - now())
        if (interrupt) {
          // Esc respects the serialization watermark: landing between a prior
          // turn's paste and its CR would wipe that turn's input (the TUI
          // clears its composer on Esc) and the CR would submit nothing
          // (grok review, PR #338). After the chain: cancel, settle, paste.
          laterWrite(r, INTERRUPT_ESC, startMs)
          startMs += INTERRUPT_SETTLE_MS
        }
        submitWrite(r, text, submit, startMs)
        r.injectNextAtMs = now() + startMs + (submit ? submitDelayMs * 2 : submitDelayMs)
        return true
      }
      // Bounded buffer: a client can't grow memory by spamming inject before
      // the harness is ready (#316 review).
      if (r.injectBuffer.length >= INJECT_BUFFER_MAX) return false
      r.injectBuffer.push({ text, submit })
      return true
    },

    resize(id, cols, rows): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      r.proc.resize(cols, rows)
      r.cols = cols
      r.rows = rows
      return true
    },

    pause(id): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      r.proc.pause?.()
      return true
    },

    resume(id): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      r.proc.resume?.()
      return true
    },

    active: () => [...records.values()].filter((r) => r.state === 'running').length,

    close(): void {
      if (sweepTimer) clearInterval(sweepTimer)
      for (const r of records.values()) {
        clearTimers(r)
        if (r.state === 'running') r.proc.kill('SIGHUP')
      }
      records.clear()
      bySession.clear()
    },
  }
}
