import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DenConfig, DenTermConfig } from '../config.js'
import { createTermManager, TermSpawnError, type TermManager } from './manager.js'
import { loadRealPtySpawn, type PtyProc, type PtySpawn, type PtySpawnOpts } from './pty.js'
import { createRosterProvider, defaultRoster, parseRoster, type TermRoster } from './roster.js'
import {
  createRealTmuxCtl,
  decodeTmuxName,
  encodeTmuxName,
  TmuxUnavailableError,
  TMUX_ENV_WRAP_SCRIPT,
  tmuxConfContent,
  tmuxSocketName,
  type TmuxCtl,
  type TmuxExec,
  type TmuxSessionInfo,
} from './tmux.js'

class FakeProc extends EventEmitter implements PtyProc {
  writes: string[] = []
  resizes: [number, number][] = []
  kills: (string | undefined)[] = []
  constructor(public pid: number) {
    super()
  }
  write(data: string | Buffer): void {
    this.writes.push(data.toString())
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(signal?: string): void {
    this.kills.push(signal)
  }
  onData(cb: (data: string | Buffer) => void): void {
    this.on('data', cb)
  }
  onExit(cb: (code: number | null) => void): void {
    this.on('exit', cb)
  }
  emitData(data: string | Buffer): void {
    this.emit('data', data)
  }
  emitExit(code: number | null): void {
    this.emit('exit', code)
  }
}

const dirs: string[] = []
const managers: TermManager[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  managers.splice(0).forEach((m) => m.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'den-term-'))
  dirs.push(dir)
  return dir
}

interface Harness {
  manager: TermManager
  procs: FakeProc[]
  spawns: { argv: string[]; opts: PtySpawnOpts }[]
  ingested: Record<string, unknown>[]
  stateDir: string
  logs: string[]
}

function makeManager(
  term: Partial<DenTermConfig> = {},
  extra: {
    token?: string
    port?: number
    roster?: TermRoster
    roomOpen?: (s: string) => boolean
    spawn?: PtySpawn
    sessionExists?: (command: string, id: string) => boolean
    tmuxCtl?: TmuxCtl
    writeEnvFile?: (path: string, body: string) => void
    modelSheetFor?: (
      command: string,
    ) =>
      | {
          models?: { id: string; label: string }[]
          efforts?: { id: string; label: string }[]
          modelFlag?: string
          effortFlag?: string
        }
      | undefined
  } = {},
): Harness {
  const stateDir = tmp()
  const config: DenConfig = {
    port: extra.port ?? 5199,
    host: '127.0.0.1',
    token: extra.token ?? '',
    tls: { certPath: '', keyPath: '', caPath: '', requireClientCert: true },
    stateDir,
    staticDir: '',
    evictTtlMs: 60_000,
    meshFile: '',
    meshCacheMs: 10_000,
    term: {
      enabled: true,
      open: false,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      idleTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      // Pinned: the pre-T1 tests below assert the direct-spawn path
      // byte-for-byte; tmux behavior has its own describe block.
      mux: 'none',
      ...term,
    },
    audio: {
      enabled: false,
      open: false,
      dir: '',
      deviceName: 'RivetHub Mic',
      sampleRate: 16_000,
    },
  }
  const procs: FakeProc[] = []
  const spawns: { argv: string[]; opts: PtySpawnOpts }[] = []
  let pid = 1000
  const fakeSpawn: PtySpawn = (argv, opts) => {
    const proc = new FakeProc(++pid)
    procs.push(proc)
    spawns.push({ argv, opts })
    return proc
  }
  const ingested: Record<string, unknown>[] = []
  const logs: string[] = []
  const manager = createTermManager(config, {
    spawn: extra.spawn ?? fakeSpawn,
    roster: () => extra.roster ?? defaultRoster(),
    ingest: (ev) => ingested.push(ev),
    roomOpen: extra.roomOpen,
    sessionExists: extra.sessionExists,
    tmuxCtl: extra.tmuxCtl,
    writeEnvFile: extra.writeEnvFile,
    modelSheetFor: extra.modelSheetFor,
    log: (m) => logs.push(m),
  })
  managers.push(manager)
  return { manager, procs, spawns, ingested, stateDir, logs }
}

