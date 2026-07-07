// PTY lifecycle manager: spawn roster commands, cap concurrency, ring-buffer
// scrollback, reap detached/exited PTYs, audit everything.
//
// Security posture (this is a shell as the service user behind a web page —
// every rule here is deliberate):
//   - only roster KEYS come in over HTTP; argv/cwd/env are operator-owned
//   - argv is spawned directly, never through a shell
//   - RIVET_DEN_SESSION / RIVET_DEN_TOKEN are OMITTED when empty — the hook
//     adapter treats an empty string as a real session id (S2 review)
//   - every spawn/kill/exit is appended to ${stateDir}/term-audit.log
//
// Attachment (attach(id, cb, onExit?)) feeds live output + the exit
// notification to a subscriber (the WS /term channel in term/ws.ts) and holds
// off the detached-TTL reaper while at least one subscriber is attached.

import { appendFileSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { DenConfig } from '../config.js'
import type { PtyProc, PtySpawn } from './pty.js'
import type { TermRoster } from './roster.js'

export class TermSpawnError extends Error {
  constructor(
    public readonly code: 'unknown-command' | 'cap',
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
  log: (msg: string) => void
  now?: () => number
}

export interface PtyInfo {
  id: string
  denSession: string
  command: string
  pid: number
  attached: number
  createdAt: number
  cols: number
  rows: number
  state: 'running' | 'exited'
  exitCode?: number | null
  lastOutputTs: number
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
  state: 'running' | 'exited'
  exitCode?: number | null
  detachTimer?: NodeJS.Timeout
  sigkillTimer?: NodeJS.Timeout
  reapTimer?: NodeJS.Timeout
  /** Ready-gate (seamless 5g): a chat inject that arrives before the harness
   *  TUI can accept stdin is dropped. We buffer injects until first output has
   *  settled, then flush — so the FIRST chat turn to a fresh harness lands. */
  ready: boolean
  injectBuffer: string[]
  readyTimer?: NodeJS.Timeout
}

export interface TermManager {
  /** Throws TermSpawnError ('unknown-command' → 404, 'cap' → 409). */
  spawn(
    rosterKey: string | undefined,
    cols: number,
    rows: number,
    remote: string,
    session?: string,
  ): PtyInfo
  list(): PtyInfo[]
  get(id: string): PtyInfo | undefined
  /** PTY id linked to a den session, while its record exists. */
  ptyForSession(denSession: string): string | undefined
  /** SIGHUP → SIGKILL(3s); exited records are reaped immediately. false = unknown id. */
  kill(id: string): boolean
  /** Subscribe to live output; cancels the detached-TTL reaper while at least
   *  one subscriber is attached. `onExit` (optional) fires once when the
   *  child exits, after the final output has fanned out. Returns a detach fn;
   *  null = unknown id. */
  attach(id: string, cb: DataSubscriber, onExit?: ExitSubscriber): (() => void) | null
  scrollback(id: string): Buffer | undefined
  write(id: string, data: string | Buffer): boolean
  /** Like write, but for chat injects: buffered until the harness TUI is
   *  ready (first output settled) so the first turn isn't dropped (5g). */
  inject(id: string, data: string | Buffer): boolean
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

/** Set an env var only when the value is non-empty. NEVER pass '' through:
 *  the hook adapter treats an empty RIVET_DEN_SESSION as a real session id. */
const setNonEmpty = (env: Record<string, string>, key: string, value: string): void => {
  if (value !== '') env[key] = value
}

export function createTermManager(config: DenConfig, deps: TermManagerDeps): TermManager {
  const now = deps.now ?? Date.now
  const records = new Map<string, PtyRecord>()
  const bySession = new Map<string, string>()
  const auditFile = join(config.stateDir, 'term-audit.log')
  mkdirSync(config.stateDir, { recursive: true })

  const audit = (
    action: 'spawn' | 'kill' | 'exit',
    r: PtyRecord,
    extra: Record<string, unknown> = {},
  ): void => {
    const line = {
      ts: now(),
      action,
      id: r.id,
      denSession: r.denSession,
      command: r.command,
      argv: r.argv,
      cwd: r.cwd,
      pid: r.pid,
      remote: r.remote,
      ...extra,
    }
    try {
      appendFileSync(auditFile, JSON.stringify(line) + '\n')
    } catch (e) {
      // an unwritable audit log must not take terminals down, but it must
      // never be silent either
      deps.log(`[den-server] term: FAILED to write audit log ${auditFile}: ${String(e)}`)
    }
  }

  const clearTimers = (r: PtyRecord): void => {
    for (const key of ['detachTimer', 'sigkillTimer', 'reapTimer', 'readyTimer'] as const) {
      const t = r[key]
      if (t) clearTimeout(t)
      r[key] = undefined
    }
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
    r.sigkillTimer.unref?.()
  }

  const armDetachedTtl = (r: PtyRecord): void => {
    if (r.state !== 'running' || r.attached.size > 0 || r.detachTimer) return
    r.detachTimer = setTimeout(() => {
      r.detachTimer = undefined
      if (r.attached.size === 0) {
        audit('kill', r, { reason: 'detached-ttl' })
        escalate(r)
      }
    }, config.term.detachedTtlMs)
    r.detachTimer.unref?.()
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
    return out
  }

  const onExit = (r: PtyRecord, exitCode: number | null): void => {
    if (r.state === 'exited') return
    r.state = 'exited'
    r.exitCode = exitCode
    clearTimers(r)
    audit('exit', r, { exitCode })
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
    r.reapTimer.unref?.()
  }

  return {
    spawn(rosterKey, cols, rows, remote, session): PtyInfo {
      // Spawn-or-get: a conversation's PTY is a singleton keyed by `session`.
      // Re-entering Terminal (or chat inject) for a live conversation reuses
      // the same harness rather than spawning a second (seamless modes).
      if (session) {
        // `task:` is the task engine's reserved conversation namespace
        // (ros_conversations.session_key) — a seamless chat session must not
        // collide with it (#311 review).
        if (!/^[a-zA-Z0-9:_.-]{1,120}$/.test(session) || session.startsWith('task:'))
          throw new TermSpawnError('unknown-command', `invalid session id: ${session}`)
        const existingId = bySession.get(session)
        const existing = existingId ? records.get(existingId) : undefined
        if (existing && existing.state === 'running') return info(existing)
      }
      const roster = deps.roster()
      const key = rosterKey ?? roster.default
      const entry = roster.commands[key] as (typeof roster.commands)[string] | undefined
      if (!entry) throw new TermSpawnError('unknown-command', `unknown command: ${key}`)
      const running = [...records.values()].filter((r) => r.state === 'running')
      if (running.length >= config.term.maxPtys) {
        // LRU pool (seamless 5g): at the cap, evict the least-recently-active
        // UNATTACHED pty so a new conversation can spawn. The evicted
        // conversation goes cold — its transcript is durable in memory and a
        // later open respawns it (spawn-or-get). A pty someone is watching
        // (attached) is never evicted; if every running pty is attached, the
        // cap is real. Brief maxPtys+1 until the victim exits is acceptable
        // for a soft cap.
        const victim = running
          .filter((r) => r.attached.size === 0)
          .sort((a, b) => a.lastOutputTs - b.lastOutputTs)[0]
        if (!victim)
          throw new TermSpawnError(
            'cap',
            `pty limit reached (${config.term.maxPtys}); all attached`,
          )
        audit('kill', victim, { reason: 'lru-evict' })
        escalate(victim)
      }

      const id = `pty-${randomBytes(4).toString('hex')}`
      // The conversation join key IS the den session, so den (?session), the
      // capture hooks (RIVETOS_SESSION_KEY), and this PTY all share one id.
      const denSession = session ?? `den-${id}`
      const cwd = entry.cwd ?? roster.cwd
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      Object.assign(env, roster.env, entry.env ?? {})
      setNonEmpty(env, 'RIVET_DEN_SESSION', denSession)
      // Capture hooks key the transcript on this — chat reads the same
      // conversation the terminal is running (seamless modes join key).
      if (session) setNonEmpty(env, 'RIVETOS_SESSION_KEY', session)
      setNonEmpty(env, 'RIVET_DEN_TOKEN', config.token)
      env.RIVET_DEN_URL = `http://127.0.0.1:${config.port}`
      env.RIVET_DEN_NAME = `${hostname()}:${key}`
      env.TERM = 'xterm-256color'
      env.COLORTERM = 'truecolor'

      const proc = deps.spawn(entry.cmd, { cwd, env, cols, rows })
      const r: PtyRecord = {
        id,
        denSession,
        command: key,
        room: entry.room,
        argv: entry.cmd,
        cwd,
        remote,
        pid: proc.pid,
        proc,
        scrollback: [],
        scrollbackSize: 0,
        attached: new Set(),
        exitWatchers: new Set(),
        createdAt: now(),
        cols,
        rows,
        lastOutputTs: now(),
        state: 'running',
        ready: false,
        injectBuffer: [],
      }
      records.set(id, r)
      bySession.set(denSession, id)
      proc.onData((data) => {
        r.lastOutputTs = now()
        // Ready-gate: on the FIRST output, wait a short settle for the TUI to
        // finish its initial render, then flush any buffered chat injects.
        if (!r.ready && !r.readyTimer) {
          r.readyTimer = setTimeout(() => {
            r.readyTimer = undefined
            r.ready = true
            for (const d of r.injectBuffer) r.proc.write(d)
            r.injectBuffer = []
          }, config.term.injectReadyMs ?? 500)
          r.readyTimer.unref?.()
        }
        appendScrollback(r, data)
        for (const cb of r.attached) cb(data)
      })
      proc.onExit((exitCode) => onExit(r, exitCode))
      audit('spawn', r)
      armDetachedTtl(r)
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

    list: () => [...records.values()].map(info),
    get: (id) => {
      const r = records.get(id)
      return r ? info(r) : undefined
    },
    ptyForSession: (denSession) => bySession.get(denSession),

    kill(id): boolean {
      const r = records.get(id)
      if (!r) return false
      if (r.state === 'exited') {
        reap(r)
        return true
      }
      audit('kill', r, { reason: 'request' })
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
      let detached = false
      return () => {
        if (detached) return
        detached = true
        r.attached.delete(cb)
        if (onExit) r.exitWatchers.delete(onExit)
        if (r.attached.size === 0) armDetachedTtl(r)
      }
    },

    scrollback(id) {
      const r = records.get(id)
      return r ? Buffer.concat(r.scrollback) : undefined
    },

    write(id, data): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      r.proc.write(data)
      return true
    },

    inject(id, data): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      // Ready-gate (5g): before the harness TUI is up, buffer instead of
      // writing into the void; the onData settle timer flushes it.
      if (r.ready) r.proc.write(data)
      else r.injectBuffer.push(typeof data === 'string' ? data : data.toString())
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
      for (const r of records.values()) {
        clearTimers(r)
        if (r.state === 'running') r.proc.kill('SIGHUP')
      }
      records.clear()
      bySession.clear()
    },
  }
}
