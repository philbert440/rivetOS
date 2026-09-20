// herdr mux layer for den PTYs (`term.mux: herdr`). Default is still tmux.
//
// When `term.mux` resolves to 'herdr', the manager's PTY is a herdr TUI
// CLIENT (`herdr --session <name>`) of a per-den named session. The harness
// lives in the herdr server (headless `herdr --session <name> server`) and
// survives den restarts, browser detaches and the idle/detached reapers the
// same way a tmux session does. A user can attach the same session from their
// own terminal with `XDG_CONFIG_HOME=<short-runtime-home> herdr --session
// <short-name>`. herdr is the default mux since 2026-09-06: loadConfig turns an
// unset `term.mux` into `herdr` when the pinned binary is reachable (PATH or
// ~/.local/bin); `RIVETOS_DEN_TERM_MUX=tmux` opts out.
//
// Socket paths: Linux `sun_path` is 108 bytes (107 usable). herdr binds
// `<configHome>/herdr/sessions/<name>/herdr-client.sock`. Config home is a
// short runtime dir (`/run/user/<uid>/rivet-den-<hash8>` or `/tmp/…`) and
// the session name is `d<12-hex-of-sha256(denKey)>`. The full den key lives
// in `rivet.json` — never decode the hashed name. An up-front length check
// throws `HerdrUnavailableError('socket path too long …')` instead of a
// silent wait.
//
// Create is async (detached spawn + event-loop sock poll + socket RPC).
// Credentials travel on `workspace.create` JSON params, never ctl argv.
// Unknown `--kind` values get a plain pane (`pane.send_text`), not `agent
// start`. Liveness is a pid/`session.snapshot` round-trip, not sock-file
// presence.

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessStatusFrame } from '@rivetos/types'
import { findOnPath } from './tmux.js'

/** Pinned herdr release. `herdr --version` must report this exact x.y.z. */
export const HERDR_PINNED_VERSION = '0.8.2'

/** Default pane created by `workspace create` (spike, protocol 20). */
export const HERDR_DEFAULT_PANE = 'w1:p1'

/** Linux `sockaddr_un.sun_path` usable bytes (108 including NUL). */
export const HERDR_SUN_PATH_MAX = 107

/** herdr 0.8.2 `agent start --kind` closed enum (measured). */
export const HERDR_AGENT_KINDS = new Set([
  'pi',
  'claude',
  'codex',
  'gemini',
  'cursor',
  'devin',
  'agy',
  'cline',
  'omp',
  'mastracode',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'maki',
])

export class HerdrUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HerdrUnavailableError'
  }
}

/** Exit 2 / protocol errors that must NOT be reported as tmux-unavailable. */
export class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message)
    this.name = 'HerdrCommandError'
  }
}

export type ExistingHerdrDisposition = 'attach' | 'adopt' | 'foreign' | 'user-mismatch'

export interface HerdrSessionInfo {
  /** Short hashed session dir name (`d` + 12 hex). */
  name: string
  /** Full den session key, from `rivet.json`. */
  denKey?: string
  /** epoch seconds — display-only, never a liveness/idle signal. */
  activity: number
  /** epoch seconds. */
  created: number
  pid?: number
  /** Den-stamped roster command ('' when unset). */
  command: string
  /** Den-stamped routed identity, or 'owner'. */
  user: string
  /** First pane id, when known (`w1:p1`). */
  paneId?: string
}

/** The herdr command surface the manager uses. `create` is async (event-loop
 *  poll + socket RPC). The rest stay sync like TmuxCtl so list/kill/reattach
 *  do not grow a second copy of those branches. */
export interface HerdrCtl {
  hasSession(name: string): boolean
  killSession(name: string): void
  listSessions(): HerdrSessionInfo[]
  refresh?(): void
  setOption?(name: string, option: string, value: string): void
  windowSize?(name: string): { cols: number; rows: number } | undefined
  /** Headless server + workspace.create (socket, env in JSON) + agent.start
   *  or a plain pane.send_text. Returns a Promise from the real ctl. */
  create(opts: HerdrCreateOpts): void | Promise<void>
  /** TUI client argv for the den PTY. */
  attachArgv(name: string): string[]
  /** Scrollback via `agent read` / `pane read`. Empty string on failure. */
  capture?(name: string, lines: number): string
  /** Same, without blocking the event loop (execFile). Prefer this. */
  captureAsync?(name: string, lines: number): Promise<string>
  /** Cheap async liveness probe (`pane list` / `agent list`), scoped to
   *  one pane when `paneId` is passed. `undefined` means the probe is
   *  unavailable, failed, or the pane id is unknown/absent — callers fail
   *  closed rather than assuming alive. Never "any row in the session is live". */
  paneAgent?(
    name: string,
    paneId?: string,
  ): Promise<{ agent: string | null; status?: string } | undefined>
  /** One newline-JSON `events.subscribe` socket. Returns unsubscribe.
   *  `onClose` fires when the socket ends (hub reconnects). */
  subscribeEvents?(name: string, onEvent: (evt: unknown) => void, onClose?: () => void): () => void
}

export interface HerdrCreateOpts {
  name: string
  /** Full den session key — stored in rivet.json, never used as the dir name. */
  denKey?: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  /** herdr `--kind`. Undefined → plain pane, no agent start. */
  kind?: string
  command: string
  user: string
  cols?: number
  rows?: number
}

// ---------------------------------------------------------------------------
// Short names + short config home (B1)
// ---------------------------------------------------------------------------

export function herdrRuntimeHash(stateDir: string, port: number): string {
  return createHash('sha256').update(`${stateDir}:${port}`).digest('hex').slice(0, 8)
}

/** Deterministic 13-char session dir name. Full den key stays in rivet.json. */
export function herdrSessionName(denKey: string): string {
  return `d${createHash('sha256').update(denKey).digest('hex').slice(0, 12)}`
}

export const encodeHerdrName = herdrSessionName

/** Hashed names are not reversible — callers must read `denKey` from meta. */
export function decodeHerdrName(_name: string): string {
  throw new Error('herdr session names are hashed; read denKey from rivet.json')
}

export function isDenHerdrName(name: string): boolean {
  return /^d[0-9a-f]{12}$/.test(name)
}

export function classifyExistingHerdrSession(
  s: HerdrSessionInfo,
  routedUser?: string,
): ExistingHerdrDisposition {
  const want = routedUser ?? 'owner'
  if (s.command) {
    const have = s.user || 'owner'
    if (have !== want) return 'user-mismatch'
    return 'attach'
  }
  if (s.user && s.user !== want) return 'user-mismatch'
  if (s.denKey || isDenHerdrName(s.name)) {
    if (want !== 'owner') return 'user-mismatch'
    return 'adopt'
  }
  return 'foreign'
}