describe('term manager', () => {
  it('spawns roster commands with den env injected', () => {
    const { manager, spawns } = makeManager({}, { token: 'sekrit', port: 5199 })
    const pty = manager.spawn('claude', 120, 40, '127.0.0.1')
    expect(pty.id).toMatch(/^pty-[0-9a-f]{8}$/)
    expect(pty.denSession).toBe(`den-${pty.id}`)
    expect(pty.command).toBe('claude')
    expect(pty.state).toBe('running')
    expect(spawns[0].argv).toEqual(['claude'])
    expect(spawns[0].opts.cols).toBe(120)
    expect(spawns[0].opts.rows).toBe(40)
    const env = spawns[0].opts.env
    expect(env.RIVET_DEN_SESSION).toBe(pty.denSession)
    expect(env.RIVET_DEN_TOKEN).toBe('sekrit')
    expect(env.RIVET_DEN_URL).toBe('http://127.0.0.1:5199')
    expect(env.RIVET_DEN_NAME).toBe(`${hostname()}:claude`)
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    // linkage map — get() resolves the den-session alias too (same as kill)
    expect(manager.ptyForSession(pty.denSession)).toBe(pty.id)
    expect(manager.get(pty.denSession)?.id).toBe(pty.id)
  })

  it('appends model/effort flags from the sheet and omits unknown / no-flag', () => {
    const fake = {
      models: [{ id: 'fable', label: 'Fable' }],
      efforts: [{ id: 'high', label: 'High' }],
      modelFlag: '--model',
      effortFlag: '--effort',
    }
    const listed = makeManager({}, { modelSheetFor: () => fake })
    listed.manager.spawn(
      'claude',
      80,
      24,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      'fable',
      'high',
    )
    expect(listed.spawns[0].argv).toEqual(['claude', '--model', 'fable', '--effort', 'high'])

    const unknown = makeManager({}, { modelSheetFor: () => fake })
    unknown.manager.spawn(
      'claude',
      80,
      24,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      'nope',
      'nope',
    )
    expect(unknown.spawns[0].argv).toEqual(['claude'])

    const noFlag = makeManager(
      {},
      {
        modelSheetFor: () => ({
          models: [{ id: 'x', label: 'X' }],
          efforts: [{ id: 'y', label: 'Y' }],
        }),
      },
    )
    noFlag.manager.spawn('claude', 80, 24, '', undefined, undefined, undefined, undefined, 'x', 'y')
    expect(noFlag.spawns[0].argv).toEqual(['claude'])
  })

  it('session join key: denSession IS the session, RIVETOS_SESSION_KEY set, spawn-or-get', () => {
    const { manager, spawns } = makeManager({}, { token: 'sekrit', port: 5199 })
    const a = manager.spawn('claude', 80, 24, '127.0.0.1', 'chat-20260707-abcd')
    expect(a.denSession).toBe('chat-20260707-abcd')
    expect(spawns[0].opts.env.RIVET_DEN_SESSION).toBe('chat-20260707-abcd')
    expect(spawns[0].opts.env.RIVETOS_SESSION_KEY).toBe('chat-20260707-abcd')
    expect(manager.ptyForSession('chat-20260707-abcd')).toBe(a.id)

    // spawn-or-get: same session returns the SAME pty, no second spawn
    const b = manager.spawn('claude', 80, 24, '127.0.0.1', 'chat-20260707-abcd')
    expect(b.id).toBe(a.id)
    expect(spawns.length).toBe(1)
  })

  it('rejects a malformed session id', () => {
    const { manager } = makeManager({})
    expect(() => manager.spawn('claude', 80, 24, '', 'bad session id!')).toThrow(/invalid session/)
  })

  it('harness flags (#318): UUID session → --session-id (new) or --resume (existing/resume)', () => {
    const uuid = '11111111-1111-1111-1111-111111111111'
    // no store file → new session, pin the id
    const fresh = makeManager({}, { sessionExists: () => false })
    fresh.manager.spawn('claude', 80, 24, '', uuid)
    expect(fresh.spawns[0].argv).toEqual(['claude', '--session-id', uuid])

    // store file exists (re-spawn after eviction) → resume it, keep context
    const evicted = makeManager({}, { sessionExists: () => true })
    evicted.manager.spawn('claude', 80, 24, '', uuid)
    expect(evicted.spawns[0].argv).toEqual(['claude', '--resume', uuid])

    // explicit resume always wins
    const reopen = makeManager({}, { sessionExists: () => false })
    reopen.manager.spawn('claude', 80, 24, '', uuid, uuid)
    expect(reopen.spawns[0].argv).toEqual(['claude', '--resume', uuid])

    // grok gets the same flags (it also has --session-id/--resume). The
    // session/resume flag appends AFTER the roster's base argv, which now
    // carries the auto-approve flags (--permission-mode bypassPermissions).
    const grokBase = ['grok', '--permission-mode', 'bypassPermissions']
    const grokNew = makeManager({}, { sessionExists: () => false })
    grokNew.manager.spawn('grok', 80, 24, '', uuid)
    expect(grokNew.spawns[0].argv).toEqual([...grokBase, '--session-id', uuid])
    const grokResume = makeManager({}, { sessionExists: () => true })
    grokResume.manager.spawn('grok', 80, 24, '', uuid)
    expect(grokResume.spawns[0].argv).toEqual([...grokBase, '--resume', uuid])

    // hermes: --resume only (no sessionFlag). A new session (not in the
    // store) gets NO session flag — hermes can't pin an id; an existing one
    // resumes, and hermes ids need not be UUIDs. Its base argv carries the
    // auto-approve flags (--yolo --accept-hooks).
    const hermesBase = ['hermes', '--yolo', '--accept-hooks']
    const hermesNew = makeManager({}, { sessionExists: () => false })
    hermesNew.manager.spawn('hermes', 80, 24, '', uuid)
    expect(hermesNew.spawns[0].argv).toEqual(hermesBase)
    const hermesResume = makeManager({}, { sessionExists: () => true })
    hermesResume.manager.spawn('hermes', 80, 24, '', 'sess_abc123')
    expect(hermesResume.spawns[0].argv).toEqual([...hermesBase, '--resume', 'sess_abc123'])

    // dsh: --resume only (no sessionFlag), after the roster's `--profile tui`.
    // Fresh spawn stays `dsh --profile tui`; an existing native id resumes.
    const dshBase = ['dsh', '--profile', 'tui']
    const dshNew = makeManager({}, { sessionExists: () => false })
    dshNew.manager.spawn('dsh', 80, 24, '', uuid)
    expect(dshNew.spawns[0].argv).toEqual(dshBase)
    const dshResume = makeManager({}, { sessionExists: () => true })
    dshResume.manager.spawn('dsh', 80, 24, '', 'session-86ffe759-cd7b-49a7-955d-c282631a935d')
    expect(dshResume.spawns[0].argv).toEqual([
      ...dshBase,
      '--resume',
      'session-86ffe759-cd7b-49a7-955d-c282631a935d',
    ])

    // a non-harness command gets no flags; a claude non-UUID that isn't in the
    // store gets no flag either (no --session-id on a non-UUID).
    const shell = makeManager({})
    shell.manager.spawn('shell', 80, 24, '', uuid)
    expect(shell.spawns[0].argv).toEqual(['bash', '-l'])
    const nonUuid = makeManager({}, { sessionExists: () => false })
    nonUuid.manager.spawn('claude', 80, 24, '', 'chat-20260707-abcd')
    expect(nonUuid.spawns[0].argv).toEqual(['claude'])
  })

  it('OMITS RIVET_DEN_TOKEN entirely when the token is empty', () => {
    // an empty-string token would be read by the hook adapter as a real
    // value — the key must be absent, not ''
    const { manager, spawns } = makeManager({}, { token: '' })
    manager.spawn('shell', 80, 24, '')
    expect('RIVET_DEN_TOKEN' in spawns[0].opts.env).toBe(false)
    expect(spawns[0].opts.env.RIVET_DEN_SESSION).not.toBe('')
  })

  it('layers roster env over service env, entry env over roster env', () => {
    const roster: TermRoster = {
      default: 'x',
      cwd: '/tmp',
      env: { LAYER_A: 'roster', LAYER_B: 'roster' },
      commands: {
        x: { label: 'X', cmd: ['x'], room: false, cwd: '/', env: { LAYER_B: 'entry' } },
      },
    }
    const { manager, spawns } = makeManager({}, { roster })
    manager.spawn('x', 80, 24, '')
    expect(spawns[0].opts.env.LAYER_A).toBe('roster')
    expect(spawns[0].opts.env.LAYER_B).toBe('entry')
    expect(spawns[0].opts.cwd).toBe('/') // entry cwd overrides roster cwd
    // inherited service env still present
    expect(spawns[0].opts.env.PATH).toBe(process.env.PATH)
  })

  it('404s unknown keys; an exited pty frees its slot while its record lingers', () => {
    const { manager, procs } = makeManager({ maxPtys: 2 })
    manager.spawn('shell', 80, 24, '')
    manager.spawn('shell', 80, 24, '')
    expect(() => manager.spawn('nope', 80, 24, '')).toThrowError(/unknown command/)
    procs[0].emitExit(0)
    expect(manager.spawn('shell', 80, 24, '').state).toBe('running')
  })

  // ready() drives a pty past its ready-gate: emit output, fire the settle
  // timer. Only ready + idle ptys are LRU-evictable.
  const makeReady = (proc: FakeProc): void => {
    proc.emitData('booted')
    vi.advanceTimersByTime(600)
  }

  it('LRU pool (5g): at the cap, evicts the least-recently-ACTIVE idle pty', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ maxPtys: 2, injectReadyMs: 500 })
    manager.spawn('shell', 80, 24, '') // proc[0] — oldest activity
    makeReady(procs[0])
    vi.advanceTimersByTime(10)
    manager.spawn('shell', 80, 24, '') // proc[1] — more recent
    makeReady(procs[1])
    vi.advanceTimersByTime(10)
    // both ready + idle + unattached → 3rd evicts the LRU (proc[0])
    expect(manager.spawn('shell', 80, 24, '').state).toBe('running')
    expect(procs[0].kills).toContain('SIGHUP') // oldest activity evicted
    expect(procs[1].kills).toEqual([])
  })

  it('LRU pool: chat inject protects an unattached harness from eviction (#316)', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ maxPtys: 2, injectReadyMs: 500 })
    const a = manager.spawn('shell', 80, 24, '', 'chat-a') // oldest
    makeReady(procs[0])
    vi.advanceTimersByTime(10)
    const b = manager.spawn('shell', 80, 24, '', 'chat-b')
    makeReady(procs[1])
    vi.advanceTimersByTime(10)
    // a is older, but the user just chatted it → inject bumps its activity
    manager.inject(a.id, 'still here', true)
    void b
    // now b is the least-recently-active → b is evicted, a is protected
    expect(manager.spawn('shell', 80, 24, '').state).toBe('running')
    expect(procs[0].kills).toEqual([]) // a protected by chat activity
    expect(procs[1].kills).toContain('SIGHUP') // b evicted
  })

  it('LRU pool: never evicts attached / booting ptys; cap is real when all active', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ maxPtys: 2, injectReadyMs: 500 })
    const a = manager.spawn('shell', 80, 24, '')
    makeReady(procs[0])
    const b = manager.spawn('shell', 80, 24, '')
    makeReady(procs[1])
    manager.attach(a.id, () => {}) // watched
    manager.attach(b.id, () => {}) // watched
    expect(() => manager.spawn('shell', 80, 24, '')).toThrowError(/all active/)
    expect(procs[0].kills).toEqual([])
    expect(procs[1].kills).toEqual([])
  })

  it('inject buffer is bounded before ready (#316)', () => {
    const { manager } = makeManager({ injectReadyMs: 500 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-cap')
    // 32 buffered ok, 33rd rejected (no output yet → never ready)
    for (let i = 0; i < 32; i++) expect(manager.inject(pty.id, String(i), true)).toBe(true)
    expect(manager.inject(pty.id, 'overflow', true)).toBe(false)
  })

  it('inject ready-gate (5g): buffers until first output settles, then flushes', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ injectReadyMs: 300, injectSubmitDelayMs: 80 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-r')
    // inject before any output → buffered, not written
    expect(manager.inject(pty.id, 'hello', true)).toBe(true)
    expect(procs[0].writes).toEqual([])
    // first output starts the settle timer; still buffered until it fires
    procs[0].emitData('welcome to claude')
    expect(procs[0].writes).toEqual([])
    vi.advanceTimersByTime(300)
    // flushed after settle: text as one bracketed-paste write, then the submit
    // CR as a SEPARATE delayed write (a fused CR is swallowed as a newline).
    expect(procs[0].writes).toEqual(['\x1b[200~hello\x1b[201~'])
    vi.advanceTimersByTime(80)
    expect(procs[0].writes).toEqual(['\x1b[200~hello\x1b[201~', '\r'])
    // a ready-path inject arriving right behind the prior turn serializes after
    // its CR (+one gap) instead of racing its paste ahead — not immediate.
    manager.inject(pty.id, 'again', true)
    expect(procs[0].writes).toEqual(['\x1b[200~hello\x1b[201~', '\r'])
    vi.advanceTimersByTime(80)
    expect(procs[0].writes).toEqual(['\x1b[200~hello\x1b[201~', '\r', '\x1b[200~again\x1b[201~'])
    vi.advanceTimersByTime(80)
    expect(procs[0].writes).toEqual([
      '\x1b[200~hello\x1b[201~',
      '\r',
      '\x1b[200~again\x1b[201~',
      '\r',
    ])
  })

  it('ready-path injects serialize: two turns within one delay keep paste/CR pairs', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ injectReadyMs: 10, injectSubmitDelayMs: 80 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-ser')
    procs[0].emitData('welcome')
    vi.advanceTimersByTime(10) // ready, empty buffer
    // two submit injects back-to-back (parallel clients / no send lock)
    manager.inject(pty.id, 'A', true)
    manager.inject(pty.id, 'B', true)
    vi.advanceTimersByTime(400) // drain the serialized chain
    expect(procs[0].writes).toEqual(['\x1b[200~A\x1b[201~', '\r', '\x1b[200~B\x1b[201~', '\r'])
  })

  it('interrupt inject: Esc lands immediately, paste waits out the settle', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ injectReadyMs: 10, injectSubmitDelayMs: 80 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-int')
    procs[0].emitData('welcome')
    vi.advanceTimersByTime(10) // ready
    manager.inject(pty.id, 'do this instead', true, true)
    // the lone Esc cancels the in-flight turn NOW; nothing else yet
    expect(procs[0].writes).toEqual(['\x1b'])
    // paste holds for the TUI's cancel redraw (400ms settle), then CR
    vi.advanceTimersByTime(400)
    expect(procs[0].writes).toEqual(['\x1b', '\x1b[200~do this instead\x1b[201~'])
    vi.advanceTimersByTime(80)
    expect(procs[0].writes).toEqual(['\x1b', '\x1b[200~do this instead\x1b[201~', '\r'])
  })

  it('interrupt inject queues its Esc behind a prior turn in flight (grok review #338)', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ injectReadyMs: 10, injectSubmitDelayMs: 80 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-int2')
    procs[0].emitData('welcome')
    vi.advanceTimersByTime(10) // ready
    manager.inject(pty.id, 'A', true) // paste now, CR at +80, watermark +160
    manager.inject(pty.id, 'B', true, true) // interrupt while A's chain pends
    // Esc must NOT land between A's paste and its CR — that would wipe A's
    // input (TUI Esc clears the composer) and its CR would submit nothing.
    expect(procs[0].writes).toEqual(['\x1b[200~A\x1b[201~'])
    vi.advanceTimersByTime(80)
    expect(procs[0].writes).toEqual(['\x1b[200~A\x1b[201~', '\r'])
    vi.advanceTimersByTime(80) // watermark: Esc after A's full chain
    expect(procs[0].writes).toEqual(['\x1b[200~A\x1b[201~', '\r', '\x1b'])
    vi.advanceTimersByTime(400) // settle → B's paste
    expect(procs[0].writes).toEqual(['\x1b[200~A\x1b[201~', '\r', '\x1b', '\x1b[200~B\x1b[201~'])
    vi.advanceTimersByTime(80)
    expect(procs[0].writes).toEqual([
      '\x1b[200~A\x1b[201~',
      '\r',
      '\x1b',
      '\x1b[200~B\x1b[201~',
      '\r',
    ])
  })

  it('kill/close cancels a pending submit CR (no write into a dead PTY)', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ injectReadyMs: 10, injectSubmitDelayMs: 80 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-kill')
    procs[0].emitData('welcome')
    vi.advanceTimersByTime(10)
    manager.inject(pty.id, 'hi', true) // paste now, CR scheduled at +80
    expect(procs[0].writes).toEqual(['\x1b[200~hi\x1b[201~'])
    manager.close() // SIGHUP + clear timers before the CR fires
    vi.advanceTimersByTime(200)
    expect(procs[0].writes).toEqual(['\x1b[200~hi\x1b[201~']) // CR was canceled
  })

  it('inject ready-gate: multiple buffered turns flush in text→CR→text→CR order', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ injectReadyMs: 300, injectSubmitDelayMs: 80 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-multi')
    expect(manager.inject(pty.id, 'one', true)).toBe(true)
    expect(manager.inject(pty.id, 'two', true)).toBe(true)
    procs[0].emitData('welcome')
    vi.advanceTimersByTime(300) // settle → first turn's paste (staggered base 0)
    vi.advanceTimersByTime(400) // drain all staggered CR/paste timers
    // second turn's paste must not precede the first turn's submit CR
    expect(procs[0].writes).toEqual(['\x1b[200~one\x1b[201~', '\r', '\x1b[200~two\x1b[201~', '\r'])
  })

  it('caps scrollback at the byte limit, dropping the oldest bytes', () => {
    const { manager, procs } = makeManager({ scrollbackBytes: 16 })
    const pty = manager.spawn('shell', 80, 24, '')
    procs[0].emitData('aaaaaaaaaa') // 10
    procs[0].emitData('bbbbbbbbbb') // 10 → 20 → trim 4 oldest
    expect(manager.scrollback(pty.id)?.toString()).toBe('aaaaaabbbbbbbbbb')
    procs[0].emitData('c'.repeat(40)) // single chunk over cap → keep its tail
    expect(manager.scrollback(pty.id)?.toString()).toBe('c'.repeat(16))
  })

  it('fans out live data to attached subscribers; detach re-arms the reaper', () => {
    const { manager, procs } = makeManager()
    const pty = manager.spawn('shell', 80, 24, '')
    const seen: string[] = []
    const detach = manager.attach(pty.id, (d) => seen.push(d.toString()))
    expect(detach).not.toBeNull()
    procs[0].emitData('hello')
    expect(seen).toEqual(['hello'])
    expect(manager.get(pty.id)?.attached).toBe(1)
    detach!()
    procs[0].emitData('later')
    expect(seen).toEqual(['hello'])
    expect(manager.attach('pty-missing', () => {})).toBeNull()
  })

  it('kills a detached pty after the TTL: SIGHUP then SIGKILL', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ detachedTtlMs: 1000, idleTtlMs: 0 })
    manager.spawn('shell', 80, 24, '')
    vi.advanceTimersByTime(999)
    expect(procs[0].kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(procs[0].kills).toEqual(['SIGHUP'])
    vi.advanceTimersByTime(3000)
    expect(procs[0].kills).toEqual(['SIGHUP', 'SIGKILL'])
  })

  it('attach holds off the detached-TTL kill; detach restarts it', () => {
    vi.useFakeTimers()
    // idle off so this test only measures the detached reaper
    const { manager, procs } = makeManager({ detachedTtlMs: 1000, idleTtlMs: 0 })
    const pty = manager.spawn('shell', 80, 24, '')
    const detach = manager.attach(pty.id, () => {})!
    vi.advanceTimersByTime(5000)
    expect(procs[0].kills).toEqual([]) // attached — no reaper
    detach()
    vi.advanceTimersByTime(1000)
    expect(procs[0].kills).toEqual(['SIGHUP'])
  })

  it('kills an idle pty after idleTtlMs when nobody is attached', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ idleTtlMs: 1000, detachedTtlMs: 60_000 })
    manager.spawn('shell', 80, 24, '')
    vi.advanceTimersByTime(999)
    expect(procs[0].kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(procs[0].kills).toEqual(['SIGHUP'])
  })

  it('an attached viewer suspends the idle TTL; the last detach restarts a full window', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ idleTtlMs: 1000, detachedTtlMs: 60_000 })
    const pty = manager.spawn('shell', 80, 24, '')
    const detachA = manager.attach(pty.id, () => {})!
    const detachB = manager.attach(pty.id, () => {})!
    // Quiet for many idle windows with a viewer open — must NOT be reaped
    // (this was the RivetHub "[process exited 129]" report: harness SIGHUP'd
    // out from under an open terminal tab after 30 quiet minutes).
    vi.advanceTimersByTime(10_000)
    expect(procs[0].kills).toEqual([])
    detachA()
    vi.advanceTimersByTime(10_000)
    expect(procs[0].kills).toEqual([]) // one viewer still attached
    detachB()
    // Last detach: idle window restarts from now, NOT from the stale
    // lastActivityTs — closing a tab on a long-quiet harness must not kill it
    // on the spot (that is the detached-TTL's job, 60s here).
    vi.advanceTimersByTime(999)
    expect(procs[0].kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(procs[0].kills).toEqual(['SIGHUP'])
  })

  it('activity while attached re-arms idle; the last detach still restarts a full window', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ idleTtlMs: 1000, detachedTtlMs: 60_000 })
    const pty = manager.spawn('shell', 80, 24, '')
    const detach = manager.attach(pty.id, () => {})!
    vi.advanceTimersByTime(5000) // quiet while attached — timer was cleared on attach
    expect(manager.write(pty.id, 'x')).toBe(true) // re-arms a timer while attached
    vi.advanceTimersByTime(5000) // fires, sees a viewer → suspends, still alive
    expect(procs[0].kills).toEqual([])
    detach()
    vi.advanceTimersByTime(999)
    expect(procs[0].kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(procs[0].kills).toEqual(['SIGHUP'])
  })

  it('re-attaching before the restarted idle window elapses suspends it again', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ idleTtlMs: 1000, detachedTtlMs: 60_000 })
    const pty = manager.spawn('shell', 80, 24, '')
    manager.attach(pty.id, () => {})!()
    vi.advanceTimersByTime(900)
    manager.attach(pty.id, () => {}) // back before the window closes
    vi.advanceTimersByTime(10_000)
    expect(procs[0].kills).toEqual([])
  })

  it('activity (inject / write / output) re-arms the idle TTL', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ idleTtlMs: 1000, detachedTtlMs: 60_000 })
    const pty = manager.spawn('shell', 80, 24, '')
    vi.advanceTimersByTime(800)
    expect(manager.inject(pty.id, 'hello', true)).toBe(true) // re-arms
    vi.advanceTimersByTime(800)
    expect(procs[0].kills).toEqual([]) // still within 1s of inject
    expect(manager.write(pty.id, 'x')).toBe(true)
    vi.advanceTimersByTime(800)
    expect(procs[0].kills).toEqual([])
    procs[0].emitData('reply') // output re-arms
    vi.advanceTimersByTime(800)
    expect(procs[0].kills).toEqual([])
    vi.advanceTimersByTime(200)
    expect(procs[0].kills).toEqual(['SIGHUP'])
  })

  it('idleTtlMs 0 disables activity-based auto-close', () => {
    vi.useFakeTimers()
    // Detached reaper off (attach) so only idle would kill — and idle is 0/off.
    const { manager, procs } = makeManager({ idleTtlMs: 0, detachedTtlMs: 1_000 })
    const pty = manager.spawn('shell', 80, 24, '')
    manager.attach(pty.id, () => {})
    vi.advanceTimersByTime(60_000)
    expect(procs[0].kills).toEqual([])
  })

  it('skips the SIGKILL escalation when the child dies from SIGHUP', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager()
    const pty = manager.spawn('shell', 80, 24, '')
    manager.kill(pty.id)
    expect(procs[0].kills).toEqual(['SIGHUP'])
    procs[0].emitExit(null) // child obeyed the SIGHUP
    vi.advanceTimersByTime(10_000)
    expect(procs[0].kills).toEqual(['SIGHUP']) // no SIGKILL after exit
  })

  it('keeps exited records for exitLingerMs, then reaps', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ exitLingerMs: 5000 })
    const pty = manager.spawn('shell', 80, 24, '')
    procs[0].emitExit(3)
    expect(manager.get(pty.id)).toMatchObject({ state: 'exited', exitCode: 3 })
    expect(manager.ptyForSession(pty.denSession)).toBe(pty.id) // still linked
    vi.advanceTimersByTime(5000)
    expect(manager.get(pty.id)).toBeUndefined()
    expect(manager.ptyForSession(pty.denSession)).toBeUndefined()
    expect(manager.list()).toEqual([])
  })

  it('respawn same session during linger: reaping the old pty keeps the new alias (#311)', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ exitLingerMs: 5000 })
    const a = manager.spawn('shell', 80, 24, '', 'chat-foo')
    procs[0].emitExit(0) // A exits, lingers
    // spawn-or-get falls through (A is exited) and spawns B under the same key
    const b = manager.spawn('shell', 80, 24, '', 'chat-foo')
    expect(b.id).not.toBe(a.id)
    expect(manager.ptyForSession('chat-foo')).toBe(b.id)
    // A's linger reap must NOT delete the alias now pointing at the live B
    vi.advanceTimersByTime(5000)
    expect(manager.get(a.id)).toBeUndefined()
    expect(manager.ptyForSession('chat-foo')).toBe(b.id)
  })

  it('kill() on an exited-but-lingering record reaps it immediately', () => {
    const { manager, procs } = makeManager()
    const pty = manager.spawn('shell', 80, 24, '')
    procs[0].emitExit(0)
    expect(manager.kill(pty.id)).toBe(true)
    expect(manager.get(pty.id)).toBeUndefined()
    expect(manager.kill(pty.id)).toBe(false) // unknown now
  })

  it('self-ingests session.start on spawn and session.end on exit for room:true ptys', () => {
    const { manager, procs, ingested } = makeManager({}, { roomOpen: () => true })
    const pty = manager.spawn('claude', 80, 24, '')
    // the room exists immediately — harness hooks only fire on the first
    // prompt, which needs a window with a terminal to type into
    expect(ingested).toHaveLength(1)
    expect(ingested[0]).toMatchObject({
      v: 1,
      session: pty.denSession,
      type: 'session.start',
      title: 'Claude Code',
      harness: 'rivetos',
    })
    procs[0].emitExit(1)
    expect(ingested).toHaveLength(2)
    expect(ingested[1]).toMatchObject({
      v: 1,
      session: pty.denSession,
      type: 'session.end',
      harness: 'rivetos',
    })
    expect(typeof ingested[1].ts).toBe('number')
  })

  it('never ingests synthetic events for room:false (shell) ptys', () => {
    const { manager, procs, ingested } = makeManager({}, { roomOpen: () => true })
    manager.spawn('shell', 80, 24, '')
    procs[0].emitExit(0)
    expect(ingested).toEqual([])
  })

  it('skips the synthetic session.end when the room already ended (or never existed)', () => {
    const { manager, procs, ingested } = makeManager({}, { roomOpen: () => false })
    manager.spawn('claude', 80, 24, '')
    procs[0].emitExit(0)
    // only the spawn-time session.start; no end for a room that closed already
    expect(ingested).toHaveLength(1)
    expect(ingested[0].type).toBe('session.start')
  })

  it('does not clone RIVETOS_USER_DBS into the PTY env (#564)', () => {
    const prevDbs = process.env.RIVETOS_USER_DBS
    const prevAdmin = process.env.RIVETOS_TEAM_PG_ADMIN_URL
    process.env.RIVETOS_USER_DBS = '{"coco":{"pgUrl":"postgres://coco@db/coco"}}'
    process.env.RIVETOS_TEAM_PG_ADMIN_URL = 'postgres://admin@db/postgres'
    try {
      const { manager, spawns } = makeManager()
      manager.spawn('shell', 80, 24, '')
      expect(spawns[0].opts.env.RIVETOS_USER_DBS).toBeUndefined()
      expect(spawns[0].opts.env.RIVETOS_TEAM_PG_ADMIN_URL).toBeUndefined()
    } finally {
      if (prevDbs === undefined) delete process.env.RIVETOS_USER_DBS
      else process.env.RIVETOS_USER_DBS = prevDbs
      if (prevAdmin === undefined) delete process.env.RIVETOS_TEAM_PG_ADMIN_URL
      else process.env.RIVETOS_TEAM_PG_ADMIN_URL = prevAdmin
    }
  })

  it('refuses to reuse a live session across users', () => {
    const { manager } = makeManager()
    manager.spawn('shell', 80, 24, '', 'chat-x', undefined, undefined, 'phil')
    expect(() =>
      manager.spawn('shell', 80, 24, '', 'chat-x', undefined, undefined, 'coco'),
    ).toThrowError(/owned by another user/)
  })

  it('writes parseable audit lines for spawn, kill and exit', () => {
    const { manager, procs, stateDir } = makeManager()
    const pty = manager.spawn('shell', 80, 24, '192.0.2.7')
    manager.kill(pty.id)
    procs[0].emitExit(129)
    const lines = readFileSync(join(stateDir, 'term-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map((l) => l.action)).toEqual(['spawn', 'kill', 'exit'])
    for (const line of lines) {
      expect(line).toMatchObject({
        id: pty.id,
        denSession: pty.denSession,
        command: 'shell',
        argv: ['bash', '-l'],
        pid: pty.pid,
        remote: '192.0.2.7',
      })
      expect(typeof line.ts).toBe('number')
      expect(typeof line.cwd).toBe('string')
    }
    expect(lines[2].exitCode).toBe(129)
    // owner spawn: no routed identity, and the audit line must not carry one
    for (const line of lines) expect(line.routedUser).toBeUndefined()
  })

  it('stamps the routed user into audit lines and PtyInfo; owner stays unstamped', () => {
    const { manager, procs, stateDir } = makeManager()
    const routed = manager.spawn(
      'shell',
      80,
      24,
      '192.0.2.7',
      'chat-r',
      undefined,
      undefined,
      'coco',
    )
    expect(routed.routedUser).toBe('coco')
    expect(manager.get(routed.id)?.routedUser).toBe('coco')
    expect(manager.list().find((p) => p.id === routed.id)?.routedUser).toBe('coco')
    const owner = manager.spawn('shell', 80, 24, '192.0.2.8')
    expect(owner.routedUser).toBeUndefined()
    expect('routedUser' in manager.get(owner.id)!).toBe(false)
    manager.kill(routed.id)
    procs[0].emitExit(129)
    const lines = readFileSync(join(stateDir, 'term-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const routedLines = lines.filter((l) => l.id === routed.id)
    expect(routedLines.map((l) => l.action)).toEqual(['spawn', 'kill', 'exit'])
    for (const line of routedLines) expect(line.routedUser).toBe('coco')
    const ownerSpawn = lines.find((l) => l.id === owner.id)
    expect(ownerSpawn).toBeDefined()
    expect('routedUser' in ownerSpawn!).toBe(false)
  })

  it('write/resize reach the pty while running, and are refused after exit', () => {
    const { manager, procs } = makeManager()
    const pty = manager.spawn('shell', 80, 24, '')
    expect(manager.write(pty.id, 'ls\r')).toBe(true)
    expect(manager.resize(pty.id, 100, 50)).toBe(true)
    expect(procs[0].writes).toEqual(['ls\r'])
    expect(procs[0].resizes).toEqual([[100, 50]])
    procs[0].emitExit(0)
    expect(manager.write(pty.id, 'x')).toBe(false)
    expect(manager.resize(pty.id, 80, 24)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tmux mux (T1): fake TmuxCtl — unit tests never spawn a real tmux.
// ---------------------------------------------------------------------------

class FakeTmuxCtl implements TmuxCtl {
  sessions = new Map<string, TmuxSessionInfo>()
  kills: string[] = []
  stamps: { name: string; option: string; value: string }[] = []
  /** When set, every method throws — simulates a wedged/missing tmux. */
  failWith?: Error
  hasSession(name: string): boolean {
    if (this.failWith) throw this.failWith
    return this.sessions.has(name)
  }
  killSession(name: string): void {
    if (this.failWith) throw this.failWith
    this.kills.push(name)
    this.sessions.delete(name)
  }
  listSessions(): TmuxSessionInfo[] {
    if (this.failWith) throw this.failWith
    return [...this.sessions.values()]
  }
  refresh(): void {}
  setOption(name: string, option: string, value: string): void {
    if (this.failWith) throw this.failWith
    this.stamps.push({ name, option, value })
    const s = this.sessions.get(name)
    if (s) {
      if (option === '@rivet_command') s.command = value
      if (option === '@rivet_user') s.user = value
    }
  }
  /** Simulate the tmux server creating a session for a fresh new-session.
   *  Defaults carry den's tags. Pass '' for command to model a pre-fix
   *  untagged session (adopted on attach when the name is a den encoding). */
  serverCreated(name: string, command = 'claude', user = 'owner', activity = 1_800_000_000): void {
    this.sessions.set(name, { name, activity, created: activity - 100, pid: 4321, command, user })
  }
}

/** Split a tmux-form create argv into its parts for assertions. The harness
 *  argv sits between `--` and the `;` command chain (tags). CREATE wraps the
 *  harness in `/bin/sh -c` + env file; `harness` is the inner command. */
function parseTmuxArgv(argv: string[]): {
  envPairs: Record<string, string>
  harness: string[]
  chain: string[]
  wrapper?: { script: string; envFile: string }
} {
  const sep = argv.indexOf('--')
  const chainIdx = argv.indexOf(';', sep)
  const end = chainIdx === -1 ? argv.length : chainIdx
  const envPairs: Record<string, string> = {}
  for (let i = 0; i < sep; i++) {
    if (argv[i] === '-e') {
      const kv = argv[i + 1]
      const eq = kv.indexOf('=')
      envPairs[kv.slice(0, eq)] = kv.slice(eq + 1)
      i++
    }
  }
  let harness = argv.slice(sep + 1, end)
  let wrapper: { script: string; envFile: string } | undefined
  if (harness[0] === '/bin/sh' && harness[1] === '-c' && harness[3] !== undefined) {
    wrapper = { script: harness[2]!, envFile: harness[3]! }
    harness = harness.slice(4)
  }
  return { envPairs, harness, chain: argv.slice(end + 1), wrapper }
}

describe('term manager (tmux mux)', () => {
  const uuid = '11111111-1111-1111-1111-111111111111'

  it('tmux name encoding is reversible and tmux-safe', () => {
    expect(encodeTmuxName('claude:11111111-1111-1111-1111-111111111111')).toBe(
      'claude_c11111111-1111-1111-1111-111111111111',
    )
    // `_` must escape FIRST — the naive `:`→`__` mapping collides with
    // literal underscores in the key
    expect(encodeTmuxName('a__b')).toBe('a____b')
    expect(encodeTmuxName('chat-2026.07_x:y')).toBe('chat-2026_d07__x_cy')
    for (const key of ['claude:abc', 'chat-2026.07_x:y', 'a__b', 'plain', '_', ':', '.', '__cc']) {
      const enc = encodeTmuxName(key)
      expect(enc).not.toMatch(/[.:]/)
      expect(decodeTmuxName(enc)).toBe(key)
    }
    // chars outside the den session alphabet → base64url fallback
    const weird = encodeTmuxName('has space/and+more')
    expect(weird).not.toMatch(/[.:]/)
    expect(decodeTmuxName(weird)).toBe('has space/and+more')
  })

  it('encoding: left-to-right tokenizer, fallback marker, leading - rejected, length capped', () => {
    // `____cc` must tokenize as `__`+`__`+`cc` → `__cc` (a replaceAll-based
    // decoder would mis-parse this — the tokenizer is left-to-right)
    expect(decodeTmuxName('____cc')).toBe('__cc')
    expect(encodeTmuxName('__cc')).toBe('____cc')
    // fallback marker: `~` + base64url, `~` itself illegal in den keys
    expect(encodeTmuxName('has space')).toMatch(/^~/)
    // a leading '-' would be eaten by tmux's option parser at create — reject
    expect(() => encodeTmuxName('-leading')).toThrow(/must not start with '-'/)
    // the manager rejects them at the session-id door too, plus the 120 cap
    const { manager } = makeManager({})
    expect(() => manager.spawn('shell', 80, 24, '', '-bad')).toThrowError(/invalid session/)
    manager.spawn('shell', 80, 24, '', 'a'.repeat(120))
    expect(() => manager.spawn('shell', 80, 24, '', 'a'.repeat(121))).toThrowError(
      /invalid session/,
    )
  })

  it('socket name is per-den (stateDir+port), stable across restarts of one den (#15)', () => {
    expect(tmuxSocketName('/state/a', 5174)).toMatch(/^rivet-[0-9a-f]{8}$/)
    expect(tmuxSocketName('/state/a', 5174)).toBe(tmuxSocketName('/state/a', 5174))
    expect(tmuxSocketName('/state/a', 5174)).not.toBe(tmuxSocketName('/state/a', 5175))
    expect(tmuxSocketName('/state/a', 5174)).not.toBe(tmuxSocketName('/state/b', 5174))
  })

  it('tmux.conf sources the user conf FIRST, then re-asserts persistence (#13)', () => {
    const conf = tmuxConfContent(true)
    const src = conf.indexOf('source-file -q ~/.tmux.conf')
    expect(src).toBeGreaterThanOrEqual(0)
    // a user conf that flips destroy-unattached on must not void persistence
    for (const line of [
      'set -g default-terminal "tmux-256color"',
      'set -g destroy-unattached off',
      'set -g exit-empty off',
      'set -g remain-on-exit off',
    ]) {
      expect(conf.indexOf(line)).toBeGreaterThan(src)
    }
    expect(tmuxConfContent(false)).not.toContain('source-file')
  })

  it('spawns the tmux new-session form (no -A) with geometry, -e pairs and chained tags', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, spawns, stateDir } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    const pty = manager.spawn('claude', 120, 40, '127.0.0.1', uuid)
    const argv = spawns[0].argv
    const sep = argv.indexOf('--')
    expect(sep).toBeGreaterThan(0)
    expect(argv.slice(0, 9)).toEqual([
      'tmux',
      '-u',
      '-L',
      tmuxSocketName(stateDir, 5199),
      '-f',
      join(stateDir, 'den', 'tmux.conf'),
      'new-session',
      '-s',
      encodeTmuxName(uuid),
    ])
    // NEVER -A: a stale/raced existence check must fail the create loudly,
    // not silently mint a second harness with no resume flags
    expect(argv).not.toContain('-A')
    // cwd + geometry flags
    const head = argv.slice(0, sep)
    expect(head[head.indexOf('-x') + 1]).toBe('120')
    expect(head[head.indexOf('-y') + 1]).toBe('40')
    expect(head[head.indexOf('-c') + 1]).toBe(spawns[0].opts.cwd)
    // harness argv follows `--` (inside the sh wrapper) up to the `;` chain,
    // fresh-session pin intact
    const { envPairs, harness, chain, wrapper } = parseTmuxArgv(argv)
    expect(wrapper).toEqual({
      script: TMUX_ENV_WRAP_SCRIPT,
      envFile: join(stateDir, 'den', 'env', `${encodeTmuxName(uuid)}.env`),
    })
    expect(harness).toEqual(['claude', '--session-id', uuid])
    // tags are CHAINED onto the create invocation WITHOUT `-t` — tmux
    // resolves `-t =<name>` before new-session has created the session
    expect(chain).toEqual([
      'set-option',
      '@rivet_command',
      'claude',
      ';',
      'set-option',
      '@rivet_user',
      'owner',
    ])
    expect(argv.slice(argv.indexOf('new-session'))).not.toContain('-t')
    // -e carries every manager-set/overridden var for an EXISTING server…
    expect(envPairs.RIVET_DEN_SESSION).toBe(uuid)
    expect(envPairs.RIVETOS_SESSION_KEY).toBe(uuid)
    expect(envPairs.COLORTERM).toBe('truecolor')
    expect(envPairs.RIVET_DEN_URL).toBe('http://127.0.0.1:5199')
    expect(envPairs.RIVET_DEN_NAME).toBe(`${hostname()}:claude`)
    // …but NEVER TERM: -e TERM would override the conf's tmux-256color
    // inside panes on a running server and break TUI terminfo (#11)
    expect('TERM' in envPairs).toBe(false)
    // …while the outer PTY still gets the full computed env for a NEW server
    expect(spawns[0].opts.env.RIVET_DEN_SESSION).toBe(uuid)
    expect(spawns[0].opts.env.TERM).toBe('xterm-256color')
    expect(pty.mux).toBe('tmux')
    expect(pty.reattached).toBeUndefined()
    expect(pty.persisted).toBeUndefined()
    // get() resolves the den-session alias the same way kill() does
    expect(manager.get(uuid)?.id).toBe(pty.id)
  })

  it('LANG=C is rewritten to C.UTF-8 and rides -e on create', () => {
    vi.stubEnv('LANG', 'C')
    vi.stubEnv('LC_ALL', '')
    vi.stubEnv('LC_CTYPE', '')
    const ctl = new FakeTmuxCtl()
    const { manager, spawns } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    manager.spawn('claude', 80, 24, '', uuid)
    const argv = spawns[0].argv
    const langAt = argv.indexOf('LANG=C.UTF-8')
    expect(langAt).toBeGreaterThan(0)
    expect(argv[langAt - 1]).toBe('-e')
    expect(parseTmuxArgv(argv).envPairs.LANG).toBe('C.UTF-8')
  })

  it('LANG=en_US.UTF-8 is left alone but still rides -e (stale LANG=C server global env must not win)', () => {
    vi.stubEnv('LANG', 'en_US.UTF-8')
    vi.stubEnv('LC_ALL', '')
    vi.stubEnv('LC_CTYPE', '')
    const ctl = new FakeTmuxCtl()
    const { manager, spawns } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    manager.spawn('claude', 80, 24, '', uuid)
    const argv = spawns[0].argv
    expect(parseTmuxArgv(argv).envPairs.LANG).toBe('en_US.UTF-8')
    expect(argv.filter((a) => a.startsWith('LANG=')).length).toBe(1)
  })

  it('-e pairs include roster env, entry env; credential override keys go in the env file', () => {
    const ctl = new FakeTmuxCtl()
    const roster: TermRoster = {
      default: 'x',
      cwd: '/tmp',
      env: { LAYER_A: 'roster' },
      commands: {
        x: { label: 'X', cmd: ['x'], room: false, env: { LAYER_B: 'entry' } },
      },
    }
    const envFiles: { path: string; body: string }[] = []
    const { manager, spawns } = makeManager(
      { mux: 'tmux' },
      {
        tmuxCtl: ctl,
        roster,
        writeEnvFile: (path, body) => envFiles.push({ path, body }),
      },
    )
    manager.spawn('x', 80, 24, '', undefined, undefined, { RIVETOS_PG_URL: 'postgres://u@db/u' })
    const { envPairs } = parseTmuxArgv(spawns[0].argv)
    expect(envPairs.LAYER_A).toBe('roster')
    expect(envPairs.LAYER_B).toBe('entry')
    expect(envPairs.RIVETOS_PG_URL).toBeUndefined()
    expect(envFiles[0]?.body).toContain("RIVETOS_PG_URL='postgres://u@db/u'")
  })

  it('-e: credential keys never appear; deletions unset via env file + set-environment -r; odd values stay one token', () => {
    const prevPg = process.env.RIVETOS_PG_URL
    const prevUid = process.env.RIVETOS_USER_ID
    process.env.RIVETOS_PG_URL = 'postgres://owner@db/owner'
    process.env.RIVETOS_USER_ID = 'owner'
    try {
      const ctl = new FakeTmuxCtl()
      const roster: TermRoster = {
        default: 'x',
        cwd: '/tmp',
        env: { WEIRD: 'a=b\nc', RIVETOS_USER_DBS: '{"nope":true}' },
        commands: { x: { label: 'X', cmd: ['x'], room: false } },
      }
      const envFiles: { path: string; body: string }[] = []
      const { manager, spawns, stateDir } = makeManager(
        { mux: 'tmux' },
        {
          token: 'sekrit',
          tmuxCtl: ctl,
          roster,
          writeEnvFile: (path, body) => envFiles.push({ path, body }),
        },
      )
      // envFile-only override: the owner's RIVETOS_PG_URL / RIVETOS_USER_ID
      // are DELETED for this user's session
      manager.spawn(
        'x',
        80,
        24,
        '',
        'chat-e',
        undefined,
        { RIVETOS_ENV_FILE: '/home/coco/.env' },
        'coco',
      )
      const argv = spawns[0].argv
      const { envPairs, wrapper, chain } = parseTmuxArgv(argv)
      expect(envPairs.RIVETOS_ENV_FILE).toBeUndefined()
      expect(envPairs.RIVETOS_PG_URL).toBeUndefined()
      expect(envPairs.RIVETOS_USER_ID).toBeUndefined()
      expect(envPairs.RIVET_DEN_TOKEN).toBeUndefined()
      // wrapper argv shape: /bin/sh -c SCRIPT envFile ...harness
      expect(wrapper).toEqual({
        script: TMUX_ENV_WRAP_SCRIPT,
        envFile: join(stateDir, 'den', 'env', `${encodeTmuxName('chat-e')}.env`),
      })
      expect(argv.slice(argv.indexOf('--'), argv.indexOf('--') + 5)).toEqual([
        '--',
        '/bin/sh',
        '-c',
        TMUX_ENV_WRAP_SCRIPT,
        wrapper!.envFile,
      ])
      const body = envFiles[0]?.body ?? ''
      expect(body).toContain("RIVET_DEN_TOKEN='sekrit'")
      expect(body).toContain("RIVETOS_ENV_FILE='/home/coco/.env'")
      expect(body).toContain('unset RIVETOS_PG_URL')
      expect(body).toContain('unset RIVETOS_USER_ID')
      expect(body).not.toContain('RIVETOS_USER_DBS')
      expect(chain).toEqual([
        'set-option',
        '@rivet_command',
        'x',
        ';',
        'set-option',
        '@rivet_user',
        'coco',
        ';',
        'set-environment',
        '-r',
        'RIVETOS_PG_URL',
        ';',
        'set-environment',
        '-r',
        'RIVETOS_USER_ID',
      ])
      expect(argv.slice(argv.indexOf('new-session'))).not.toContain('-t')
      // and they left the PTY env entirely
      expect(spawns[0].opts.env.RIVETOS_PG_URL).toBeUndefined()
      expect(spawns[0].opts.env.RIVETOS_USER_ID).toBeUndefined()
      // denied keys (RIVETOS_USER_DBS-class) never ride -e
      expect(envPairs.RIVETOS_USER_DBS).toBeUndefined()
      // a value with `=` and a newline stays ONE argv token
      const token = argv.find((t) => t.startsWith('WEIRD='))
      expect(token).toBe('WEIRD=a=b\nc')
    } finally {
      if (prevPg === undefined) delete process.env.RIVETOS_PG_URL
      else process.env.RIVETOS_PG_URL = prevPg
      if (prevUid === undefined) delete process.env.RIVETOS_USER_ID
      else process.env.RIVETOS_USER_ID = prevUid
    }
  })

  it('writeEnvFile throw releases spawnInflight so a retry is not refused with cap', () => {
    const ctl = new FakeTmuxCtl()
    let calls = 0
    const { manager } = makeManager(
      { mux: 'tmux' },
      {
        tmuxCtl: ctl,
        writeEnvFile: () => {
          calls += 1
          if (calls === 1) throw new Error('ENOSPC')
        },
      },
    )
    expect(() => manager.spawn('claude', 80, 24, '', uuid)).toThrow(/ENOSPC/)
    // same denSession: a leaked inflight flag would throw TermSpawnError('cap')
    const pty = manager.spawn('claude', 80, 24, '', uuid)
    expect(pty.command).toBe('claude')
    expect(calls).toBe(2)
  })

  it('default writeEnvFile modes are 0600 file and 0700 dir', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, stateDir } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl, token: 'sekrit' })
    manager.spawn('claude', 80, 24, '', uuid)
    const envDir = join(stateDir, 'den', 'env')
    const envFile = join(envDir, `${encodeTmuxName(uuid)}.env`)
    expect(statSync(envDir).mode & 0o777).toBe(0o700)
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
  })

  it('flag matrix: live session → attach-session (no argv/flags); store hit without live → new-session --resume', () => {
    // live session + explicit resume hint + store hit → STILL attach: the
    // harness is already running, nothing reaches it (#1)
    const ctl = new FakeTmuxCtl()
    ctl.serverCreated(encodeTmuxName(uuid), 'claude', 'owner')
    const attached = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl, sessionExists: () => true })
    const pty = attached.manager.spawn('claude', 80, 24, '', uuid, uuid)
    const sock = tmuxSocketName(attached.stateDir, 5199)
    expect(attached.spawns[0].argv).toEqual([
      'tmux',
      '-u',
      '-L',
      sock,
      '-f',
      join(attached.stateDir, 'den', 'tmux.conf'),
      'attach-session',
      '-t',
      `=${encodeTmuxName(uuid)}`,
    ])
    expect(pty.reattached).toBe(true)
    expect(pty.persisted).toBeUndefined()
    // store-miss + live → attach as well (store state is irrelevant here)
    const ctl2 = new FakeTmuxCtl()
    ctl2.serverCreated(encodeTmuxName(uuid), 'claude', 'owner')
    const miss = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl2, sessionExists: () => false })
    miss.manager.spawn('claude', 80, 24, '', uuid)
    expect(miss.spawns[0].argv).toContain('attach-session')
    // no live session + store hit → new-session (no -A) WITH --resume
    const ctl3 = new FakeTmuxCtl()
    const fresh = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl3, sessionExists: () => true })
    fresh.manager.spawn('claude', 80, 24, '', uuid)
    expect(fresh.spawns[0].argv).toContain('new-session')
    expect(fresh.spawns[0].argv).not.toContain('-A')
    expect(parseTmuxArgv(fresh.spawns[0].argv).harness).toEqual(['claude', '--resume', uuid])
  })

  it('has-session live → attach form: immediately ready, no -e, no tags', () => {
    const ctl = new FakeTmuxCtl()
    ctl.serverCreated(encodeTmuxName(uuid), 'claude', 'owner')
    const { manager, spawns, procs, stateDir } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl, sessionExists: () => true },
    )
    // even with an explicit resume hint AND a store hit, a live tmux session
    // means the harness is already running — no flags reach it
    const pty = manager.spawn('claude', 80, 24, '', uuid, uuid)
    const argv = spawns[0].argv
    expect(argv[0]).toBe('tmux')
    expect(argv).toEqual([
      'tmux',
      '-u',
      '-L',
      tmuxSocketName(stateDir, 5199),
      '-f',
      join(stateDir, 'den', 'tmux.conf'),
      'attach-session',
      '-t',
      `=${encodeTmuxName(uuid)}`,
    ])
    expect(argv).not.toContain('--resume')
    expect(argv).not.toContain('-e')
    expect(pty.reattached).toBe(true)
    // attach is immediately ready: injects are not buffered behind the
    // first-output settle (tmux's attach redraw would fire it too early)
    expect(manager.inject(pty.id, 'hello', true)).toBe(true)
    expect(procs[0].writes).toEqual(['\x1b[200~hello\x1b[201~'])
  })

  it('create under tmux still buffers injects until the first output settles', () => {
    vi.useFakeTimers()
    const ctl = new FakeTmuxCtl()
    const { manager, procs } = makeManager({ mux: 'tmux', injectReadyMs: 300 }, { tmuxCtl: ctl })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-buf')
    expect(manager.inject(pty.id, 'hello', true)).toBe(true)
    expect(procs[0].writes).toEqual([])
    procs[0].emitData('welcome')
    vi.advanceTimersByTime(300)
    expect(procs[0].writes).toEqual(['\x1b[200~hello\x1b[201~'])
  })

  it('refuses @rivet_user mismatch when the user tag is set, including untagged command', () => {
    const ctl = new FakeTmuxCtl()
    ctl.serverCreated(encodeTmuxName('chat-u'), '', 'phil')
    const { manager } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() =>
      manager.spawn('claude', 80, 24, '', 'chat-u', undefined, undefined, 'coco'),
    ).toThrowError(/owned by another user/)
    expect(ctl.stamps).toEqual([])
  })

  it('refuses a command-tagged session with empty @rivet_user for a routed non-owner', () => {
    const ctl = new FakeTmuxCtl()
    ctl.serverCreated(encodeTmuxName('chat-empty-user'), 'claude', '')
    const { manager } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() =>
      manager.spawn('claude', 80, 24, '', 'chat-empty-user', undefined, undefined, 'coco'),
    ).toThrowError(/owned by another user/)
    const ctl2 = new FakeTmuxCtl()
    ctl2.serverCreated(encodeTmuxName('chat-empty-owner'), 'claude', '')
    const owner = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl2 })
    expect(owner.manager.spawn('claude', 80, 24, '', 'chat-empty-owner').reattached).toBe(true)
  })

  it('refuses to attach a persisted session owned by another user (#7)', () => {
    const ctl = new FakeTmuxCtl()
    ctl.serverCreated(encodeTmuxName('chat-x'), 'claude', 'phil')
    const { manager } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() =>
      manager.spawn('claude', 80, 24, '', 'chat-x', undefined, undefined, 'coco'),
    ).toThrowError(/owned by another user/)
    // an owner-stamped session attaches for the owner identity
    const ctl2 = new FakeTmuxCtl()
    ctl2.serverCreated(encodeTmuxName('chat-y'), 'claude', 'owner')
    const owner = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl2 })
    expect(owner.manager.spawn('claude', 80, 24, '', 'chat-y').reattached).toBe(true)
    // and a matching routed user attaches their own session
    const ctl3 = new FakeTmuxCtl()
    ctl3.serverCreated(encodeTmuxName('chat-z'), 'claude', 'coco')
    const mine = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl3 })
    expect(
      mine.manager.spawn('claude', 80, 24, '', 'chat-z', undefined, undefined, 'coco').reattached,
    ).toBe(true)
  })

  it('adopts an untagged session whose name decodes as a den session key', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-f')
    ctl.serverCreated(name, '', '')
    const { manager, spawns, logs, procs, stateDir } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl },
    )
    const pty = manager.spawn('claude', 80, 24, '', 'chat-f')
    expect(pty.reattached).toBe(true)
    expect(spawns[0].argv).toEqual([
      'tmux',
      '-u',
      '-L',
      tmuxSocketName(stateDir, 5199),
      '-f',
      join(stateDir, 'den', 'tmux.conf'),
      'attach-session',
      '-t',
      `=${name}`,
    ])
    expect(ctl.stamps).toEqual([
      { name, option: '@rivet_command', value: 'claude' },
      { name, option: '@rivet_user', value: 'owner' },
    ])
    expect(ctl.sessions.get(name)?.command).toBe('claude')
    expect(logs.filter((l) => l.includes(`adopted untagged tmux session ${name}`))).toHaveLength(1)
    expect(logs.some((l) => l.includes('(pre-fix create)'))).toBe(true)
    // client gone; tags now set — reattach, no second adopt log
    procs[0].emitExit(null)
    const again = manager.spawn('claude', 80, 24, '', 'chat-f')
    expect(again.id).not.toBe(pty.id)
    expect(again.reattached).toBe(true)
    expect(logs.filter((l) => l.includes('adopted untagged'))).toHaveLength(1)
  })

  it('refuses to adopt an untagged session for a routed non-owner', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-f')
    ctl.serverCreated(name, '', '')
    const { manager } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() =>
      manager.spawn('claude', 80, 24, '', 'chat-f', undefined, undefined, 'coco'),
    ).toThrowError(/owned by another user/)
    expect(ctl.stamps).toEqual([])
  })

  it('owner adopt of an untagged session stamps @rivet_user owner', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-f')
    ctl.serverCreated(name, '', '')
    const { manager } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-f', undefined, undefined, 'owner')
    expect(pty.reattached).toBe(true)
    expect(ctl.stamps).toEqual([
      { name, option: '@rivet_command', value: 'claude' },
      { name, option: '@rivet_user', value: 'owner' },
    ])
  })

  it('does not attach an untagged non-encoded tmux name sitting on the socket', () => {
    const ctl = new FakeTmuxCtl()
    // `a_b` does not round-trip (encode('a_b') === 'a__b') — foreign.
    ctl.serverCreated('a_b', '', '')
    const { manager, spawns } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-ok')
    expect(pty.reattached).toBeUndefined()
    expect(spawns[0].argv).toContain('new-session')
    expect(ctl.stamps).toEqual([])
  })

  it('duplicate hasSession hit with empty list refuses (session exists but is not listable)', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-ghost')
    ctl.hasSession = (n: string) => n === name
    ctl.listSessions = () => []
    const { manager, spawns } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() => manager.spawn('claude', 80, 24, '', 'chat-ghost')).toThrowError(
      /session exists but is not listable/,
    )
    expect(spawns).toEqual([])
    expect(ctl.stamps).toEqual([])
  })

  it('duplicate-session on create (list miss, hasSession hit) → attach fallback', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-dup')
    ctl.serverCreated(name, 'claude', 'owner')
    const realList = ctl.listSessions.bind(ctl)
    let lists = 0
    ctl.listSessions = () => {
      lists += 1
      if (lists === 1) return []
      return realList()
    }
    const { manager, spawns, stateDir } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-dup')
    expect(pty.reattached).toBe(true)
    expect(spawns[0].argv).toEqual([
      'tmux',
      '-u',
      '-L',
      tmuxSocketName(stateDir, 5199),
      '-f',
      join(stateDir, 'den', 'tmux.conf'),
      'attach-session',
      '-t',
      `=${name}`,
    ])
    expect(spawns[0].argv).not.toContain('new-session')
  })

  it('duplicate-session throw with empty list refuses (session exists but is not listable)', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-dup-empty')
    const spawns: { argv: string[] }[] = []
    const { manager } = makeManager(
      { mux: 'tmux' },
      {
        tmuxCtl: ctl,
        spawn: (argv) => {
          spawns.push({ argv })
          if (argv.includes('new-session')) throw new Error(`duplicate session: ${name}`)
          throw new Error('should not attach')
        },
      },
    )
    expect(() => manager.spawn('claude', 80, 24, '', 'chat-dup-empty')).toThrowError(
      /session exists but is not listable/,
    )
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.argv).toContain('new-session')
  })

  it('duplicate-session throw from spawn falls back to attach', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-dup2')
    const procs: FakeProc[] = []
    const spawns: { argv: string[] }[] = []
    let pid = 2000
    const { manager, stateDir } = makeManager(
      { mux: 'tmux' },
      {
        tmuxCtl: ctl,
        spawn: (argv) => {
          spawns.push({ argv })
          if (spawns.length === 1 && argv.includes('new-session')) {
            // Session appeared between list and create.
            ctl.serverCreated(name, 'claude', 'owner')
            throw new Error(`duplicate session: ${name}`)
          }
          const proc = new FakeProc(++pid)
          procs.push(proc)
          return proc
        },
      },
    )
    const pty = manager.spawn('claude', 80, 24, '', 'chat-dup2')
    expect(spawns).toHaveLength(2)
    expect(spawns[0].argv).toContain('new-session')
    expect(spawns[1].argv).toEqual([
      'tmux',
      '-u',
      '-L',
      tmuxSocketName(stateDir, 5199),
      '-f',
      join(stateDir, 'den', 'tmux.conf'),
      'attach-session',
      '-t',
      `=${name}`,
    ])
    expect(pty.reattached).toBe(true)
    expect(pty.pid).toBe(procs[0].pid)
  })

  it('detached-ttl under tmux DETACHES: audit `detach`, session untouched, client SIGHUPd', () => {
    vi.useFakeTimers()
    const ctl = new FakeTmuxCtl()
    const { manager, procs, stateDir } = makeManager(
      { mux: 'tmux', detachedTtlMs: 1000, idleTtlMs: 0 },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    const pty = manager.spawn('claude', 80, 24, '', 'chat-det')
    ctl.serverCreated(encodeTmuxName('chat-det')) // server-side reality after create
    vi.advanceTimersByTime(1000)
    expect(procs[0].kills).toEqual(['SIGHUP']) // den's client only
    expect(ctl.kills).toEqual([]) // tmux session survives
    const lines = readFileSync(join(stateDir, 'term-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map((l) => l.action)).toEqual(['spawn', 'detach'])
    expect(lines[1]).toMatchObject({ reason: 'detached-ttl', id: pty.id })
    // a STUCK client is SIGKILLed after ~1s — the backstop only ever hits
    // the client process, never the session (#10)
    vi.advanceTimersByTime(1000)
    expect(procs[0].kills).toEqual(['SIGHUP', 'SIGKILL'])
    // the detached client exiting is NOT a harness exit: no synthetic
    // session.end while the tmux session exists — and the record is reaped
    // IMMEDIATELY (nothing to linger for; the replay belongs to tmux)
    procs[0].emitExit(null)
    expect(manager.get(pty.id)).toBeUndefined()
    expect(manager.ptyForSession('chat-det')).toBeUndefined()
  })

  it('idle-ttl under tmux detaches the same way', () => {
    vi.useFakeTimers()
    const ctl = new FakeTmuxCtl()
    const { manager, procs, stateDir } = makeManager(
      { mux: 'tmux', idleTtlMs: 1000, detachedTtlMs: 60_000 },
      { tmuxCtl: ctl },
    )
    manager.spawn('shell', 80, 24, '')
    ctl.serverCreated(encodeTmuxName(manager.list()[0].denSession))
    vi.advanceTimersByTime(1000)
    expect(procs[0].kills).toEqual(['SIGHUP'])
    expect(ctl.kills).toEqual([])
    const lines = readFileSync(join(stateDir, 'term-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.at(-1)).toMatchObject({ action: 'detach', reason: 'idle-ttl' })
  })

  it('a detached client exit does NOT ingest session.end; a killed session does', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, procs, ingested } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    // detached path: client exits, tmux session alive → room stays open
    manager.spawn('claude', 80, 24, '', 'chat-a')
    ctl.serverCreated(encodeTmuxName('chat-a'))
    procs[0].emitExit(null)
    expect(ingested.filter((e) => e.type === 'session.end')).toEqual([])

    // kill path: kill-session first, then the client exit sees the session
    // gone and the synthetic session.end fires as under mux:none
    const b = manager.spawn('claude', 80, 24, '', 'chat-b')
    ctl.serverCreated(encodeTmuxName('chat-b'))
    expect(manager.kill(b.id)).toBe(true)
    expect(ctl.kills).toEqual([encodeTmuxName('chat-b')])
    procs[1].emitExit(129)
    const ends = ingested.filter((e) => e.type === 'session.end')
    expect(ends).toHaveLength(1)
    expect(ends[0].session).toBe('chat-b')
  })

  it('harness exit while detached → exactly one session.end from the sweep (#5)', () => {
    vi.useFakeTimers()
    const ctl = new FakeTmuxCtl()
    const { manager, procs, ingested } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    manager.spawn('claude', 80, 24, '', 'chat-gone')
    ctl.serverCreated(encodeTmuxName('chat-gone'))
    // den's client detaches while the harness lives on — no end…
    procs[0].emitExit(null)
    expect(ingested.filter((e) => e.type === 'session.end')).toEqual([])
    // …then the harness exits inside tmux: the session disappears with NO
    // den client to notice — the sweep must close the room, once
    ctl.sessions.delete(encodeTmuxName('chat-gone'))
    vi.advanceTimersByTime(60_000) // sweep interval with gcMs 0
    const ends = ingested.filter((e) => e.type === 'session.end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ session: 'chat-gone', type: 'session.end' })
    vi.advanceTimersByTime(180_000) // never twice
    expect(ingested.filter((e) => e.type === 'session.end')).toHaveLength(1)
  })

  it('kill() with the tmux session already gone still ends the room exactly once', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, procs, ingested } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    const pty = manager.spawn('claude', 80, 24, '', 'chat-k2')
    ctl.serverCreated(encodeTmuxName('chat-k2'))
    ctl.sessions.delete(encodeTmuxName('chat-k2')) // died on its own
    expect(manager.kill(pty.id)).toBe(true)
    procs[0].emitExit(129)
    const ends = ingested.filter((e) => e.type === 'session.end' && e.session === 'chat-k2')
    expect(ends).toHaveLength(1)
  })

  it('detach: list() has exactly ONE row (persisted, running, attached:0); re-spawn attaches (#10)', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, procs, spawns } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    manager.spawn('claude', 80, 24, '', 'chat-d2')
    ctl.serverCreated(encodeTmuxName('chat-d2'))
    procs[0].emitExit(null) // client detaches; the harness lives on
    const mine = manager.list().filter((r) => r.denSession === 'chat-d2')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      id: `tmux-${encodeTmuxName('chat-d2')}`,
      persisted: true,
      state: 'running',
      attached: 0,
      pid: 4321,
    })
    // unknown geometry is omitted, never a fake 0
    expect('cols' in mine[0]).toBe(false)
    expect('rows' in mine[0]).toBe(false)
    // re-spawn takes the attach form and claims the session back: still ONE row
    const again = manager.spawn('claude', 80, 24, '', 'chat-d2')
    expect(again.reattached).toBe(true)
    expect(spawns[1].argv).toContain('attach-session')
    expect(spawns[1].argv).not.toContain('-A')
    const after = manager.list().filter((r) => r.denSession === 'chat-d2')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: again.id, state: 'running', reattached: true })
    expect(after[0].persisted).toBeUndefined()
  })

  it('kill() resolves tmux-<name> ids and den session keys for client-less sessions (#4)', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, procs, ingested, stateDir } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    manager.spawn('claude', 80, 24, '', 'chat-p1', undefined, undefined, 'coco')
    ctl.serverCreated(encodeTmuxName('chat-p1'), 'claude', 'coco')
    procs[0].emitExit(null) // detached — no den client anymore
    const row = manager.list().find((r) => r.denSession === 'chat-p1')!
    expect(row.id).toBe(`tmux-${encodeTmuxName('chat-p1')}`)
    expect(row.routedUser).toBe('coco')
    // get() resolves the tmux- id too — DELETE routes tenancy through it
    expect(manager.get(row.id)).toMatchObject({
      denSession: 'chat-p1',
      persisted: true,
      routedUser: 'coco',
    })
    expect(manager.get('chat-p1')).toMatchObject({
      denSession: 'chat-p1',
      persisted: true,
      routedUser: 'coco',
    })
    expect(manager.kill(row.id)).toBe(true)
    expect(ctl.kills).toEqual([encodeTmuxName('chat-p1')])
    expect(manager.list().filter((r) => r.denSession === 'chat-p1')).toEqual([])
    // killing a detached session is a harness exit: the room ends once
    expect(
      ingested.filter((e) => e.type === 'session.end' && e.session === 'chat-p1'),
    ).toHaveLength(1)
    const lines = readFileSync(join(stateDir, 'term-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.at(-1)).toMatchObject({
      action: 'kill',
      reason: 'request',
      id: row.id,
      routedUser: 'coco',
    })
    // a bare den session key resolves the same way; unknown ids are false
    manager.spawn('shell', 80, 24, '', 'chat-p2')
    ctl.serverCreated(encodeTmuxName('chat-p2'), 'shell')
    procs[1].emitExit(null)
    expect(manager.kill('chat-p2')).toBe(true)
    expect(ctl.kills).toEqual([encodeTmuxName('chat-p1'), encodeTmuxName('chat-p2')])
    expect(manager.kill('chat-nope')).toBe(false)
    // a foreign (untagged) session is NEVER killable through den
    ctl.serverCreated('foreign', '', '')
    expect(manager.kill('tmux-foreign')).toBe(false)
  })

  it('kill() under tmux kills the tmux session, then SIGHUPs the client', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, procs, stateDir } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-kill')
    ctl.serverCreated(encodeTmuxName('chat-kill'))
    manager.kill(pty.id)
    expect(ctl.kills).toEqual([encodeTmuxName('chat-kill')])
    expect(procs[0].kills).toEqual(['SIGHUP'])
    const lines = readFileSync(join(stateDir, 'term-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.at(-1)).toMatchObject({ action: 'kill', reason: 'request' })
  })

  it('list() merges client-less tmux sessions as persisted rows, without duplicates', () => {
    const ctl = new FakeTmuxCtl()
    const { manager } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    const live = manager.spawn('claude', 80, 24, '', 'chat-live')
    // the live client's tmux session exists server-side…
    ctl.serverCreated(encodeTmuxName('chat-live'), 'claude')
    // …plus one orphaned session with no den client (owned by a routed user)
    ctl.serverCreated(encodeTmuxName('chat-orphan'), 'kimi', 'coco')
    // …and one foreign session that must NEVER be listed
    ctl.serverCreated('foreign', '', '')
    const rows = manager.list()
    expect(rows).toHaveLength(2) // no duplicate for chat-live, no foreign row
    const liveRow = rows.find((r) => r.id === live.id)!
    expect(liveRow.mux).toBe('tmux')
    expect(liveRow.persisted).toBeUndefined()
    const orphan = rows.find((r) => r.denSession === 'chat-orphan')!
    expect(orphan).toMatchObject({
      id: `tmux-${encodeTmuxName('chat-orphan')}`,
      command: 'kimi', // read back from @rivet_command
      state: 'running',
      mux: 'tmux',
      persisted: true,
      attached: 0,
      pid: 4321,
      routedUser: 'coco', // read back from @rivet_user
    })
  })

  it('session GC: den clock only — kills detached-past-gcMs tagged sessions, spares the rest (#12)', () => {
    vi.useFakeTimers()
    const ctl = new FakeTmuxCtl()
    const gcMs = 60_000
    const { manager, procs, stateDir, ingested } = makeManager(
      { mux: 'tmux', sessionGcMs: gcMs },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    // a LIVE den client whose tmux activity is ancient must NOT be killed —
    // tmux's activity clock is not an idleness signal (a quiet prompt looks idle)
    manager.spawn('claude', 80, 24, '', 'chat-live')
    ctl.serverCreated(encodeTmuxName('chat-live'), 'claude', 'owner', 1)
    // a session that detaches now becomes eligible at detach+gcMs
    manager.spawn('claude', 80, 24, '', 'chat-old')
    ctl.serverCreated(encodeTmuxName('chat-old'), 'claude')
    // foreign/undecodable-by-den sessions are never GC'd
    ctl.serverCreated('foreign', '', '')
    procs[1].emitExit(null) // chat-old's client detaches at t≈0
    vi.advanceTimersByTime(gcMs - 1000) // boundary −1s: no sweep yet, nothing killed
    expect(ctl.kills).toEqual([])
    vi.advanceTimersByTime(1000) // first sweep at t=gcMs: detached exactly gcMs → eligible
    expect(ctl.kills).toEqual([encodeTmuxName('chat-old')])
    expect(ctl.sessions.has(encodeTmuxName('chat-live'))).toBe(true)
    expect(ctl.sessions.has('foreign')).toBe(true)
    expect(manager.list().some((r) => r.denSession === 'chat-live' && r.state === 'running')).toBe(
      true,
    )
    // GC kills are audited and end the room like any harness exit
    const lines = readFileSync(join(stateDir, 'term-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.at(-1)).toMatchObject({
      action: 'kill',
      reason: 'session-gc',
      id: `tmux-${encodeTmuxName('chat-old')}`,
    })
    expect(
      ingested.filter((e) => e.type === 'session.end' && e.session === 'chat-old'),
    ).toHaveLength(1)
  })

  it('sessionGcMs:0 never GCs — detached sessions live until explicitly killed', () => {
    vi.useFakeTimers()
    const ctl = new FakeTmuxCtl()
    const m = makeManager({ mux: 'tmux', sessionGcMs: 0 }, { tmuxCtl: ctl })
    m.manager.spawn('claude', 80, 24, '', 'chat-forever')
    ctl.serverCreated(encodeTmuxName('chat-forever'), 'claude')
    m.procs[0].emitExit(null)
    vi.advanceTimersByTime(7_200_000) // two hours of sweeps — never a kill
    expect(ctl.kills).toEqual([])
    expect(ctl.sessions.has(encodeTmuxName('chat-forever'))).toBe(true)
  })

  it('falls back to direct PTY with ONE log line when tmux is not on PATH', () => {
    const prevPath = process.env.PATH
    process.env.PATH = ''
    try {
      // mux unset (default) and no injected ctl → detection runs and fails
      const { manager, spawns, logs } = makeManager({ mux: undefined })
      manager.spawn('shell', 80, 24, '')
      expect(spawns[0].argv).toEqual(['bash', '-l']) // direct spawn, byte-identical
      const fallbackLogs = logs.filter((l) => l.includes('tmux not found on PATH'))
      expect(fallbackLogs).toHaveLength(1)
    } finally {
      process.env.PATH = prevPath
    }
  })

  it('detects a tmux binary on PATH by default and uses the mux layer', () => {
    // hermetic "binary": answers -V like tmux 3.4, everything else exit 1
    // (the real ctl reads exit 1 as "no server/session")
    const binDir = tmp()
    writeFileSync(
      join(binDir, 'tmux'),
      '#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    )
    const prevPath = process.env.PATH
    process.env.PATH = binDir
    try {
      const { manager, spawns } = makeManager({ mux: undefined })
      manager.spawn('shell', 80, 24, '')
      expect(spawns[0].argv[0]).toBe('tmux')
      expect(spawns[0].argv[1]).toBe('-u')
      expect(spawns[0].argv[2]).toBe('-L')
      expect(spawns[0].argv[3]).toMatch(/^rivet-[0-9a-f]{8}$/)
    } finally {
      process.env.PATH = prevPath
    }
  })

  it('rejects a too-old tmux (< 3.2) and non-files on PATH (#16)', () => {
    const binDir = tmp()
    writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\necho "tmux 2.9"\n', { mode: 0o755 })
    const prevPath = process.env.PATH
    process.env.PATH = binDir
    try {
      const { manager, spawns, logs } = makeManager({ mux: undefined })
      manager.spawn('shell', 80, 24, '')
      expect(spawns[0].argv).toEqual(['bash', '-l']) // auto fallback
      expect(logs.some((l) => l.includes('older than 3.2'))).toBe(true)
    } finally {
      process.env.PATH = prevPath
    }
    // a DIRECTORY named tmux on PATH is not a binary
    const dirDir = tmp()
    mkdirSync(join(dirDir, 'tmux'))
    process.env.PATH = dirDir
    try {
      const { manager, spawns } = makeManager({ mux: undefined })
      manager.spawn('shell', 80, 24, '')
      expect(spawns[0].argv).toEqual(['bash', '-l'])
    } finally {
      process.env.PATH = prevPath
    }
  })

  it('explicit tmux mode with no binary → every spawn throws tmux-unavailable (#19)', () => {
    const prevPath = process.env.PATH
    process.env.PATH = ''
    try {
      const { manager, spawns, logs } = makeManager({ mux: 'tmux' })
      expect(() => manager.spawn('shell', 80, 24, '')).toThrowError(/tmux/)
      expect(spawns).toEqual([]) // never a silent direct spawn in explicit mode
      expect(logs.some((l) => l.includes("term.mux is 'tmux'"))).toBe(true)
    } finally {
      process.env.PATH = prevPath
    }
  })

  it('explicit mode: a ctl failure fails the spawn (tmux-unavailable) — never creates (#9)', () => {
    const ctl = new FakeTmuxCtl()
    ctl.failWith = new TmuxUnavailableError('wedged server')
    const { manager, spawns } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() => manager.spawn('shell', 80, 24, '')).toThrowError(/tmux unavailable/)
    expect(spawns).toEqual([])
  })

  it('explicit mode: hasSession throwing TmuxUnavailableError fails the spawn', () => {
    const ctl = new FakeTmuxCtl()
    ctl.listSessions = () => []
    ctl.hasSession = () => {
      throw new TmuxUnavailableError('has-session wedged')
    }
    const { manager, spawns } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() => manager.spawn('claude', 80, 24, '', 'chat-hs')).toThrowError(/tmux unavailable/)
    expect(spawns).toEqual([])
  })

  it('auto mode: hasSession throwing TmuxUnavailableError falls back to direct PTY', () => {
    const ctl = new FakeTmuxCtl()
    ctl.listSessions = () => []
    ctl.hasSession = () => {
      throw new TmuxUnavailableError('has-session wedged')
    }
    const { manager, spawns, logs } = makeManager({ mux: undefined }, { tmuxCtl: ctl })
    const a = manager.spawn('claude', 80, 24, '', 'chat-hs-auto')
    expect(spawns[0].argv).not.toContain('tmux')
    expect(a.mux).toBeUndefined()
    expect(logs.filter((l) => l.includes('became unavailable mid-life'))).toHaveLength(1)
  })

  it('explicit mode: setOption throwing TmuxUnavailableError on adopt fails the spawn', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-so')
    ctl.serverCreated(name, '', '')
    ctl.setOption = () => {
      throw new TmuxUnavailableError('set-option wedged')
    }
    const { manager, spawns } = makeManager({ mux: 'tmux' }, { tmuxCtl: ctl })
    expect(() => manager.spawn('claude', 80, 24, '', 'chat-so')).toThrowError(/tmux unavailable/)
    expect(spawns).toEqual([])
  })

  it('auto mode: setOption throwing TmuxUnavailableError on adopt falls back to direct PTY', () => {
    const ctl = new FakeTmuxCtl()
    const name = encodeTmuxName('chat-so-auto')
    ctl.serverCreated(name, '', '')
    ctl.setOption = () => {
      throw new TmuxUnavailableError('set-option wedged')
    }
    const { manager, spawns, logs } = makeManager({ mux: undefined }, { tmuxCtl: ctl })
    const a = manager.spawn('claude', 80, 24, '', 'chat-so-auto')
    expect(spawns[0].argv).not.toContain('tmux')
    expect(a.mux).toBeUndefined()
    expect(logs.filter((l) => l.includes('became unavailable mid-life'))).toHaveLength(1)
  })

  it('auto mode: a mid-life ctl failure spawns direct with ONE log line (#9/#19)', () => {
    const ctl = new FakeTmuxCtl()
    ctl.failWith = new TmuxUnavailableError('wedged server')
    const { manager, spawns, logs } = makeManager({ mux: undefined }, { tmuxCtl: ctl })
    const a = manager.spawn('shell', 80, 24, '')
    expect(spawns[0].argv).toEqual(['bash', '-l']) // true none fallback for this call
    expect(a.mux).toBeUndefined()
    manager.spawn('shell', 80, 24, '')
    expect(spawns[1].argv).toEqual(['bash', '-l'])
    expect(logs.filter((l) => l.includes('became unavailable mid-life'))).toHaveLength(1)
  })

  it('a ctl failure inside onExit/list never throws and never ends a live room (#9)', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, procs, ingested } = makeManager(
      { mux: 'tmux' },
      { tmuxCtl: ctl, roomOpen: () => true },
    )
    manager.spawn('claude', 80, 24, '', 'chat-wedge')
    ctl.serverCreated(encodeTmuxName('chat-wedge'))
    ctl.failWith = new TmuxUnavailableError('wedged server')
    // the client exit must not throw, and "unknown" reads as ALIVE — the
    // room stays open until the sweep can confirm the session is gone
    expect(() => procs[0].emitExit(null)).not.toThrow()
    expect(ingested.filter((e) => e.type === 'session.end')).toEqual([])
    // list degrades to den records instead of failing the poll
    expect(manager.list()).toEqual([])
  })

  it('mux:none ignores an injected ctl entirely (byte-identical direct spawn)', () => {
    const ctl = new FakeTmuxCtl()
    const { manager, spawns } = makeManager({ mux: 'none' }, { tmuxCtl: ctl })
    const pty = manager.spawn('shell', 80, 24, '')
    expect(spawns[0].argv).toEqual(['bash', '-l'])
    expect(pty.mux).toBeUndefined()
    expect(manager.list()[0].mux).toBeUndefined()
  })
})

