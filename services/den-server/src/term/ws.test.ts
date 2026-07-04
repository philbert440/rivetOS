// WS /term attach protocol: hello → replay → live framing, keystrokes,
// resize/kill control frames, exit → close, reattach vs the detached TTL,
// multi-attach fanout, destroyed upgrades, backpressure (per-client
// terminate + all-saturated pause/resume) and the heartbeat sweep.

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { spawn as childSpawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDenServer, type DenServer, type DenServerOptions } from '../server.js'
import type { DenConfig, DenTermConfig } from '../config.js'
import { createTermManager, type TermManager } from './manager.js'
import { defaultRoster } from './roster.js'
import type { PtyProc, PtySpawn, PtySpawnOpts } from './pty.js'
import { createTermWs, type TermSocket, type TermWs } from './ws.js'

class FakeProc extends EventEmitter implements PtyProc {
  writes: string[] = []
  resizes: [number, number][] = []
  kills: (string | undefined)[] = []
  pauses = 0
  resumes = 0
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
  pause(): void {
    this.pauses++
  }
  resume(): void {
    this.resumes++
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

// Scripted socket for the protocol-core unit tests: records sends/pings/
// terminations and lets a test set bufferedAmount directly.
class FakeSocket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent: { data: string | Buffer; binary: boolean }[] = []
  pings = 0
  closedWith: number | undefined
  terminated = false
  send(data: string | Buffer, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: opts?.binary ?? false })
  }
  close(code?: number): void {
    if (this.readyState === 3) return
    this.closedWith = code
    this.readyState = 3
    this.emit('close')
  }
  terminate(): void {
    if (this.readyState === 3) return
    this.terminated = true
    this.readyState = 3
    this.emit('close')
  }
  ping(): void {
    this.pings++
  }
  binaryFrames(): Buffer[] {
    return this.sent.filter((f) => f.binary).map((f) => Buffer.from(f.data as Buffer))
  }
  textFrames(): Record<string, unknown>[] {
    return this.sent
      .filter((f) => !f.binary)
      .map((f) => JSON.parse(String(f.data)) as Record<string, unknown>)
  }
}

const servers: DenServer[] = []
const managers: TermManager[] = []
const termWss: TermWs[] = []
const sockets: WebSocket[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  sockets.splice(0).forEach((ws) => ws.terminate())
  termWss.splice(0).forEach((t) => t.close())
  managers.splice(0).forEach((m) => m.close())
  await Promise.all(servers.splice(0).map((s) => s.close()))
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function baseConfig(stateDir: string, term: Partial<DenTermConfig> = {}): DenConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    token: '',
    stateDir,
    staticDir: '',
    packsDir: '',
    evictTtlMs: 60_000,
    meshFile: '',
    meshCacheMs: 10_000,
    term: {
      enabled: true,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      ...term,
    },
  }
}

interface StartResult {
  den: DenServer
  base: string
  port: number
  stateDir: string
  procs: FakeProc[]
  spawns: { argv: string[]; opts: PtySpawnOpts }[]
}

async function start(
  overrides: Partial<DenConfig> = {},
  term: Partial<DenTermConfig> = {},
  serverOpts?: DenServerOptions,
): Promise<StartResult> {
  const stateDir = mkdtempSync(join(tmpdir(), 'den-term-ws-'))
  dirs.push(stateDir)
  const config: DenConfig = { ...baseConfig(stateDir, term), ...overrides }
  const procs: FakeProc[] = []
  const spawns: { argv: string[]; opts: PtySpawnOpts }[] = []
  let pid = 7000
  const fakeSpawn: PtySpawn = (argv, opts) => {
    const proc = new FakeProc(++pid)
    procs.push(proc)
    spawns.push({ argv, opts })
    return proc
  }
  const den = createDenServer(config, serverOpts ?? { ptySpawn: fakeSpawn })
  servers.push(den)
  await new Promise<void>((r) => den.server.listen(0, '127.0.0.1', r))
  const port = (den.server.address() as AddressInfo).port
  return { den, base: `http://127.0.0.1:${port}`, port, stateDir, procs, spawns }
}

interface SpawnedPty {
  id: string
  denSession: string
}

