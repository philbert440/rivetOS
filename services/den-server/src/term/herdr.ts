// herdr mux layer for den PTYs (`term.mux: herdr`). Default is still tmux.
//
// When `term.mux` resolves to 'herdr', the manager's PTY is a herdr TUI
// CLIENT (`herdr --session <name>`) of a per-den named session. The harness
// lives in the herdr server (headless `herdr --session <name> server`) and
// survives den restarts, browser detaches and the idle/detached reapers the
// same way a tmux session does. A user can attach the same session from their
// own terminal with `XDG_CONFIG_HOME=<stateDir>/den/herdr-config herdr
// --session <name>`. Nothing here runs unless `term.mux` is explicitly
// `herdr` — unset still auto-detects tmux.
//
// Everything herdr touches goes through the HerdrCtl seam: production uses
// the execFileSync / spawn implementation below (no shell), tests inject a
// scripted fake so unit tests never spawn a real herdr. Binary is pinned to
// 0.8.2 (protocol 20); any other version is HerdrUnavailableError and the
// manager falls back to tmux with one warning line.
//
// Session names reuse tmux's reversible encoding (den keys allow `:`/`.`;
// herdr session dirs should not). Env for the AGENT is passed on
// `workspace create` (socket/`--env`), never on the agent argv / `ps`.
// Screen-manifest status (`pane.agent_status_changed`) is a NEW signal den
// did not have under tmux — see `herdrStatusToFrame` and the status hub.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessStatusFrame } from '@rivetos/types'
import {
  classifyExistingTmuxSession,
  decodeTmuxName,
  encodeTmuxName,
  findOnPath,
  isDenTmuxName,
  type TmuxSessionInfo,
} from './tmux.js'

/** Pinned herdr release. `herdr --version` must report this exact x.y.z. */
export const HERDR_PINNED_VERSION = '0.8.2'

/** Default pane created by `workspace create` (spike, protocol 20). */
export const HERDR_DEFAULT_PANE = 'w1:p1'

export class HerdrUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HerdrUnavailableError'
  }
}

export type ExistingHerdrDisposition = 'attach' | 'adopt' | 'foreign' | 'user-mismatch'

export interface HerdrSessionInfo {
  /** Encoded session name (decode with decodeHerdrName). */
  name: string
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

/** The herdr command surface the manager uses. Sync, like TmuxCtl: the
 *  manager's spawn path is synchronous. "Not found" collapses to false/[];
 *  every other failure throws HerdrUnavailableError. */
export interface HerdrCtl {
  hasSession(name: string): boolean
  killSession(name: string): void
  listSessions(): HerdrSessionInfo[]
  refresh?(): void
  setOption?(name: string, option: string, value: string): void
  windowSize?(name: string): { cols: number; rows: number } | undefined
  /** Headless server + workspace create + agent start. No-op-ish when the
   *  session already exists — callers check hasSession first. Env rides the
   *  workspace create params (socket), never the agent argv. */
  create(opts: HerdrCreateOpts): void
  /** TUI client argv for the den PTY. */
  attachArgv(name: string): string[]
  /** Scrollback via `agent read` / `pane read`. Empty string on failure. */
  capture?(name: string, lines: number): string
  /** One newline-JSON `events subscribe` child. Returns unsubscribe.
   *  `onClose` fires when the child exits (hub reconnects). */
  subscribeEvents?(
    name: string,
    onEvent: (evt: unknown) => void,
    onClose?: () => void,
  ): () => void
}

export interface HerdrCreateOpts {
  name: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  /** herdr `--kind` (claude|grok|kimi|…). */
  kind: string
  command: string
  user: string
  cols?: number
  rows?: number
}

// ---------------------------------------------------------------------------
// Name encoding — identical to tmux, reused on purpose.
// ---------------------------------------------------------------------------

export const encodeHerdrName = encodeTmuxName
export const decodeHerdrName = decodeTmuxName
export const isDenHerdrName = isDenTmuxName
export const classifyExistingHerdrSession = (
  s: HerdrSessionInfo,
  routedUser?: string,
): ExistingHerdrDisposition =>
  classifyExistingTmuxSession(s as TmuxSessionInfo, routedUser)

/** Per-den XDG_CONFIG_HOME so two dens never share `herdr.sock` dirs.
 *  Agent-detection manifests stay on the real XDG_STATE_HOME (grok.toml). */
export function herdrConfigHome(stateDir: string): string {
  return join(stateDir, 'den', 'herdr-config')
}

export function herdrSocketPath(configHome: string, name: string): string {
  return join(configHome, 'herdr', 'sessions', name, 'herdr.sock')
}

export function herdrMetaPath(configHome: string, name: string): string {
  return join(configHome, 'herdr', 'sessions', name, 'rivet.json')
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

/** Is this newline-JSON frame the subscribe ack (or any non-event reply)? */
export function isHerdrEventEnvelope(obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && 'event' in obj
}

/** Roster command → herdr `--kind`. Unknown keys pass through. */
export function herdrKindForCommand(command: string): string {
  if (command === 'dsh' || command === 'deepseek') return 'deepseek'
  return command
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
    const j = JSON.parse(stdout) as Record<string, unknown>
    const pane =
      j.pane_id ??
      j.paneId ??
      asRecord(j.pane)?.id ??
      asRecord(j.pane)?.pane_id ??
      (Array.isArray(asRecord(j.workspace)?.panes)
        ? asRecord((asRecord(j.workspace)?.panes as unknown[])[0])?.pane_id
        : undefined)
    if (typeof pane === 'string' && pane) return { paneId: pane }
  } catch {
    // fall through to the spike default
  }
  return { paneId: HERDR_DEFAULT_PANE }
}

export function parsePaneSize(stdout: string): { cols: number; rows: number } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  for (const row of rows) {
    const r = asRecord(row)
    if (!r) continue
    const inner = asRecord(r.size) ?? asRecord(r.geometry) ?? r
    const cols = Number(inner.cols ?? inner.width)
    const height = Number(inner.rows ?? inner.height)
    if (Number.isFinite(cols) && Number.isFinite(height) && cols >= 1 && height >= 1) {
      return { cols, rows: height }
    }
  }
  return undefined
}