/** Per-den XDG_CONFIG_HOME. Short on purpose: `/run/user/<uid>/rivet-den-<hash8>`
 *  when that runtime dir exists, else `/tmp/rivet-den-<hash8>`. Hash is
 *  sha256(stateDir:port)[0:8]. Agent-detection manifests stay on the real
 *  XDG_STATE_HOME (grok.toml). */
export function herdrConfigHome(
  stateDir: string,
  port: number,
  exists: (p: string) => boolean = existsSync,
): string {
  const h = herdrRuntimeHash(stateDir, port)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const runBase = `/run/user/${uid}`
  if (exists(runBase)) return join(runBase, `rivet-den-${h}`)
  return join('/tmp', `rivet-den-${h}`)
}

export function herdrSocketPath(configHome: string, name: string): string {
  return join(configHome, 'herdr', 'sessions', name, 'herdr.sock')
}

export function herdrClientSocketPath(configHome: string, name: string): string {
  return join(configHome, 'herdr', 'sessions', name, 'herdr-client.sock')
}

export function herdrMetaPath(configHome: string, name: string): string {
  return join(configHome, 'herdr', 'sessions', name, 'rivet.json')
}

/** Per-den herdr `config.toml`, owned by den the way `tmux.conf` is: the
 *  herdr client is a wrapper around ONE agent pane, so herdr's own chrome —
 *  the sidebar ("spaces"/"agents" panels), the tab row, outer borders, the
 *  scrollbar column, tab-name prompts — is turned off and the pane gets the
 *  whole terminal (tmux `status off` parity). Rewritten on every den start;
 *  the herdr server and client both read it via `XDG_CONFIG_HOME`. */
export function herdrConfigPath(configHome: string): string {
  return join(configHome, 'herdr', 'config.toml')
}

export function herdrConfigContent(): string {
  const lines = [
    '# written by rivetos den-server on every start — edits here are overwritten',
    '[ui]',
    '# no sidebar (spaces/agents panels): the den pane IS the terminal',
    'sidebar_start_collapsed = true',
    'sidebar_collapsed_mode = "hidden"',
    '# no tab row — den sessions are single-pane, single-tab',
    'hide_tab_bar_when_single_tab = true',
    'prompt_new_tab_name = false',
    'confirm_close = false',
    '# no frame around the pane, no scrollbar column',
    'pane_outer_borders = false',
    'pane_scrollbars = false',
    'pane_gaps = false',
    '# pass the agent\'s own title through instead of "{hostname}: {workspace}"',
    'window_title = "{terminal_title}"',
    '# herdr switches to a single-column "mobile" layout with its own header at',
    '# <= 64 columns (phones): the den client is the whole terminal at any width',
    'mobile_width_threshold = 0',
  ]
  return lines.join('\n') + '\n'
}