async function spawnPty(base: string, command: string): Promise<SpawnedPty> {
  const res = await fetch(`${base}/term`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as SpawnedPty
}

interface Frame {
  binary: boolean
  data: Buffer
}

interface Attached {
  ws: WebSocket
  frames: Frame[]
  closed: Promise<number>
}

async function connect(port: number, query: string): Promise<Attached> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term?${query}`)
  sockets.push(ws)
  const frames: Frame[] = []
  ws.on('message', (d: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    const buf = Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d)
    frames.push({ binary: isBinary, data: buf })
  })
  const closed = new Promise<number>((r) => ws.on('close', (code: number) => r(code)))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, frames, closed }
}

const texts = (frames: Frame[]): Record<string, unknown>[] =>
  frames.filter((f) => !f.binary).map((f) => JSON.parse(f.data.toString()) as Record<string, unknown>)

/** server.test.ts style: did the upgrade complete or get destroyed? */
const upgradeResult = (port: number, query: string): Promise<'open' | 'rejected'> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term?${query}`)
  sockets.push(ws)
  return new Promise((resolve) => {
    ws.once('error', () => resolve('rejected'))
    ws.once('open', () => resolve('open'))
  })
}

describe('WS /term attach protocol', () => {
  it('sends hello first, the scrollback replay second (binary), then live output', async () => {
    const { port, base, procs } = await start()
    const pty = await spawnPty(base, 'shell')
    procs[0].emitData('before-')
    procs[0].emitData('attach')

    const { ws, frames } = await connect(port, `id=${pty.id}`)
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2))
    expect(frames[0].binary).toBe(false)
    expect(JSON.parse(frames[0].data.toString())).toEqual({
      type: 'hello',
      v: 1,
      id: pty.id,
      denSession: pty.denSession,
      command: 'shell',
      cols: 80,
      rows: 24,
      state: 'running',
    })
    expect(frames[1].binary).toBe(true)
    expect(frames[1].data.toString()).toBe('before-attach')

    procs[0].emitData('live!')
    await vi.waitFor(() => expect(frames).toHaveLength(3))
    expect(frames[2].binary).toBe(true)
    expect(frames[2].data.toString()).toBe('live!')
    ws.close()
  })

  it('resolves ?session= to the linked pty and replays an EMPTY binary frame for fresh ptys', async () => {
    const { port, base } = await start()
    const pty = await spawnPty(base, 'shell')
    const { ws, frames } = await connect(port, `session=${pty.denSession}`)
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(JSON.parse(frames[0].data.toString())).toMatchObject({ type: 'hello', id: pty.id })
    expect(frames[1].binary).toBe(true)
    expect(frames[1].data.length).toBe(0) // no output yet — still framed
    ws.close()
  })

  it('binary client frames are raw keystrokes into the pty', async () => {
    const { port, base, procs } = await start()
    const pty = await spawnPty(base, 'shell')
    const { ws } = await connect(port, `id=${pty.id}`)
    ws.send(Buffer.from('ls\r'))
    ws.send(Buffer.from([0x03])) // ^C — arbitrary bytes, not just text
    await vi.waitFor(() => expect(procs[0].writes).toEqual(['ls\r', '\x03']))
    ws.close()
  })

  it('resize control clamps to 20-500/5-200, updates the record; garbage frames are ignored', async () => {
    const { port, base, procs } = await start()
    const pty = await spawnPty(base, 'shell')
    const { ws, frames } = await connect(port, `id=${pty.id}`)
    ws.send(JSON.stringify({ type: 'resize', cols: 10_000, rows: 1 }))
    await vi.waitFor(() => expect(procs[0].resizes).toEqual([[500, 5]]))

    // garbage control traffic must neither resize nor kill the connection
    ws.send(JSON.stringify({ type: 'resize', cols: 'wat', rows: 30 }))
    ws.send(JSON.stringify({ type: 'mystery' }))
    ws.send('not json at all')
    procs[0].emitData('still-alive')
    await vi.waitFor(() =>
      expect(frames.some((f) => f.binary && f.data.toString() === 'still-alive')).toBe(true),
    )
    expect(procs[0].resizes).toEqual([[500, 5]])
    expect(procs[0].kills).toEqual([])

    // the record carries the new size — a second attacher's hello reflects it
    const second = await connect(port, `id=${pty.id}`)
    await vi.waitFor(() => expect(second.frames.length).toBeGreaterThanOrEqual(1))
    expect(JSON.parse(second.frames[0].data.toString())).toMatchObject({ cols: 500, rows: 5 })
    ws.close()
    second.ws.close()
  })

  it('kill control frame kills like DELETE /term; exit → exit frame then close(1000)', async () => {
    const { port, base, procs } = await start()
    const pty = await spawnPty(base, 'shell')
    const { ws, frames, closed } = await connect(port, `id=${pty.id}`)
    ws.send(JSON.stringify({ type: 'kill' }))
    await vi.waitFor(() => expect(procs[0].kills).toEqual(['SIGHUP']))
    procs[0].emitData('final words')
    procs[0].emitExit(null)
    expect(await closed).toBe(1000)
    // output that raced the exit still arrived before the exit frame
    const lastBinary = frames.filter((f) => f.binary).at(-1)!
    expect(lastBinary.data.toString()).toBe('final words')
    expect(texts(frames).at(-1)).toEqual({ type: 'exit', code: null })
  })

  it('late attach to an exited-but-lingering pty: hello(exited) + replay + exit frame + close', async () => {
    const { port, base, procs } = await start()
    const pty = await spawnPty(base, 'shell')
    procs[0].emitData('goodbye world')
    procs[0].emitExit(3)

    const { frames, closed } = await connect(port, `id=${pty.id}`)
    expect(await closed).toBe(1000)
    expect(frames).toHaveLength(3)
    expect(JSON.parse(frames[0].data.toString())).toMatchObject({
      type: 'hello',
      state: 'exited',
      exitCode: 3,
    })
    expect(frames[1].binary).toBe(true)
    expect(frames[1].data.toString()).toBe('goodbye world')
    expect(JSON.parse(frames[2].data.toString())).toEqual({ type: 'exit', code: 3 })
  })

  it('mirrors output to two concurrent attachments; both may type', async () => {
    const { port, base, procs } = await start()
    const pty = await spawnPty(base, 'shell')
    const a = await connect(port, `id=${pty.id}`)
    const b = await connect(port, `id=${pty.id}`)
    procs[0].emitData('for-everyone')
    await vi.waitFor(() => {
      expect(a.frames.some((f) => f.binary && f.data.toString() === 'for-everyone')).toBe(true)
      expect(b.frames.some((f) => f.binary && f.data.toString() === 'for-everyone')).toBe(true)
    })
    a.ws.send(Buffer.from('from-a '))
    b.ws.send(Buffer.from('from-b'))
    await vi.waitFor(() => expect(procs[0].writes.join('')).toContain('from-a'))
    await vi.waitFor(() => expect(procs[0].writes.join('')).toContain('from-b'))
    a.ws.close()
    b.ws.close()
  })

  it('DELETE /session on the linked den session kills the pty; the client sees exit + close', async () => {
    const { port, base, procs } = await start()
    const pty = await spawnPty(base, 'claude')
    await fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, session: pty.denSession, type: 'session.start', title: 't' }),
    })
    const { frames, closed } = await connect(port, `id=${pty.id}`)
    const res = await fetch(`${base}/session?session=${pty.denSession}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(procs[0].kills).toEqual(['SIGHUP'])
    procs[0].emitExit(null)
    expect(await closed).toBe(1000)
    expect(texts(frames).at(-1)).toEqual({ type: 'exit', code: null })
  })

  it('destroys upgrades for unknown ids, unknown sessions and missing params', async () => {
    const { port, base } = await start()
    await spawnPty(base, 'shell') // terminals demonstrably work…
    expect(await upgradeResult(port, 'id=pty-missing')).toBe('rejected')
    expect(await upgradeResult(port, 'session=den-nope')).toBe('rejected')
    expect(await upgradeResult(port, '')).toBe('rejected')
  })

  it('destroys upgrades without a valid token; accepts ?token= like /ws', async () => {
    const { port, base } = await start({ token: 'sekrit' })
    const res = await fetch(`${base}/term`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sekrit' },
      body: JSON.stringify({ command: 'shell' }),
    })
    const pty = (await res.json()) as SpawnedPty
    expect(await upgradeResult(port, `id=${pty.id}`)).toBe('rejected')
    expect(await upgradeResult(port, `id=${pty.id}&token=wrong`)).toBe('rejected')
    expect(await upgradeResult(port, `id=${pty.id}&token=sekrit`)).toBe('open')
  })

  it('destroys upgrades when terminals are disabled, gated or node-pty is absent', async () => {
    const disabled = await start({}, { enabled: false })
    expect(await upgradeResult(disabled.port, 'id=pty-x')).toBe('rejected')

    // security gate: enabled + no token + non-loopback → terminals forced off
    const gated = await start({ host: '0.0.0.0', token: '' })
    expect(await upgradeResult(gated.port, 'id=pty-x')).toBe('rejected')

    const noPty = await start({}, {}, { ptySpawn: null })
    expect(await upgradeResult(noPty.port, 'id=pty-x')).toBe('rejected')

    // the /ws channel is untouched by any of it
    const ok = new WebSocket(`ws://127.0.0.1:${disabled.port}/ws`)
    sockets.push(ok)
    await new Promise((r, j) => {
      ok.once('open', r)
      ok.once('error', j)
    })
    ok.close()
  })
})