// The real ctl's argv shape and error classification, driven by a scripted
// exec — no real tmux needed (#2, #3, #9).
describe('real tmux ctl (scripted exec)', () => {
  it('puts -L <sock> -f <conf> and -t =<name> on every call; exit 1 reads as not-found', () => {
    const calls: string[][] = []
    const exec: TmuxExec = (_bin, args) => {
      calls.push(args)
      throw Object.assign(new Error('exit 1'), { status: 1 })
    }
    const ctl = createRealTmuxCtl('/usr/bin/tmux', 'rivet-abcd1234', '/tmp/den/tmux.conf', exec)
    expect(ctl.hasSession('abc')).toBe(false)
    expect(ctl.listSessions()).toEqual([])
    expect(() => ctl.killSession('abc')).not.toThrow()
    expect(calls).toHaveLength(3)
    for (const c of calls) {
      expect(c.slice(0, 4)).toEqual(['-L', 'rivet-abcd1234', '-f', '/tmp/den/tmux.conf'])
    }
    expect(calls[0][calls[0].indexOf('-t') + 1]).toBe('=abc')
    expect(calls[2][calls[2].indexOf('-t') + 1]).toBe('=abc')
  })

  it('ETIMEDOUT / ENOENT / other statuses throw TmuxUnavailableError (fail closed)', () => {
    const mk = (err: Error): TmuxCtl => {
      const exec: TmuxExec = () => {
        throw err
      }
      return createRealTmuxCtl('/usr/bin/tmux', 's', 'c', exec)
    }
    expect(() =>
      mk(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })).hasSession('a'),
    ).toThrow(TmuxUnavailableError)
    expect(() =>
      mk(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })).listSessions(),
    ).toThrow(TmuxUnavailableError)
    expect(() => mk(Object.assign(new Error('exit 2'), { status: 2 })).killSession('a')).toThrow(
      TmuxUnavailableError,
    )
  })

  it('listSessions parses @rivet_command/@rivet_user and memoizes ~1s until refresh', () => {
    let calls = 0
    const exec: TmuxExec = () => {
      calls++
      return 'chat_c1\t1800000000\t1799999900\t4321\tclaude\tcoco\nforeign\t1800000000\t1799999900\t0\t\t\n'
    }
    const ctl = createRealTmuxCtl('/usr/bin/tmux', 's', 'c', exec)
    const a = ctl.listSessions()
    expect(calls).toBe(1)
    expect(ctl.listSessions()).toBe(a) // memo hit — no second fork
    expect(calls).toBe(1)
    ctl.refresh?.()
    ctl.listSessions()
    expect(calls).toBe(2)
    expect(a).toEqual([
      {
        name: 'chat_c1',
        activity: 1_800_000_000,
        created: 1_799_999_900,
        pid: 4321,
        command: 'claude',
        user: 'coco',
      },
      { name: 'foreign', activity: 1_800_000_000, created: 1_799_999_900, command: '', user: '' },
    ])
  })
})