export function assertHerdrSocketPath(configHome: string, name: string): void {
  const client = herdrClientSocketPath(configHome, name)
  const n = Buffer.byteLength(client, 'utf8')
  if (n > HERDR_SUN_PATH_MAX) {
    throw new HerdrUnavailableError(
      `socket path too long (${n} > ${HERDR_SUN_PATH_MAX}): ${client}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Pure argv builders (unit-tested; no I/O)
// ---------------------------------------------------------------------------

export function herdrServerArgv(name: string): string[] {
  return ['herdr', '--session', name, 'server']
}

export function herdrServerStopArgv(name: string): string[] {
  return ['herdr', '--session', name, 'server', 'stop']
}

/** TUI client. den's node-pty is a real tty so no extra flags; `CI` is
 *  deliberately NOT set (some TUIs disable alt-screen when CI=1). */
export function herdrAttachArgv(name: string): string[] {
  return ['herdr', '--session', name]
}

/** CLI workspace create. NEVER put credential-class values here — create()
 *  sends env on the socket API. This builder is for non-secret keys only. */
export function herdrWorkspaceCreateArgv(
  name: string,
  env: Record<string, string>,
  cwd?: string,
): string[] {
  const argv = ['herdr', '--session', name, 'workspace', 'create']
  if (cwd) argv.push('--cwd', cwd)
  for (const [k, v] of Object.entries(env)) {
    argv.push('--env', `${k}=${v}`)
  }
  return argv
}

export function herdrAgentStartArgv(
  name: string,
  label: string,
  kind: string,
  pane: string,
  harness: string[],
): string[] {
  return [
    'herdr',
    '--session',
    name,
    'agent',
    'start',
    label,
    '--kind',
    kind,
    '--pane',
    pane,
    '--',
    ...harness,
  ]
}

export function herdrSnapshotArgv(name: string): string[] {
  return ['herdr', '--session', name, 'session', 'snapshot']
}

export function herdrAgentListArgv(name: string): string[] {
  return ['herdr', '--session', name, 'agent', 'list']
}

export function herdrAgentReadArgv(name: string, target: string, lines: number): string[] {
  return ['herdr', '--session', name, 'agent', 'read', target, '--lines', String(lines)]
}

export function herdrPaneReadArgv(name: string, pane: string, lines: number): string[] {
  return ['herdr', '--session', name, 'pane', 'read', pane, '--lines', String(lines)]
}

export function herdrPaneListArgv(name: string): string[] {
  return ['herdr', '--session', name, 'pane', 'list']
}

/** `events.subscribe` is a socket-API method (protocol 20), NOT a CLI
 *  subcommand (`herdr events` → "unknown command", verified on 0.8.2). The hub
 *  therefore speaks newline-JSON over the session's `herdr.sock`: request ids
 *  are STRINGS, subscriptions are internally-tagged by the DOTTED event name,
 *  the ack is `{id,result:{type:'subscription_started'}}`, and events arrive
 *  as `{event, data}` envelopes (`data.agent_status` for status changes). */
export const HERDR_STATUS_EVENTS = ['pane.agent_status_changed', 'pane.agent_detected'] as const

/** Pane-scoped subscriptions REQUIRE `pane_id` (verified: omitting it is
 *  "missing field `pane_id`"). den knows the pane from workspace create. */
export function herdrEventsSubscribeRequest(paneId: string, id = 'den-status'): string {
  return (
    JSON.stringify({
      id,
      method: 'events.subscribe',
      params: { subscriptions: HERDR_STATUS_EVENTS.map((type) => ({ type, pane_id: paneId })) },
    }) + '\n'
  )
}

export function herdrRpcRequest(
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({ id, method, params }) + '\n'
}

/** Is this newline-JSON frame the subscribe ack (or any non-event reply)? */
export function isHerdrEventEnvelope(obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && 'event' in obj
}

/** Roster command → herdr `--kind`. Undefined = not in the closed enum
 *  (plain `shell`/`bash`, operator keys) → plain pane. */
export function herdrKindForCommand(command: string): string | undefined {
  if (HERDR_AGENT_KINDS.has(command)) return command
  return undefined
}

/** Same predicate `create()` uses for `agent.start`. Wrapper scripts and
 *  PATH-less argv[0] (a slash in the path) run as a plain pane — no status
 *  events — so the idle-signal ready-gate must not wait for them. */
export function herdrUseAgent(kind: string | undefined, argv0: string): boolean {
  return Boolean(kind) && !argv0.includes('/') && argv0 === kind
}

export function posixShellJoin(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
}

function herdrDebug(msg: string): void {
  if (process.env.RIVETOS_HERDR_DEBUG === '1') {
    console.error(`[herdr] ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Status mapper (pure)
// ---------------------------------------------------------------------------

const FRAME_STATUSES = new Set(['working', 'blocked', 'idle'])

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function pickStatus(raw: unknown): 'working' | 'blocked' | 'idle' | undefined {
  if (raw === 'done') return 'idle'
  if (typeof raw === 'string' && FRAME_STATUSES.has(raw)) {
    return raw as 'working' | 'blocked' | 'idle'
  }
  return undefined
}

function eventName(evt: Record<string, unknown>): string {
  const top = evt.event
  if (typeof top === 'string') return top
  const nested = asRecord(evt.data)?.event
  if (typeof nested === 'string') return nested
  const typ = evt.type
  if (typeof typ === 'string') return typ
  const nestedType = asRecord(evt.data)?.type
  if (typeof nestedType === 'string') return nestedType
  return ''
}

function eventStatus(evt: Record<string, unknown>): unknown {
  if ('agent_status' in evt) return evt.agent_status
  const data = asRecord(evt.data)
  if (data && 'agent_status' in data) return data.agent_status
  if ('status' in evt) return evt.status
  return data?.status
}

function eventSessionId(evt: Record<string, unknown>): string | undefined {
  if (typeof evt.sessionId === 'string' && evt.sessionId) return evt.sessionId
  const data = asRecord(evt.data)
  if (typeof data?.sessionId === 'string' && data.sessionId) return data.sessionId
  return undefined
}

function eventSince(evt: Record<string, unknown>, fallback: number): number {
  for (const v of [evt.since, evt.ts, asRecord(evt.data)?.since, asRecord(evt.data)?.ts]) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    if (Number.isFinite(n) && n > 0) return n
  }
  return fallback
}

const STATUS_EVENTS = new Set(['pane.agent_status_changed', 'pane_agent_status_changed'])
const DETECTED_EVENTS = new Set(['pane.agent_detected', 'pane_agent_detected'])

function asEventRecord(evt: unknown): Record<string, unknown> | undefined {
  let rec = asRecord(evt)
  if (!rec && typeof evt === 'string') {
    try {
      rec = asRecord(JSON.parse(evt))
    } catch {
      return undefined
    }
  }
  return rec
}

function detectedAgent(rec: Record<string, unknown>): unknown {
  const data = asRecord(rec.data) ?? rec
  return data.agent ?? data.agent_name ?? rec.agent
}

const AGENT_STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown'])
const LIVE_AGENT_STATUSES = new Set(['working', 'idle', 'blocked'])

function eventFinalStatus(rec: Record<string, unknown>): string | undefined {
  const data = asRecord(rec.data) ?? rec
  for (const v of [data.final_status, rec.final_status]) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function eventHasAgentField(rec: Record<string, unknown>): boolean {
  const data = asRecord(rec.data) ?? rec
  return 'agent' in data || 'agent_name' in data || 'agent' in rec
}

/** Primary end signal: `pane.agent_detected` / `pane_agent_detected` with
 *  schema `released === true`. `final_status` without `released` is NOT an
 *  end — see `herdrAgentNull`. A bare `agent: null` is also not an end.
 *  `done` is idle (see herdrStatusToFrame), not release. */
export function herdrAgentReleased(evt: unknown): boolean {
  const rec = asEventRecord(evt)
  if (!rec) return false
  const name = eventName(rec)
  if (!DETECTED_EVENTS.has(name)) return false
  const data = asRecord(rec.data) ?? rec
  return data.released === true || rec.released === true
}

/** Secondary signal: a detection event with `agent: null`/empty, or a
 *  present `final_status` without `released`, and no primary release.
 *  Must be confirmed by `paneAgent` before ending — a detection hiccup
 *  must not reap a healthy pane. */
export function herdrAgentNull(evt: unknown): boolean {
  const rec = asEventRecord(evt)
  if (!rec) return false
  if (!DETECTED_EVENTS.has(eventName(rec))) return false
  if (herdrAgentReleased(rec)) return false
  if (eventFinalStatus(rec) !== undefined) return true
  if (!eventHasAgentField(rec)) return false
  const agent = detectedAgent(rec)
  return agent == null || agent === ''
}

/** True when `pane.agent_detected` reports a live agent name. That is
 *  definitional evidence (clears a prior release latch and counts as seen). */
export function herdrAgentPresent(evt: unknown): boolean {
  const rec = asEventRecord(evt)
  if (!rec) return false
  if (!DETECTED_EVENTS.has(eventName(rec))) return false
  if (herdrAgentReleased(rec)) return false
  if (eventFinalStatus(rec) !== undefined) return false
  const agent = detectedAgent(rec)
  return typeof agent === 'string' && agent.length > 0
}

/** Map a herdr events-subscribe line (object or JSON string) onto the den
 *  harness-session WS frame. Unknown / `unknown` status → undefined. */
export function herdrStatusToFrame(
  evt: unknown,
  now: () => number = Date.now,
): HarnessStatusFrame | undefined {
  let rec = asRecord(evt)
  if (!rec && typeof evt === 'string') {
    try {
      rec = asRecord(JSON.parse(evt))
    } catch {
      return undefined
    }
  }
  if (!rec) return undefined
  const name = eventName(rec)
  if (name && !STATUS_EVENTS.has(name)) return undefined
  const status = pickStatus(eventStatus(rec))
  if (!status) return undefined
  const sessionId = eventSessionId(rec) ?? ''
  return {
    type: 'status',
    sessionId: sessionId as HarnessStatusFrame['sessionId'],
    status,
    since: eventSince(rec, now()),
  }
}

export function parseWorkspaceCreate(stdout: string): { paneId: string } {
  try {
    return parseWorkspaceCreateValue(JSON.parse(stdout))
  } catch (e) {
    if (e instanceof HerdrUnavailableError || e instanceof HerdrCommandError) throw e
    return { paneId: HERDR_DEFAULT_PANE }
  }
}

export function parseWorkspaceCreateValue(raw: unknown): { paneId: string } {
  const rec = asRecord(raw)
  if (!rec) return { paneId: HERDR_DEFAULT_PANE }
  const err = asRecord(rec.error)
  if (err) {
    const code = typeof err.code === 'string' ? err.code : ''
    const message = typeof err.message === 'string' ? err.message : JSON.stringify(err)
    throw new HerdrCommandError(`herdr workspace.create failed (${code || 'error'}): ${message}`)
  }
  const result = asRecord(rec.result) ?? rec
  const root = asRecord(result.root_pane) ?? asRecord(result.rootPane)
  const pane =
    (typeof result.pane_id === 'string' && result.pane_id) ||
    (typeof result.paneId === 'string' && result.paneId) ||
    (typeof asRecord(result.pane)?.id === 'string' && (asRecord(result.pane)?.id as string)) ||
    (typeof asRecord(result.pane)?.pane_id === 'string' &&
      (asRecord(result.pane)?.pane_id as string)) ||
    (typeof root?.pane_id === 'string' && root.pane_id) ||
    (typeof root?.id === 'string' && root.id) ||
    (Array.isArray(asRecord(result.workspace)?.panes)
      ? (asRecord((asRecord(result.workspace)?.panes as unknown[])[0])?.pane_id as
          string | undefined)
      : undefined)
  if (typeof pane === 'string' && pane) return { paneId: pane }
  return { paneId: HERDR_DEFAULT_PANE }
}

export function parsePaneSize(stdout: string): { cols: number; rows: number } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const rec = asRecord(raw)
  const result = rec ? (asRecord(rec.result) ?? rec) : undefined
  const rowsSrc: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(result?.panes)
      ? (result.panes as unknown[])
      : raw && typeof raw === 'object'
        ? [raw]
        : []
  for (const row of rowsSrc) {
    const r = asRecord(row)
    if (!r) continue
    const scroll = asRecord(r.scroll)
    const inner = asRecord(r.size) ?? asRecord(r.geometry) ?? r
    const cols = Number(
      inner.cols ?? inner.width ?? inner.viewport_cols ?? scroll?.viewport_cols ?? scroll?.cols,
    )
    const height = Number(
      inner.rows ?? inner.height ?? inner.viewport_rows ?? scroll?.viewport_rows ?? scroll?.rows,
    )
    if (Number.isFinite(cols) && Number.isFinite(height) && cols >= 1 && height >= 1) {
      return { cols, rows: height }
    }
  }
  // 0.8.2 pane list has viewport_rows and no cols — windowSize is undefined
  // (herdr is latest-client-wins; den does not invent a width).
  return undefined
}

export type PaneAgentInfo = { agent: string | null; status?: string }

function pickAgentStatus(raw: unknown): string | undefined {
  return typeof raw === 'string' && AGENT_STATUSES.has(raw) ? raw : undefined
}

function paneAgentFromRow(row: unknown): PaneAgentInfo | undefined {
  const r = asRecord(row)
  if (!r) return undefined
  const inner = asRecord(r.pane) ?? r
  const agentRaw = inner.agent ?? inner.agent_name ?? inner.name ?? r.agent
  const agent = agentRaw === null ? null : typeof agentRaw === 'string' ? agentRaw : undefined
  const status = pickAgentStatus(inner.agent_status ?? inner.status ?? r.agent_status)
  if (agent === undefined && status === undefined) return undefined
  return { agent: agent ?? null, ...(status ? { status } : {}) }
}

function rowPaneId(row: unknown): string | undefined {
  const r = asRecord(row)
  if (!r) return undefined
  const inner = asRecord(r.pane) ?? r
  for (const v of [inner.pane_id, inner.paneId, r.pane_id, r.paneId]) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function collectPaneAgentRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const rec = asRecord(raw)
  if (!rec) return []
  const result = asRecord(rec.result) ?? rec
  if (Array.isArray(result.panes)) return result.panes as unknown[]
  if (Array.isArray(result.agents)) return result.agents as unknown[]
  if (Array.isArray(rec.panes)) return rec.panes as unknown[]
  if (Array.isArray(rec.agents)) return rec.agents as unknown[]
  return [raw]
}

/** Defensive parse of `pane list` / `agent list` JSON against PaneInfo /
 *  AgentInfo: `agent` is string|null, `agent_status` is the closed enum.
 *  Unparseable output → undefined (probe unavailable). An empty but valid
 *  list is `{ agent: null }` (positively no agent). When `paneId` is set,
 *  only that row counts: missing/unknown pane → undefined (fail closed),
 *  never "any row is live". */
export function parsePaneAgent(stdout: string, paneId?: string): PaneAgentInfo | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const rows = collectPaneAgentRows(raw)
  const scoped =
    typeof paneId === 'string' && paneId.length > 0
      ? rows.filter((row) => rowPaneId(row) === paneId)
      : rows
  if (typeof paneId === 'string' && paneId.length > 0 && scoped.length === 0) return undefined
  if (scoped.length === 0) return { agent: null }
  for (const row of scoped) {
    const got = paneAgentFromRow(row)
    if (!got) continue
    if (typeof got.agent === 'string' && got.agent.length > 0) return got
    if (got.status && LIVE_AGENT_STATUSES.has(got.status)) return got
  }
  for (const row of scoped) {
    const got = paneAgentFromRow(row)
    if (got) return got
  }
  return { agent: null }
}

/** Probe said a live agent (non-empty name, or working|idle|blocked). */
export function herdrPaneAgentLive(p: PaneAgentInfo): boolean {
  if (typeof p.agent === 'string' && p.agent.length > 0) return true
  return typeof p.status === 'string' && LIVE_AGENT_STATUSES.has(p.status)
}

/** Exact x.y.z only. `0.8.2-preview.N` must not match the pin. */
export function parseHerdrVersion(out: string): string | null {
  const m = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(out.trim())
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

export type HerdrExec = (
  bin: string,
  args: string[],
  opts: {
    encoding: 'utf8'
    timeout: number
    stdio: ['ignore', 'pipe', 'ignore']
    env?: NodeJS.ProcessEnv
  },
) => string

export function herdrVersion(bin: string, execFn: HerdrExec = execFileSync): string | null {
  try {
    const out = execFn(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseHerdrVersion(out)
  } catch {
    return null
  }
}

/** True when `bin` reports the pinned 0.8.2. */
export function herdrSupported(bin: string, execFn: HerdrExec = execFileSync): boolean {
  return herdrVersion(bin, execFn) === HERDR_PINNED_VERSION
}

export function findHerdrOnPath(pathEnv?: string, home: string = homedir()): string | null {
  const onPath = findOnPath('herdr', pathEnv ?? process.env.PATH ?? '')
  if (onPath) return onPath
  // `rivetos install --herdr` puts the pinned binary in ~/.local/bin, which the
  // service unit's PATH usually lacks (2026-09-04: den fell back to tmux on the
  // canary for exactly that reason). Look there explicitly before giving up.
  const local = join(home, '.local', 'bin', 'herdr')
  try {
    accessSync(local, fsConstants.X_OK)
    if (statSync(local).isFile()) return local
  } catch {
    // not installed there either
  }
  return null
}

/** True when a herdr binary at the pinned version is reachable (PATH or
 *  ~/.local/bin). This is what makes herdr the DEFAULT mux when
 *  RIVETOS_DEN_TERM_MUX is unset (fleet decision 2026-09-06). */
export function herdrAvailable(pathEnv?: string, home?: string, execFn?: HerdrExec): boolean {
  const bin = findHerdrOnPath(pathEnv, home)
  return bin !== null && herdrSupported(bin, execFn)
}

// ---------------------------------------------------------------------------
// Status hub — one events-subscribe child per session, refcounted, backoff
// ---------------------------------------------------------------------------

export interface HerdrStatusHub {
  /** +1. Starts the stream at 0→1. */
  retain(name: string, sessionId: string): void
  /** -1. Stops the stream at 1→0. */
  release(name: string): void
  /** Live subscribe count for tests. */
  refs(name: string): number
  close(): void
}

const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 5000]
/** Reset reconnect attempt only after the stream delivered an event or stayed
 *  up this long. Otherwise a flapping socket reconnects at backoff[0] forever. */
const HUB_STABLE_MS = 5_000

export function createHerdrStatusHub(opts: {
  subscribe: (name: string, onEvent: (evt: unknown) => void, onClose: () => void) => () => void
  onFrame: (name: string, frame: HarnessStatusFrame) => void
  /** Every subscribe event, including ones that do not map to a status frame
   *  (`pane.agent_detected`, `done`). Optional — existing callers ignore it. */
  onEvent?: (name: string, evt: unknown) => void
  now?: () => number
  backoffMs?: number[]
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}): HerdrStatusHub {
  const now = opts.now ?? Date.now
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const setT = opts.setTimeout ?? setTimeout
  const clearT = opts.clearTimeout ?? clearTimeout

  interface Slot {
    refs: number
    sessionId: string
    unsub?: () => void
    timer?: ReturnType<typeof setTimeout>
    attempt: number
    closed: boolean
    connectedAt?: number
    gotEvent?: boolean
  }
  const slots = new Map<string, Slot>()

  const stopChild = (s: Slot): void => {
    if (s.timer) {
      clearT(s.timer)
      s.timer = undefined
    }
    if (s.unsub) {
      try {
        s.unsub()
      } catch {
        // unsubscribe must never throw out of release/close
      }
      s.unsub = undefined
    }
  }

  const start = (name: string, s: Slot): void => {
    if (s.closed || s.refs <= 0) return
    stopChild(s)
    let closedOnce = false
    s.gotEvent = false
    s.connectedAt = now()
    s.unsub = opts.subscribe(
      name,
      (evt) => {
        opts.onEvent?.(name, evt)
        const frame = herdrStatusToFrame(evt, now)
        if (!frame) return
        s.gotEvent = true
        // Always den's id — herdr events carry no den session key, and a
        // herdr-native id would miss the registry subscription.
        opts.onFrame(name, { ...frame, sessionId: s.sessionId as HarnessStatusFrame['sessionId'] })
      },
      () => {
        if (closedOnce) return
        closedOnce = true
        const unsub = s.unsub
        s.unsub = undefined
        if (unsub) {
          try {
            unsub()
          } catch {
            // never throw out of a close callback
          }
        }
        if (s.closed || s.refs <= 0) return
        const upMs = s.connectedAt !== undefined ? now() - s.connectedAt : 0
        if (s.gotEvent || upMs >= HUB_STABLE_MS) s.attempt = 0
        const wait = backoff[Math.min(s.attempt, backoff.length - 1)] ?? 5000
        s.attempt += 1
        s.timer = setT(() => {
          s.timer = undefined
          start(name, s)
        }, wait)
      },
    )
  }

  return {
    retain(name, sessionId) {
      let s = slots.get(name)
      if (!s) {
        s = { refs: 0, sessionId, attempt: 0, closed: false }
        slots.set(name, s)
      }
      s.sessionId = sessionId
      s.closed = false
      s.refs += 1
      if (s.refs === 1) start(name, s)
    },
    release(name) {
      const s = slots.get(name)
      if (!s) return
      s.refs = Math.max(0, s.refs - 1)
      if (s.refs === 0) {
        s.closed = true
        stopChild(s)
        slots.delete(name)
      }
    },
    refs(name) {
      return slots.get(name)?.refs ?? 0
    },
    close() {
      for (const [name, s] of slots) {
        s.closed = true
        s.refs = 0
        stopChild(s)
        slots.delete(name)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

const HERDR_CTL_MS = 250
const HERDR_CREATE_MS = 30_000
/** A fresh workspace pane must reach its shell prompt before agent.start /
 *  send_text — herdr answers `agent_pane_busy: not an available shell` otherwise. */
const HERDR_PANE_READY_MS = 10_000
const HERDR_WS_CREATE_MS = 5_000
const HERDR_SEND_TEXT_MS = 2_000

export type HerdrChild = { kill: () => void; pid?: number }

export type HerdrSpawn = (
  bin: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv
    onStdoutLine?: (line: string) => void
    onClose?: () => void
    /** Long-lived daemon (the session server): own process group, no pipes,
     *  unref'd so den can exit and restart without taking it down. */
    detached?: boolean
  },
) => HerdrChild

export type HerdrRpc = (
  sockPath: string,
  req: { id: string; method: string; params?: Record<string, unknown> },
  timeoutMs: number,
) => Promise<unknown>

export type HerdrWaitFn = (path: string, timeoutMs: number) => boolean | Promise<boolean>

const defaultSpawn: HerdrSpawn = (bin, args, opts) => {
  const child: ChildProcess = spawn(bin, args, {
    env: opts.env,
    stdio: opts.detached ? 'ignore' : ['ignore', 'pipe', 'ignore'],
    detached: !!opts.detached,
  })
  if (opts.detached) child.unref()
  let buf = ''
  child.stdout?.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line) opts.onStdoutLine?.(line)
    }
  })
  const finish = (): void => {
    opts.onClose?.()
  }
  child.on('close', finish)
  child.on('error', finish)
  return {
    kill: () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // already gone
      }
    },
    pid: child.pid ?? undefined,
  }
}