export function parseHerdrVersion(out: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(out)
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

export function findHerdrOnPath(pathEnv?: string): string | null {
  return findOnPath('herdr', pathEnv ?? process.env.PATH ?? '')
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

export function createHerdrStatusHub(opts: {
  subscribe: (name: string, onEvent: (evt: unknown) => void, onClose: () => void) => () => void
  onFrame: (name: string, frame: HarnessStatusFrame) => void
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
    s.unsub = opts.subscribe(
      name,
      (evt) => {
        const frame = herdrStatusToFrame(evt, now)
        if (!frame) return
        const sessionId = (frame.sessionId || s.sessionId) as HarnessStatusFrame['sessionId']
        opts.onFrame(name, { ...frame, sessionId })
      },
      () => {
        // The child ended on its own: release its handle exactly once (the
        // real unsub kills an already-dead process and closes its pipes; a
        // second onClose from that kill must not schedule a second reconnect).
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
        const wait = backoff[Math.min(s.attempt, backoff.length - 1)] ?? 5000
        s.attempt += 1
        s.timer = setT(() => {
          s.timer = undefined
          start(name, s)
        }, wait)
      },
    )
    s.attempt = 0
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

export type HerdrChild = { kill: () => void }

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
  }
}

interface RivetMeta {
  command: string
  user: string
  paneId?: string
  created?: number
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

/** Block (without a shell and without spinning) until `path` exists or the
 *  deadline passes. `herdr --session <name> server` is a FOREGROUND daemon
 *  (verified on 0.8.2: it prints "herdr server running" and never returns),
 *  so create() spawns it detached and waits for the api socket instead of
 *  running it to completion. */
export function waitForSocketSync(path: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs
  const cell = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    Atomics.wait(cell, 0, 0, 100)
  }
  return existsSync(path)
}

/** HerdrCtl backed by the real herdr binary (absolute path). Every ctl call
 *  is execFileSync, no shell, with `XDG_CONFIG_HOME` pointed at the per-den
 *  config home so sockets never collide across dens. The session server is
 *  the one exception: a detached spawn (see waitForSocketSync). */
export function createRealHerdrCtl(
  binary: string,
  configHome: string,
  execFn: HerdrExec = execFileSync,
  spawnFn: HerdrSpawn = defaultSpawn,
  waitFn: (path: string, timeoutMs: number) => boolean = waitForSocketSync,
  connectFn: (path: string) => Duplex = (path) => createConnection(path),
): HerdrCtl {
  mkdirSync(configHome, { recursive: true, mode: 0o700 })
  const envFor = (): NodeJS.ProcessEnv => ({
    ...process.env,
    XDG_CONFIG_HOME: configHome,
  })

  const run = (args: string[], timeout = HERDR_CTL_MS): string | null => {
    try {
      return execFn(binary, args, {
        encoding: 'utf8',
        timeout,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: envFor(),
      })
    } catch (e) {
      const err = e as { status?: unknown; code?: unknown }
      if (typeof err.status === 'number' && err.status === 1) return null
      throw new HerdrUnavailableError(`herdr ctl failed (${args[0]}): ${String(e)}`)
    }
  }

  const listFresh = (): HerdrSessionInfo[] => {
    const root = join(configHome, 'herdr', 'sessions')
    const names = listSessionDirs(root)
    const nowSec = Math.floor(Date.now() / 1000)
    const out: HerdrSessionInfo[] = []
    for (const name of names) {
      if (!existsSync(herdrSocketPath(configHome, name))) continue
      const meta = readMeta(configHome, name)
      out.push({
        name,
        activity: nowSec,
        created: meta.created ?? nowSec,
        command: meta.command,
        user: meta.user,
        paneId: meta.paneId,
      })
    }
    return out
  }

  return {
    hasSession(name) {
      return existsSync(herdrSocketPath(configHome, name))
    },
    killSession(name) {
      try {
        run(herdrServerStopArgv(name).slice(1), 2000)
      } catch {
        // stop may throw unavailable — still try to remove the sock dir
      }
      try {
        rmSync(join(configHome, 'herdr', 'sessions', name), { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
    listSessions: listFresh,
    refresh() {
      // no memo today — list is a readdir
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
    create(opts) {
      mkdirSync(join(configHome, 'herdr', 'sessions', opts.name), { recursive: true, mode: 0o700 })
      const sock = herdrSocketPath(configHome, opts.name)
      spawnFn(binary, herdrServerArgv(opts.name).slice(1), { env: envFor(), detached: true })
      if (!waitFn(sock, HERDR_CREATE_MS)) {
        throw new HerdrUnavailableError(
          `herdr server did not open ${sock} within ${HERDR_CREATE_MS}ms for ${opts.name}`,
        )
      }
      try {
        const wsArgv = herdrWorkspaceCreateArgv(opts.name, opts.env, opts.cwd)
        const wsOut = run(wsArgv.slice(1), HERDR_CREATE_MS)
        if (wsOut === null) {
          throw new HerdrUnavailableError(`herdr workspace create failed for ${opts.name}`)
        }
        const { paneId } = parseWorkspaceCreate(wsOut)
        const agentArgv = herdrAgentStartArgv(
          opts.name,
          opts.name,
          opts.kind,
          paneId,
          opts.argv,
        )
        const agentOut = run(agentArgv.slice(1), HERDR_CREATE_MS)
        if (agentOut === null) {
          throw new HerdrUnavailableError(`herdr agent start failed for ${opts.name}`)
        }
        writeMeta(configHome, opts.name, {
          command: opts.command,
          user: opts.user,
          paneId,
          created: Math.floor(Date.now() / 1000),
        })
      } catch (e) {
        try {
          run(herdrServerStopArgv(opts.name).slice(1), 2000)
        } catch {
          // best-effort teardown of a half-created session
        }
        throw e
      }
    },
    attachArgv(name) {
      return herdrAttachArgv(name)
    },
    capture(name, lines) {
      const meta = readMeta(configHome, name)
      const target = meta.paneId ?? HERDR_DEFAULT_PANE
      try {
        const agent = run(herdrAgentReadArgv(name, target, lines).slice(1), 2000)
        if (agent !== null && agent.trim()) return agent
      } catch {
        // fall through to pane read
      }
      try {
        return run(herdrPaneReadArgv(name, target, lines).slice(1), 2000) ?? ''
      } catch {
        return ''
      }
    },
    subscribeEvents(name, onEvent, onClose) {
      // One socket per subscribed session: connect, send events.subscribe,
      // then deliver every `{event,data}` envelope. The ack and any RPC reply
      // (no `event` key) are skipped. Close/error → onClose (the hub
      // reconnects with backoff); unsub destroys the socket.
      const paneId = readMeta(configHome, name).paneId ?? 'w1:p1'
      const sock = connectFn(herdrSocketPath(configHome, name))
      let buf = ''
      let closed = false
      const finish = (): void => {
        if (closed) return
        closed = true
        onClose?.()
      }
      sock.on('connect', () => {
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
          if (isHerdrEventEnvelope(obj)) onEvent(obj)
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