describe('roster', () => {
  it('parses a valid operator roster and rejects malformed ones wholesale', () => {
    const parsed = parseRoster({
      default: 'work',
      cwd: '/srv',
      env: { FOO: 'bar' },
      commands: {
        work: { label: 'Work', cmd: ['claude', '--continue'], room: true },
        top: { label: 'Top', cmd: ['top'], room: false },
      },
    })!
    expect(parsed.default).toBe('work')
    expect(parsed.cwd).toBe('/srv')
    expect(parsed.commands.work.cmd).toEqual(['claude', '--continue'])
    // default falls back to the first key when missing/unknown
    expect(parseRoster({ commands: { a: { label: 'A', cmd: ['a'] } } })?.default).toBe('a')
    // malformed shapes → null (never a half-honored roster)
    expect(parseRoster(null)).toBeNull()
    expect(parseRoster({ commands: {} })).toBeNull()
    expect(parseRoster({ commands: { a: { label: 'A', cmd: [] } } })).toBeNull()
    expect(parseRoster({ commands: { a: { label: 'A', cmd: 'not-argv' } } })).toBeNull()
    expect(parseRoster({ commands: { a: { label: '', cmd: ['a'] } } })).toBeNull()
    expect(parseRoster({ commands: { 'bad key!': { label: 'A', cmd: ['a'] } } })).toBeNull()
    expect(parseRoster({ commands: { a: { label: 'A', cmd: ['a'], env: { X: 1 } } } })).toBeNull()
  })

  it('provider: missing file → defaults; malformed file → defaults + log', () => {
    const dir = tmp()
    const file = join(dir, 'den-term.json')
    const logs: string[] = []
    const provider = createRosterProvider(file, (m) => logs.push(m))
    expect(provider.get().commands.claude.label).toBe('Claude Code')
    expect(provider.get().default).toBe('claude')
    expect(logs).toEqual([]) // absent file is normal, not an error
    writeFileSync(file, '{ not json')
    expect(provider.get().commands.shell.cmd).toEqual(['bash', '-l'])
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatch(/malformed/)
  })

  it('provider re-reads the file lazily when it changes on disk', () => {
    const dir = tmp()
    const file = join(dir, 'den-term.json')
    const provider = createRosterProvider(file, () => {})
    writeFileSync(
      file,
      JSON.stringify({ commands: { a: { label: 'First', cmd: ['a'], room: false } } }),
    )
    expect(provider.get().commands.a.label).toBe('First')
    writeFileSync(
      file,
      JSON.stringify({ commands: { a: { label: 'Second edition', cmd: ['a'], room: false } } }),
    )
    expect(provider.get().commands.a.label).toBe('Second edition') // no restart needed
  })
})

