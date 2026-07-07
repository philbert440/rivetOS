import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DenConfig, DenTermConfig } from '../config.js'
import { createTermManager, TermSpawnError, type TermManager } from './manager.js'
import { loadRealPtySpawn, type PtyProc, type PtySpawn, type PtySpawnOpts } from './pty.js'
import { createRosterProvider, defaultRoster, parseRoster, type TermRoster } from './roster.js'

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
  } = {},
): Harness {
  const stateDir = tmp()
  const config: DenConfig = {
    port: extra.port ?? 5199,
    host: '127.0.0.1',
    token: extra.token ?? '',
    stateDir,
    staticDir: '',
    packsDir: '',
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
      exitLingerMs: 60_000,
      ...term,
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
    // linkage map
    expect(manager.ptyForSession(pty.denSession)).toBe(pty.id)
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

    // grok gets the same flags (it also has --session-id/--resume)
    const grokNew = makeManager({}, { sessionExists: () => false })
    grokNew.manager.spawn('grok', 80, 24, '', uuid)
    expect(grokNew.spawns[0].argv).toEqual(['grok', '--session-id', uuid])
    const grokResume = makeManager({}, { sessionExists: () => true })
    grokResume.manager.spawn('grok', 80, 24, '', uuid)
    expect(grokResume.spawns[0].argv).toEqual(['grok', '--resume', uuid])

    // hermes: --resume only (no sessionFlag). A new session (not in the
    // store) gets NO flag — hermes can't pin an id; an existing one resumes,
    // and hermes ids need not be UUIDs.
    const hermesNew = makeManager({}, { sessionExists: () => false })
    hermesNew.manager.spawn('hermes', 80, 24, '', uuid)
    expect(hermesNew.spawns[0].argv).toEqual(['hermes'])
    const hermesResume = makeManager({}, { sessionExists: () => true })
    hermesResume.manager.spawn('hermes', 80, 24, '', 'sess_abc123')
    expect(hermesResume.spawns[0].argv).toEqual(['hermes', '--resume', 'sess_abc123'])

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
    manager.inject(a.id, 'still here\r')
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
    for (let i = 0; i < 32; i++) expect(manager.inject(pty.id, `${String(i)}\r`)).toBe(true)
    expect(manager.inject(pty.id, 'overflow\r')).toBe(false)
  })

  it('inject ready-gate (5g): buffers until first output settles, then flushes', () => {
    vi.useFakeTimers()
    const { manager, procs } = makeManager({ injectReadyMs: 300 })
    const pty = manager.spawn('claude', 80, 24, '', 'chat-r')
    // inject before any output → buffered, not written
    expect(manager.inject(pty.id, 'hello\r')).toBe(true)
    expect(procs[0].writes).toEqual([])
    // first output starts the settle timer; still buffered until it fires
    procs[0].emitData('welcome to claude')
    expect(procs[0].writes).toEqual([])
    vi.advanceTimersByTime(300)
    expect(procs[0].writes).toEqual(['hello\r']) // flushed after settle
    // once ready, a later inject writes through immediately
    manager.inject(pty.id, 'again\r')
    expect(procs[0].writes).toEqual(['hello\r', 'again\r'])
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
    const { manager, procs } = makeManager({ detachedTtlMs: 1000 })
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
    const { manager, procs } = makeManager({ detachedTtlMs: 1000 })
    const pty = manager.spawn('shell', 80, 24, '')
    const detach = manager.attach(pty.id, () => {})!
    vi.advanceTimersByTime(5000)
    expect(procs[0].kills).toEqual([]) // attached — no reaper
    detach()
    vi.advanceTimersByTime(1000)
    expect(procs[0].kills).toEqual(['SIGHUP'])
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
        cat: { label: 'Cat', cmd: ['bash', '-c', 'printf "sess=%s\\n" "$RIVET_DEN_SESSION"; cat'], room: false },
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