// Protocol core driven with scripted sockets: TTL interaction, backpressure
// and the heartbeat need exact control over timers and bufferedAmount.
describe('WS /term protocol core (scripted sockets)', () => {
  interface CoreHarness {
    manager: TermManager
    termWs: TermWs
    procs: FakeProc[]
  }

  function makeCore(term: Partial<DenTermConfig> = {}): CoreHarness {
    const stateDir = mkdtempSync(join(tmpdir(), 'den-term-ws-core-'))
    dirs.push(stateDir)
    const procs: FakeProc[] = []
    let pid = 9000
    const spawn: PtySpawn = () => {
      const proc = new FakeProc(++pid)
      procs.push(proc)
      return proc
    }
    const manager = createTermManager(baseConfig(stateDir, term), {
      spawn,
      roster: () => defaultRoster(),
      ingest: () => {},
      log: () => {},
    })
    managers.push(manager)
    const termWs = createTermWs({ manager: () => Promise.resolve(manager), enabled: () => true })
    termWss.push(termWs)
    return { manager, termWs, procs }
  }

  it('detach re-arms the detached TTL; reattach cancels it and replays scrollback byte-exact', () => {
    vi.useFakeTimers()
    const { manager, termWs, procs } = makeCore({ detachedTtlMs: 1000 })
    const pty = manager.spawn('shell', 80, 24, '')
    const bytes = Buffer.from('héllo \x1b[31mred\x1b[0m \u{1F980}', 'utf8')
    procs[0].emitData(bytes)

    const sock1 = new FakeSocket()
    termWs.attach(manager, pty.id, sock1)
    vi.advanceTimersByTime(5000)
    expect(procs[0].kills).toEqual([]) // attached — TTL held off

    sock1.close() // browser tab closed ≠ kill
    expect(procs[0].kills).toEqual([])
    vi.advanceTimersByTime(500)

    const sock2 = new FakeSocket()
    termWs.attach(manager, pty.id, sock2) // reattach cancels the pending TTL
    vi.advanceTimersByTime(5000)
    expect(procs[0].kills).toEqual([])
    // replay is byte-exact, hello first
    expect(sock2.textFrames()[0]).toMatchObject({ type: 'hello', id: pty.id, state: 'running' })
    expect(sock2.binaryFrames()[0].equals(bytes)).toBe(true)

    sock2.close() // last detach re-arms the TTL from scratch
    vi.advanceTimersByTime(999)
    expect(procs[0].kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(procs[0].kills).toEqual(['SIGHUP'])
  })

  it('terminates a single client buffered past the 1MB cap (same rule as /ws)', () => {
    const { manager, termWs, procs } = makeCore()
    const pty = manager.spawn('shell', 80, 24, '')
    const slow = new FakeSocket()
    const fast = new FakeSocket()
    termWs.attach(manager, pty.id, slow)
    termWs.attach(manager, pty.id, fast)
    slow.bufferedAmount = 1024 * 1024 + 1
    procs[0].emitData('overflow')
    expect(slow.terminated).toBe(true)
    expect(slow.binaryFrames().map(String)).toEqual(['']) // replay only, no overflow frame
    expect(fast.terminated).toBe(false)
    expect(fast.binaryFrames().map(String)).toEqual(['', 'overflow'])
    expect(manager.get(pty.id)?.attached).toBe(1) // the dead client detached
  })

  it('pauses the pty when ALL clients are saturated; resumes when one drains', () => {
    vi.useFakeTimers()
    const { manager, termWs, procs } = makeCore()
    const pty = manager.spawn('shell', 80, 24, '')
    const a = new FakeSocket()
    const b = new FakeSocket()
    termWs.attach(manager, pty.id, a)
    termWs.attach(manager, pty.id, b)

    a.bufferedAmount = 300 * 1024
    procs[0].emitData('x')
    expect(procs[0].pauses).toBe(0) // b keeps up — no pause

    b.bufferedAmount = 300 * 1024
    procs[0].emitData('y')
    expect(procs[0].pauses).toBe(1) // everyone saturated → pause the source
    procs[0].emitData('z')
    expect(procs[0].pauses).toBe(1) // idempotent while paused

    a.bufferedAmount = 0 // one reader drained
    vi.advanceTimersByTime(100) // drain poll
    expect(procs[0].resumes).toBe(1)

    // a pty must never stay paused once nobody is attached
    a.bufferedAmount = b.bufferedAmount = 300 * 1024
    procs[0].emitData('w')
    expect(procs[0].pauses).toBe(2)
    a.close()
    b.close()
    expect(procs[0].resumes).toBe(2)
  })

  it('folds term clients into the ping/pong heartbeat sweep', () => {
    const { manager, termWs, procs } = makeCore()
    const pty = manager.spawn('shell', 80, 24, '')
    const responsive = new FakeSocket()
    const silent = new FakeSocket()
    termWs.attach(manager, pty.id, responsive)
    termWs.attach(manager, pty.id, silent)

    termWs.heartbeat()
    expect(responsive.pings).toBe(1)
    expect(silent.pings).toBe(1)
    responsive.emit('pong') // only one peer answers

    termWs.heartbeat()
    expect(responsive.terminated).toBe(false)
    expect(responsive.pings).toBe(2)
    expect(silent.terminated).toBe(true) // half-open socket reaped
    expect(manager.get(pty.id)?.attached).toBe(1)
    expect(procs[0].kills).toEqual([]) // heartbeat reaps sockets, not ptys
  })
})

// End-to-end through a real server AND a real child process: bytes go over a
// real websocket into bash's stdin and its output comes back as binary.
describe('piped real-process e2e', () => {
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

  it('attach → echo hi → binary output → kill control → exit frame → close 1000', async () => {
    const { port, base, stateDir } = await start({}, {}, { ptySpawn: pipeSpawn })
    writeFileSync(
      join(stateDir, 'den-term.json'),
      JSON.stringify({
        default: 'bash',
        cwd: tmpdir(),
        commands: { bash: { label: 'Bash', cmd: ['bash'], room: false } },
      }),
    )
    const pty = await spawnPty(base, 'bash')
    const { ws, frames, closed } = await connect(port, `id=${pty.id}`)
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2)) // hello + replay

    ws.send(Buffer.from('echo hi\n'))
    await vi.waitFor(() =>
      expect(frames.some((f) => f.binary && f.data.toString().includes('hi'))).toBe(true),
    )

    ws.send(JSON.stringify({ type: 'kill' }))
    expect(await closed).toBe(1000)
    expect(texts(frames).at(-1)).toMatchObject({ type: 'exit' })

    // reattach within the exit linger replays the whole exited story
    const again = await connect(port, `id=${pty.id}`)
    expect(await again.closed).toBe(1000)
    expect(texts(again.frames)[0]).toMatchObject({ type: 'hello', state: 'exited' })
    expect(again.frames.some((f) => f.binary && f.data.toString().includes('hi'))).toBe(true)
  })
})