// Real byte flow through a piped child process (resize is a no-op) — proves
// the manager works against something that isn't an EventEmitter script.
describe('piped real-process smoke', () => {
  const pipeSpawn: PtySpawn = (argv, opts) => {
    const child = childSpawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return {
      pid: child.pid ?? -1,
      write: (data) => void child.stdin.write(data),
      resize: () => {},
      kill: (signal) => void child.kill((signal ?? 'SIGHUP') as NodeJS.Signals),
      onData: (cb) => {
        child.stdout.on('data', cb)
        child.stderr.on('data', cb)
      },
      onExit: (cb) => void child.on('exit', (code) => cb(code)),
    }
  }

  it('streams bytes in and out of a real bash child and reaps it on kill', async () => {
    const roster: TermRoster = {
      default: 'cat',
      cwd: tmpdir(),
      env: {},
      commands: {
        cat: {
          label: 'Cat',
          cmd: ['bash', '-c', 'printf "sess=%s\\n" "$RIVET_DEN_SESSION"; cat'],
          room: false,
        },
      },
    }
    const { manager } = makeManager({}, { roster, spawn: pipeSpawn })
    const pty = manager.spawn('cat', 80, 24, '127.0.0.1')
    expect(pty.pid).toBeGreaterThan(0)
    // env made it into the real child
    await vi.waitFor(() =>
      expect(manager.scrollback(pty.id)?.toString()).toContain(`sess=${pty.denSession}`),
    )
    manager.write(pty.id, 'echo-me\n')
    await vi.waitFor(() => expect(manager.scrollback(pty.id)?.toString()).toContain('echo-me'))
    manager.kill(pty.id)
    await vi.waitFor(() => expect(manager.get(pty.id)?.state).toBe('exited'))
  })
})

// True node-pty path — skipped automatically when the optional native dep
// didn't build/install on this machine.
const realPtySpawn = await loadRealPtySpawn(() => {})
describe.skipIf(!realPtySpawn)('real node-pty smoke', () => {
  it('spawns a real pty, captures output and observes exit', async () => {
    const roster: TermRoster = {
      default: 'hello',
      cwd: tmpdir(),
      env: {},
      commands: {
        hello: { label: 'Hello', cmd: ['bash', '-c', 'echo real-pty-ok'], room: false },
      },
    }
    const { manager } = makeManager({}, { roster, spawn: realPtySpawn! })
    const pty = manager.spawn('hello', 80, 24, '127.0.0.1')
    await vi.waitFor(() => expect(manager.scrollback(pty.id)?.toString()).toContain('real-pty-ok'))
    await vi.waitFor(() => expect(manager.get(pty.id)?.state).toBe('exited'))
  })
})