/** Event-loop poll for the api socket. No Atomics.wait, no busy spin. */
export async function waitForSocket(
  path: string,
  timeoutMs: number,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await pause(50)
  }
  return existsSync(path)
}

function defaultRpc(connectFn: (path: string) => Duplex): HerdrRpc {
  return (sockPath, req, timeoutMs) =>
    new Promise((resolve, reject) => {
      let sock: Duplex
      try {
        sock = connectFn(sockPath)
      } catch (e) {
        reject(e instanceof Error ? e : new HerdrUnavailableError(String(e)))
        return
      }
      let buf = ''
      let done = false
      const timer = setTimeout(() => {
        finish(new HerdrUnavailableError(`herdr rpc ${req.method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const finish = (err?: Error, val?: unknown): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          sock.destroy()
        } catch {
          // already gone
        }
        if (err) reject(err)
        else resolve(val)
      }
      sock.on('connect', () => {
        try {
          sock.write(
            JSON.stringify({ id: req.id, method: req.method, params: req.params ?? {} }) + '\n',
          )
        } catch (e) {
          finish(e instanceof Error ? e : new HerdrUnavailableError(String(e)))
        }
      })
      sock.on('data', (chunk: Buffer | string) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let obj: unknown
          try {
            obj = JSON.parse(line)
          } catch {
            continue
          }
          const rec = asRecord(obj)
          if (!rec) continue
          if (rec.id !== req.id) continue
          const err = asRecord(rec.error)
          if (err) {
            const code = typeof err.code === 'string' ? err.code : ''
            const message = typeof err.message === 'string' ? err.message : JSON.stringify(err)
            if (code === 'server_not_running') {
              finish(new HerdrUnavailableError(`server_not_running: ${message}`))
              return
            }
            finish(new HerdrCommandError(`herdr ${req.method} failed (${code}): ${message}`))
            return
          }
          finish(undefined, rec.result ?? rec)
        }
      })
      sock.on('error', (e: Error) => {
        const code = (e as NodeJS.ErrnoException).code ?? ''
        if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e.message)) {
          finish(new HerdrUnavailableError(`ECONNREFUSED: ${e.message}`))
          return
        }
        finish(e)
      })
      sock.on('close', () => {
        if (!done) finish(new HerdrUnavailableError(`herdr rpc ${req.method}: socket closed`))
      })
    })
}

interface RivetMeta {
  command: string
  user: string
  paneId?: string
  created?: number
  denKey?: string
  pid?: number
}

function readMeta(configHome: string, name: string): RivetMeta {
  try {
    const raw = readFileSync(herdrMetaPath(configHome, name), 'utf8')
    const j = JSON.parse(raw) as RivetMeta
    return {
      command: typeof j.command === 'string' ? j.command : '',
      user: typeof j.user === 'string' ? j.user : '',
      paneId: typeof j.paneId === 'string' ? j.paneId : undefined,
      created: typeof j.created === 'number' ? j.created : undefined,
      denKey: typeof j.denKey === 'string' ? j.denKey : undefined,
      pid: typeof j.pid === 'number' && j.pid > 0 ? j.pid : undefined,
    }
  } catch {
    return { command: '', user: '' }
  }
}

function writeMeta(configHome: string, name: string, meta: RivetMeta): void {
  const dir = join(configHome, 'herdr', 'sessions', name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(herdrMetaPath(configHome, name), JSON.stringify(meta) + '\n', { mode: 0o600 })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return true
}

/** pid identity: a live pid is only "our server" if its cmdline is a herdr
 *  server for THIS session — pid reuse after a reboot on a /tmp config home
 *  must not read as alive. Non-linux (no /proc): fall back to kill -0. */
export function pidIsHerdrServer(pid: number, sessionName: string): boolean {
  if (!pidAlive(pid)) return false
  let cmdline: string
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return true
  }
  const argv = cmdline.split('\0')
  const isHerdr = argv.some((a) => a === 'herdr' || a.endsWith('/herdr'))
  return isHerdr && argv.includes(sessionName) && argv.includes('server')
}

function userXdgConfigHome(configHome: string): string {
  const fromEnv = process.env.XDG_CONFIG_HOME
  if (fromEnv && fromEnv !== configHome) return fromEnv
  return join(homedir(), '.config')
}

/** HerdrCtl backed by the real herdr binary (absolute path). Ctl probes use
 *  short execFileSync (250 ms). Create is async: detached spawn + event-loop
 *  sock poll + socket RPC for workspace.create / agent.start / pane.send_text.
 *  `XDG_CONFIG_HOME` on ctl/client processes is the per-den short home; the
 *  agent env on workspace.create gets the user's real XDG_CONFIG_HOME. */
export function createRealHerdrCtl(
  binary: string,
  configHome: string,
  execFn: HerdrExec = execFileSync,
  spawnFn: HerdrSpawn = defaultSpawn,
  waitFn: HerdrWaitFn = waitForSocket,
  connectFn: (path: string) => Duplex = (path) => createConnection(path),
  rpcFn?: HerdrRpc,
): HerdrCtl {
  mkdirSync(configHome, { recursive: true, mode: 0o700 })
  const envFor = (): NodeJS.ProcessEnv => ({
    ...process.env,
    XDG_CONFIG_HOME: configHome,
  })
  const rpc = rpcFn ?? defaultRpc(connectFn)

  const run = (args: string[], timeout = HERDR_CTL_MS): string | null => {
    try {
      return execFn(binary, args, {
        encoding: 'utf8',
        timeout,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: envFor(),
      })
    } catch (e) {
      const err = e as { status?: unknown; code?: unknown; message?: unknown }
      if (typeof err.status === 'number' && err.status === 1) return null
      if (typeof err.status === 'number' && err.status === 2) {
        throw new HerdrCommandError(`herdr ctl failed (exit 2, ${args[0]}): ${String(e)}`, 2)
      }
      throw new HerdrUnavailableError(`herdr ctl failed (${args[0]}): ${String(e)}`)
    }
  }

  const reapDir = (name: string): void => {
    try {
      rmSync(join(configHome, 'herdr', 'sessions', name), { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }

  const snapshotAlive = (name: string): boolean => {
    try {
      const out = execFn(binary, herdrSnapshotArgv(name).slice(1), {
        encoding: 'utf8',
        timeout: HERDR_CTL_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: envFor(),
      })
      if (typeof out === 'string' && /server_not_running/.test(out)) return false
      return true
    } catch (e) {
      const err = e as { status?: unknown; code?: unknown; message?: unknown }
      const str = (v: unknown): string =>
        typeof v === 'string' || typeof v === 'number' ? String(v) : ''
      const blob = `${str(err.code)} ${str(err.message) || String(e)} ${str(err.status)}`
      if (/ECONNREFUSED|server_not_running|ENOENT|ECONNRESET/.test(blob)) return false
      // A busy server that misses the 250 ms budget is NOT dead: ETIMEDOUT /
      // killed-by-timeout means "unknown" — treat as alive, never reap on it.
      if (/ETIMEDOUT|timed out/i.test(blob) || (e as { killed?: boolean }).killed === true)
        return true
      return false
    }
  }

  /** Reap a dead session dir — ONLY from create() recovery and killSession,
   *  never from a read path (list/has), so a transient probe miss cannot
   *  delete a live session's directory. */
  const reapIfDead = (name: string): void => {
    if (existsSync(join(configHome, 'herdr', 'sessions', name)) && !isLive(name)) reapDir(name)
  }

  const isLive = (name: string): boolean => {
    const meta = readMeta(configHome, name)
    if (meta.pid && meta.pid > 0) {
      if (!pidIsHerdrServer(meta.pid, name)) return false
      return true
    }
    const sock = herdrSocketPath(configHome, name)
    if (!existsSync(sock)) return false
    if (!snapshotAlive(name)) {
      return false
    }
    return true
  }

  const listFresh = (): HerdrSessionInfo[] => {
    const root = join(configHome, 'herdr', 'sessions')
    const names = listSessionDirs(root)
    const nowSec = Math.floor(Date.now() / 1000)
    const out: HerdrSessionInfo[] = []
    for (const name of names) {
      if (!isLive(name)) continue
      const meta = readMeta(configHome, name)
      out.push({
        name,
        denKey: meta.denKey,
        activity: nowSec,
        created: meta.created ?? nowSec,
        pid: meta.pid,
        command: meta.command,
        user: meta.user,
        paneId: meta.paneId,
      })
    }
    return out
  }

  return {
    hasSession(name) {
      return isLive(name)
    },
    killSession(name) {
      try {
        run(herdrServerStopArgv(name).slice(1), 2000)
      } catch {
        const meta = readMeta(configHome, name)
        if (meta.pid) {
          try {
            process.kill(meta.pid, 'SIGTERM')
          } catch {
            // ESRCH = already dead
          }
        }
      }
      const meta = readMeta(configHome, name)
      if (meta.pid && pidIsHerdrServer(meta.pid, name)) {
        // stop did not take — keep the dir so the orphan stays addressable
        throw new HerdrUnavailableError(
          `herdr server stop failed for ${name} (pid ${meta.pid} still alive); not removing session dir`,
        )
      }
      reapDir(name)
    },
    listSessions: listFresh,
    refresh() {
      // no memo today — list is a readdir + liveness probe
    },
    setOption(name, option, value) {
      const meta = readMeta(configHome, name)
      if (option === '@rivet_command') meta.command = value
      if (option === '@rivet_user') meta.user = value
      writeMeta(configHome, name, meta)
    },
    windowSize(name) {
      try {
        const stdout = run(herdrPaneListArgv(name).slice(1))
        if (stdout === null) return undefined
        return parsePaneSize(stdout)
      } catch {
        return undefined
      }
    },
    async create(opts) {
      assertHerdrSocketPath(configHome, opts.name)
      reapIfDead(opts.name)
      mkdirSync(join(configHome, 'herdr', 'sessions', opts.name), { recursive: true, mode: 0o700 })
      const sock = herdrSocketPath(configHome, opts.name)
      const child = spawnFn(binary, herdrServerArgv(opts.name).slice(1), {
        env: envFor(),
        detached: true,
      })
      const ready = await Promise.resolve(waitFn(sock, HERDR_CREATE_MS))
      if (!ready) {
        throw new HerdrUnavailableError(
          `herdr server did not open ${sock} within ${HERDR_CREATE_MS}ms for ${opts.name}`,
        )
      }
      // Record the session the moment its server is up — a crash anywhere in
      // workspace/agent setup must not leave a running server invisible to
      // list/resolve/GC. paneId is added below once the pane exists.
      writeMeta(configHome, opts.name, {
        command: opts.command,
        user: opts.user,
        created: Math.floor(Date.now() / 1000),
        denKey: opts.denKey,
        pid: child.pid,
      })
      const agentEnv = { ...opts.env }
      if (!agentEnv.XDG_CONFIG_HOME || agentEnv.XDG_CONFIG_HOME === configHome) {
        agentEnv.XDG_CONFIG_HOME = userXdgConfigHome(configHome)
      }
      try {
        const ws = await rpc(
          sock,
          {
            id: 'den-ws-create',
            method: 'workspace.create',
            params: {
              cwd: opts.cwd,
              env: agentEnv,
              label: opts.command,
            },
          },
          HERDR_WS_CREATE_MS,
        )
        const { paneId } = parseWorkspaceCreateValue(ws)
        // Wait for the pane's shell prompt (the shell sets the terminal title
        // on prompt). Verified on 0.8.2: agent.start straight after
        // workspace.create fails with agent_pane_busy.
        const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        const readyBy = Date.now() + HERDR_PANE_READY_MS
        while (Date.now() < readyBy) {
          try {
            const got = (await rpc(
              sock,
              { id: 'den-pane-get', method: 'pane.get', params: { pane_id: paneId } },
              1000,
            )) as { pane?: { terminal_title?: unknown }; terminal_title?: unknown } | null
            const title = got?.pane?.terminal_title ?? got?.terminal_title
            if (typeof title === 'string' && title.trim()) break
          } catch {
            // server still settling — keep polling
          }
          await sleep(200)
        }
        // herdr's --kind names BOTH the agent kind and the canonical executable
        // it prepends; passing argv[0] again launches `grok grok …` and the
        // harness reads its own name as an initial prompt (review B6). Only a
        // roster whose argv[0] IS that executable goes through agent.start —
        // anything else (wrapper scripts, custom binaries) runs verbatim in a
        // plain pane (no status detection, but no surprises).
        // A bare argv[0] equal to the kind: herdr launches that kind's binary
        // from PATH. A PATH-less roster (`/opt/grok-1.0.13/bin/grok`) pins a
        // build herdr would silently replace, so it runs verbatim in a plain
        // pane instead (no status detection — the honest trade).
        const argv0 = opts.argv[0] ?? ''
        const useAgent = herdrUseAgent(opts.kind, argv0)
        if (useAgent) {
          const startReq = {
            id: 'den-agent-start',
            method: 'agent.start',
            params: {
              // herdr agent names: [a-z][a-z0-9_-]{0,31} — the hashed session
              // name qualifies; the den key (colons, 36-44 chars) does not.
              name: opts.name,
              kind: opts.kind,
              pane_id: paneId,
              args: opts.argv.slice(1),
              timeout_ms: HERDR_CREATE_MS,
            },
          }
          // agent_pane_busy = the shell prompt is not up yet; retry briefly.
          const busyBy = Date.now() + HERDR_PANE_READY_MS
          for (;;) {
            try {
              await rpc(sock, startReq, HERDR_CREATE_MS)
              break
            } catch (e) {
              if (!/agent_pane_busy/.test(String(e)) || Date.now() >= busyBy) throw e
              await sleep(250)
            }
          }
        } else {
          const text = `${posixShellJoin(opts.argv)}\n`
          await rpc(
            sock,
            {
              id: 'den-pane-run',
              method: 'pane.send_text',
              params: { pane_id: paneId, text },
            },
            HERDR_SEND_TEXT_MS,
          )
        }
        writeMeta(configHome, opts.name, {
          command: opts.command,
          user: opts.user,
          paneId,
          created: Math.floor(Date.now() / 1000),
          denKey: opts.denKey,
          pid: child.pid,
        })
      } catch (e) {
        try {
          run(herdrServerStopArgv(opts.name).slice(1), 2000)
        } catch {
          if (child.pid) {
            try {
              process.kill(child.pid, 'SIGTERM')
            } catch {
              // best-effort teardown of a half-created session
            }
          }
        }
        throw e
      }
    },
    attachArgv(name) {
      return herdrAttachArgv(name)
    },
    capture(name, lines) {
      const meta = readMeta(configHome, name)
      const label = name // the agent is registered under the hashed session name
      try {
        const agent = run(herdrAgentReadArgv(name, label, lines).slice(1), 2000)
        if (agent !== null && agent.trim()) return agent
      } catch {
        // fall through to pane read
      }
      const pane = meta.paneId ?? HERDR_DEFAULT_PANE
      try {
        return run(herdrPaneReadArgv(name, pane, lines).slice(1), 2000) ?? ''
      } catch {
        return ''
      }
    },
    captureAsync(name, lines) {
      const meta = readMeta(configHome, name)
      const runAsync = (args: string[]): Promise<string> =>
        new Promise((resolve) => {
          execFile(
            binary,
            args,
            { encoding: 'utf8', timeout: 2000, env: envFor() },
            (err, stdout) => resolve(err ? '' : stdout),
          )
        })
      return runAsync(herdrAgentReadArgv(name, name, lines).slice(1)).then((agent) =>
        agent.trim()
          ? agent
          : runAsync(herdrPaneReadArgv(name, meta.paneId ?? HERDR_DEFAULT_PANE, lines).slice(1)),
      )
    },
    async paneAgent(name, paneId) {
      const pane =
        typeof paneId === 'string' && paneId.length > 0 ? paneId : readMeta(configHome, name).paneId
      if (!pane) return undefined
      const runAsync = (args: string[]): Promise<string | null> =>
        new Promise((resolve) => {
          execFile(
            binary,
            args,
            { encoding: 'utf8', timeout: 2000, env: envFor() },
            (err, stdout) => resolve(err ? null : stdout),
          )
        })
      try {
        const paneOut = await runAsync(herdrPaneListArgv(name).slice(1))
        const fromPane = paneOut ? parsePaneAgent(paneOut, pane) : undefined
        if (fromPane !== undefined) return fromPane
        const agentOut = await runAsync(herdrAgentListArgv(name).slice(1))
        return agentOut ? parsePaneAgent(agentOut, pane) : undefined
      } catch {
        return undefined
      }
    },
    subscribeEvents(name, onEvent, onClose) {
      const paneId = readMeta(configHome, name).paneId ?? 'w1:p1'
      const sockPath = herdrSocketPath(configHome, name)
      const sock = connectFn(sockPath)
      let buf = ''
      let closed = false
      const finish = (): void => {
        if (closed) return
        closed = true
        herdrDebug(`close session=${name} sock=${sockPath}`)
        onClose?.()
      }
      sock.on('connect', () => {
        herdrDebug(`connect session=${name} sock=${sockPath} pane=${paneId}`)
        sock.write(herdrEventsSubscribeRequest(paneId))
      })
      sock.on('data', (chunk: Buffer | string) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let obj: unknown
          try {
            obj = JSON.parse(line)
          } catch {
            continue
          }
          const rec = asRecord(obj)
          if (
            rec &&
            rec.id === 'den-status' &&
            asRecord(rec.result)?.type === 'subscription_started'
          ) {
            herdrDebug(`subscribe-ack session=${name} pane=${paneId}`)
            continue
          }
          if (isHerdrEventEnvelope(obj)) {
            if (process.env.RIVETOS_HERDR_DEBUG === '1') {
              const ev = obj as { event?: unknown; data?: { agent_status?: unknown } }
              console.error(
                `[herdr] event session=${name} ${String(ev.event)} status=${typeof ev.data?.agent_status === 'string' ? ev.data.agent_status : '-'}`,
              )
            }
            onEvent(obj)
          }
        }
      })
      sock.on('close', finish)
      sock.on('error', finish)
      return () => {
        closed = true
        sock.destroy()
      }
    },
  }
}

function listSessionDirs(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

/** Grok screen-manifest lives here on a provisioned node (not this package). */
export function herdrGrokManifestHint(): string {
  return join(homedir(), '.local', 'state', 'herdr', 'agent-detection', 'remote', 'grok.toml')
}
