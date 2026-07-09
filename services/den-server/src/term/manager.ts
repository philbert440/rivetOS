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
  /** Does this harness already have an on-disk session with this id? Decides
   *  --resume vs --session-id on re-spawn (#318 review). Default: never. */
  sessionExists?: (command: string, id: string) => boolean
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
  injectBuffer: { text: string; submit: boolean }[]
  readyTimer?: NodeJS.Timeout
  /** Max(lastOutputTs, last inject) — the LRU-eviction signal. Bumped on BOTH
   *  stdout AND chat inject so an actively-chatted (but unattached) harness
   *  isn't evicted between a send and its reply (#316 review). */
  lastActivityTs: number
}

export interface TermManager {
  /** Throws TermSpawnError ('unknown-command' → 404, 'cap' → 409). */
  spawn(
    rosterKey: string | undefined,
    cols: number,
    rows: number,
    remote: string,
    session?: string,
    resume?: string,
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
   *  ready (first output settled) so the first turn isn't dropped (5g). When
   *  `submit`, the text and its CR are written as two separate PTY writes
   *  (bracketed paste + delayed CR) so the harness actually sends the turn. */
  inject(id: string, text: string, submit: boolean): boolean
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * How each harness pins/resumes a session id so the join key, its on-disk
 * store filename, and the drawer id are ALL the same value. Keyed on the
 * roster command. A new conversation spawns with `sessionFlag <id>` (forcing
 * the harness's native id = our join key); reopening a harness session spawns
 * with `resumeFlag <id>`. Ids must be valid UUIDs (Claude requires it for
 * --session-id), so RivetHub generates UUID conversation ids.
 */
const HARNESS_FLAGS: Record<string, { sessionFlag?: string; resumeFlag: string }> = {
  claude: { sessionFlag: '--session-id', resumeFlag: '--resume' },
  grok: { sessionFlag: '--session-id', resumeFlag: '--resume' },
  // Hermes can --resume an existing session but has NO flag to pin a NEW
  // session's id — so no sessionFlag: a fresh hermes chat gets its own id
  // (can't equal the join key), reopening resumes cleanly.
  hermes: { resumeFlag: '--resume' },
}

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

  const submitDelayMs = config.term.injectSubmitDelayMs ?? DEFAULT_INJECT_SUBMIT_DELAY_MS

  const laterWrite = (r: PtyRecord, data: string, atMs: number): void => {
    const fire = (): void => {
      if (r.state === 'running') r.proc.write(data)
    }
    if (atMs <= 0) {
      fire()
      return
    }
    const t = setTimeout(fire, atMs)
    t.unref?.()
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
    spawn(rosterKey, cols, rows, remote, session, resume): PtyInfo {
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
          .sort((a, b) => a.lastActivityTs - b.lastActivityTs)[0]
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

      // Harness session pinning/resume (seamless drawer): make the harness's
      // native session id equal our join key, so its on-disk store file and
      // the drawer id line up. Only for UUID ids (Claude requires it).
      const flags = HARNESS_FLAGS[key]
      let argv = entry.cmd
      if (flags) {
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

      const proc = deps.spawn(argv, { cwd, env, cols, rows })
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
        attached: new Set(),
        exitWatchers: new Set(),
        createdAt: now(),
        cols,
        rows,
        lastOutputTs: now(),
        state: 'running',
        ready: false,
        injectBuffer: [],
        lastActivityTs: now(),
      }
      records.set(id, r)
      bySession.set(denSession, id)
      proc.onData((data) => {
        r.lastOutputTs = now()
        r.lastActivityTs = now()
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
            r.injectBuffer.forEach((d, i) =>
              submitWrite(r, d.text, d.submit, i * submitDelayMs * 2),
            )
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

    inject(id, text, submit): boolean {
      const r = records.get(id)
      if (!r || r.state !== 'running') return false
      // Chat activity protects this pty from LRU eviction (#316 review): a
      // conversation being chatted is unattached (inject doesn't attach) but
      // must not be evicted between the send and the harness's reply.
      r.lastActivityTs = now()
      // Ready-gate (5g): before the harness TUI is up, buffer instead of
      // writing into the void; the onData settle timer flushes it.
      if (r.ready) {
        submitWrite(r, text, submit)
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
      for (const r of records.values()) {
        clearTimers(r)
        if (r.state === 'running') r.proc.kill('SIGHUP')
      }
      records.clear()
      bySession.clear()
    },
  }
}
