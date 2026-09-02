import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createDenServer, type DenServer } from './server.js'
import type { DenConfig } from './config.js'
import { baseTestDenConfig, emptyTls } from './test-config.js'
import type { PtyProc } from './term/pty.js'

// Inspectable fake PTY for terminal/inject tests.
const fakeProcs: FakeProc[] = []
class FakeProc extends EventEmitter implements PtyProc {
  writes: string[] = []
  constructor(public readonly pid: number) {
    super()
    fakeProcs.push(this)
  }
  write(data: string | Buffer): void {
    this.writes.push(data.toString())
  }
  resize(): void {}
  kill(): void {}
  onData(cb: (data: string | Buffer) => void): void {
    this.on('data', cb)
  }
  onExit(cb: (code: number | null) => void): void {
    this.on('exit', cb)
  }
}

const servers: DenServer[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

async function start(
  _token = '', // ignored — bearer removed; loopback tests need no client cert
  evictTtlMs = 60_000,
  opts: {
    staticDir?: string
    extraRoutes?: Array<{
      prefix: string
      handler: (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
      ) => void
    }>
    extraUpgrades?: Array<{
      path: string
      handle: (
        req: import('node:http').IncomingMessage,
        socket: import('node:stream').Duplex,
        head: Buffer,
        url: URL,
      ) => void
    }>
    term?: boolean
  } = {},
): Promise<{ den: DenServer; base: string; port: number }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'den-server-'))
  dirs.push(stateDir)
  const config: DenConfig = baseTestDenConfig(stateDir, {
    port: 0,
    host: '127.0.0.1',
    staticDir: opts.staticDir ?? '',
    evictTtlMs,
    term: {
      enabled: opts.term ?? false,
      open: opts.term ?? false,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      idleTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      injectReadyMs: 10,
    },
  })
  let pid = 2000
  const den = createDenServer(config, {
    extraRoutes: opts.extraRoutes,
    extraUpgrades: opts.extraUpgrades,
    ...(opts.term ? { ptySpawn: () => new FakeProc(++pid) } : {}),
  })
  servers.push(den)
  await new Promise<void>((r) => den.server.listen(0, '127.0.0.1', r))
  const port = (den.server.address() as AddressInfo).port
  return { den, base: `http://127.0.0.1:${port}`, port }
}

const EV = { v: 1, session: 's1', name: 'alpha', ts: 100, type: 'session.start', title: 'hello' }

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('den-server', () => {
  it('ingests events, exposes sessions and state', async () => {
    const { den, base } = await start()
    expect((await post(base, '/event', EV)).status).toBe(200)
    expect((await post(base, '/event', { ...EV, type: 'nope' })).status).toBe(422)
    expect((await post(base, '/event', 'garbage')).status).toBe(422)

    const sessions = (await (await fetch(`${base}/sessions`)).json()) as {
      sessions: { id: string; name: string }[]
    }
    expect(sessions.sessions).toHaveLength(1)
    expect(sessions.sessions[0].name).toBe('alpha')

    const st = (await (await fetch(`${base}/state?session=s1`)).json()) as {
      state: { title: string }
    }
    expect(st.state.title).toBe('hello')
    expect((await fetch(`${base}/state?session=missing`)).status).toBe(404)
    expect(den.state().rooms.s1.title).toBe('hello')
  })

  it('sends a snapshot on WS connect, then live events (session-filtered)', async () => {
    const { base, port } = await start()
    await post(base, '/event', EV)
    await post(base, '/event', { v: 1, session: 's2', type: 'session.start', title: 'other' })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=s1`)
    const messages: Record<string, unknown>[] = []
    ws.on('message', (d: Buffer) =>
      messages.push(JSON.parse(d.toString()) as Record<string, unknown>),
    )
    await new Promise((r) => ws.once('open', r))
    await new Promise((r) => setTimeout(r, 50))

    expect(messages[0].type).toBe('snapshot')
    expect(Object.keys(messages[0].rooms as object)).toEqual(['s1'])

    await post(base, '/event', { v: 1, session: 's1', type: 'term.line', text: 'hi' })
    await post(base, '/event', { v: 1, session: 's2', type: 'term.line', text: 'not for us' })
    await new Promise((r) => setTimeout(r, 50))
    ws.close()

    const live = messages.slice(1)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ type: 'term.line', session: 's1' })
  })

  it('persists and serves per-viewer layouts with default fallback', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/layout`)).status).toBe(404)
    expect((await post(base, '/layout?viewer=default', { desk: { x: 1 } })).status).toBe(200)
    // unknown viewer falls back to the shared default
    const fromOther = (await (await fetch(`${base}/layout?viewer=phil`)).json()) as Record<
      string,
      unknown
    >
    expect(fromOther.desk).toEqual({ x: 1 })
    await post(base, '/layout?viewer=phil', { desk: { x: 2 } })
    const own = (await (await fetch(`${base}/layout?viewer=phil`)).json()) as Record<
      string,
      unknown
    >
    expect(own.desk).toEqual({ x: 2 })
    expect((await post(base, '/layout?viewer=../evil', {})).status).toBe(400)
    const rawBad = await fetch(`${base}/layout`, { method: 'POST', body: 'not json' })
    expect(rawBad.status).toBe(400)
  })

  it('ingests ordered batches via /events', async () => {
    const { den, base } = await start()
    const batch = [
      EV,
      { v: 1, session: 's1', type: 'tool.start', tool: 'Bash' },
      { v: 1, session: 's1', type: 'term.line', text: '$ ls' },
      { v: 1, session: 's1', type: 'tool.end' },
    ]
    const res = await post(base, '/events', batch)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ingested: number }).ingested).toBe(4)
    expect(den.state().rooms.s1.term).toEqual(['$ ls'])
    expect(den.state().rooms.s1.activity).toBe('thinking') // tool.end applied last

    expect((await post(base, '/events', [])).status).toBe(400)
    expect((await post(base, '/events', { not: 'an array' })).status).toBe(400)
    const mixed = await post(base, '/events', [EV, { garbage: true }])
    expect(mixed.status).toBe(422)
    expect(((await mixed.json()) as { error: string }).error).toMatch(/event\[1\]/)
  })

  it('survives a hard-killed WS client', async () => {
    const { base, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((r) => ws.once('open', r))
    ws.terminate() // no close frame — the ungraceful drop that used to crash
    await new Promise((r) => setTimeout(r, 50))
    expect((await post(base, '/event', EV)).status).toBe(200)
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })

  it('evicts ended sessions after the TTL and broadcasts removal', async () => {
    const { den, base, port } = await start('', 40)
    await post(base, '/event', EV)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const messages: Record<string, unknown>[] = []
    ws.on('message', (d: Buffer) =>
      messages.push(JSON.parse(d.toString()) as Record<string, unknown>),
    )
    await new Promise((r) => ws.once('open', r))

    await post(base, '/event', { v: 1, session: 's1', type: 'session.end' })
    expect(den.state().rooms.s1.ended).toBe(true) // still visible, asleep
    await new Promise((r) => setTimeout(r, 120))
    expect(den.state().rooms.s1).toBeUndefined()
    expect(den.state().sessions.s1).toBeUndefined()
    expect(messages.some((m) => m.type === 'session.removed' && m.session === 's1')).toBe(true)
    ws.close()
  })

  it('a fresh session.start cancels a pending eviction', async () => {
    const { den, base } = await start('', 40)
    await post(base, '/event', EV)
    await post(base, '/event', { v: 1, session: 's1', type: 'session.end' })
    await post(base, '/event', { ...EV, title: 'resumed' })
    await new Promise((r) => setTimeout(r, 120))
    expect(den.state().rooms.s1.title).toBe('resumed')
  })

  it('413s oversized bodies with a response the client can read', async () => {
    const { base } = await start()
    const big = 'x'.repeat(300 * 1024)
    const res = await fetch(`${base}/event`, { method: 'POST', body: big }).catch(() => null)
    expect(res?.status).toBe(413)
  })

  it('loopback allows APIs and WS without client certs; bearer is ignored', async () => {
    const { base, port } = await start()
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect((await post(base, '/event', EV)).status).toBe(200)
    expect((await fetch(`${base}/sessions`)).status).toBe(200)
    // legacy bearer / ?token= must not be required (and do not gate)
    expect((await fetch(`${base}/sessions?token=sekrit`)).status).toBe(200)

    const ok = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((r, j) => {
      ok.once('open', r)
      ok.once('error', j)
    })
    ok.close()
  })

  it('refuses non-loopback bind without TLS', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'den-server-'))
    dirs.push(stateDir)
    expect(() => createDenServer(baseTestDenConfig(stateDir, { host: '0.0.0.0' }))).toThrow(
      /TLS is required off-loopback/,
    )
  })

  it('serves the hub shell on loopback; mesh.json is not shadowed by static', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'den-static-'))
    dirs.push(staticDir)
    mkdirSync(join(staticDir, 'assets'))
    mkdirSync(join(staticDir, 'den'))
    writeFileSync(join(staticDir, 'index.html'), '<html>shell</html>')
    writeFileSync(join(staticDir, 'den', 'index.html'), '<html>nested-den</html>')
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'js')
    writeFileSync(join(staticDir, 'mesh.json'), '{"spoof":true}')

    const { base } = await start('', 60_000, { staticDir })
    expect((await fetch(`${base}/index.html`)).status).toBe(200)
    expect((await fetch(`${base}/assets/app.js`)).status).toBe(200)
    expect((await fetch(`${base}/`)).status).toBe(200)
    expect((await fetch(`${base}/mesh`)).status).toBe(200)
    expect(await (await fetch(`${base}/den/mesh`)).text()).toBe('<html>shell</html>')
    expect(await (await fetch(`${base}/demo`)).text()).toBe('<html>shell</html>')
    // Static must not shadow the mesh API with a spoofed mesh.json file
    const mesh = await fetch(`${base}/mesh.json`)
    const body = mesh.status === 200 ? await mesh.json() : null
    expect(body).not.toEqual({ spoof: true })
  })
})

describe('gateway route mounts (G0)', () => {
  const ping = {
    prefix: '/api/ping',
    handler: (
      _req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ pong: true }))
    },
  }

  it('serves mounted routes on loopback without a client cert', async () => {
    const { base } = await start('', 60_000, { extraRoutes: [ping] })
    const ok = await fetch(`${base}/api/ping`)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ pong: true })
  })

  it('extraUpgrades WS mounts still go through authorized() (loopback allows)', async () => {
    const seen: string[] = []
    const upgrade = {
      path: '/api/notifications/ws',
      handle: (
        _req: import('node:http').IncomingMessage,
        socket: import('node:stream').Duplex,
        _head: Buffer,
        _url: URL,
      ) => {
        seen.push('handled')
        socket.destroy()
      },
    }
    const { base } = await start('', 60_000, { extraUpgrades: [upgrade] })
    const wsUrl = base.replace('http', 'ws') + '/api/notifications/ws'

    const attempt = (url: string): Promise<'open' | 'rejected'> =>
      new Promise((resolve) => {
        const ws = new WebSocket(url)
        ws.on('open', () => {
          resolve('open')
          ws.close()
        })
        ws.on('error', () => resolve('rejected'))
      })

    // loopback authorized → upgrade handler runs and destroys → rejected from client view
    expect(await attempt(wsUrl)).toBe('rejected')
    expect(seen).toEqual(['handled'])
  })

  it('gateway mounts carry CORS headers (cross-node browser clients)', async () => {
    const { base } = await start('', 60_000, { extraRoutes: [ping] })
    const res = await fetch(`${base}/api/ping`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('preflights PATCH for cross-origin agent edits', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/api/agents`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH')
  })

  it('longest prefix wins and subpaths route to the mount', async () => {
    const deep = {
      prefix: '/api/ping/deep',
      handler: (
        _req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
      ) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ deep: true }))
      },
    }
    const { base } = await start('', 60_000, { extraRoutes: [ping, deep] })
    expect(await (await fetch(`${base}/api/ping/deep/x`)).json()).toEqual({ deep: true })
    expect(await (await fetch(`${base}/api/ping/other`)).json()).toEqual({ pong: true })
  })

  it('den routes are untouched by mounts', async () => {
    const { base } = await start('', 60_000, { extraRoutes: [ping] })
    const res = await post(base, '/event', EV)
    expect(res.status).toBe(200)
    const body = (await (await fetch(`${base}/sessions`)).json()) as { sessions: unknown[] }
    expect(body.sessions).toHaveLength(1)
  })

  it('OpenAI /v1 mounts work on loopback with CORS', async () => {
    const v1 = {
      prefix: '/v1',
      handler: (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
      ) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'claude', object: 'model', owned_by: 'rivetos' }],
            }),
          )
          return
        }
        res.writeHead(404).end()
      },
    }
    const { base } = await start('', 60_000, { extraRoutes: [v1] })
    const ok = await fetch(`${base}/v1/models`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    expect(await ok.json()).toMatchObject({ object: 'list' })

    const pre = await fetch(`${base}/v1/models`, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    const allow = pre.headers.get('access-control-allow-headers') ?? ''
    expect(allow.toLowerCase()).toContain('x-rivet-conversation')
  })
})

describe('POST /term/inject (seamless modes 5c)', () => {
  it('writes a chat turn into the session harness stdin', async () => {
    fakeProcs.length = 0
    const { base } = await start('', 60_000, { term: true })
    // spawn the conversation's harness with the join key
    const spawn = await post(base, '/term', { command: 'shell', session: 'chat-x' })
    expect(spawn.status).toBe(201)
    // ready-gate (5g): the harness must emit output before injects flush
    fakeProcs[0].emit('data', Buffer.from('welcome'))
    await new Promise((r) => setTimeout(r, 30)) // let the settle timer fire
    // inject a chat turn
    const inj = await post(base, '/term/inject', { session: 'chat-x', text: 'hello world' })
    expect(inj.status).toBe(202)
    expect(((await inj.json()) as { ptyId: string }).ptyId).toMatch(/^pty-/)
    // it reached the (only) fake pty: text as one bracketed-paste write...
    expect(fakeProcs[0].writes).toContain('\x1b[200~hello world\x1b[201~')
    // ...then the submit CR as a SEPARATE delayed write (fused CR is swallowed
    // by the harness paste heuristic as a newline instead of submitting).
    await new Promise((r) => setTimeout(r, 120)) // injectSubmitDelayMs:80 + slack
    expect(fakeProcs[0].writes).toContain('\r')
    // submit:false writes the text verbatim (no paste wrap, no CR). It still
    // serializes behind the prior turn's chain, so allow the stagger to drain.
    await post(base, '/term/inject', { session: 'chat-x', text: 'raw', submit: false })
    await new Promise((r) => setTimeout(r, 120))
    expect(fakeProcs[0].writes).toContain('raw')
  })

  it('validates and 409s a session with no live harness', async () => {
    const { base } = await start('', 60_000, { term: true })
    expect((await post(base, '/term/inject', { text: 'hi' })).status).toBe(400) // no session
    expect((await post(base, '/term/inject', { session: 'x' })).status).toBe(400) // no text
    expect((await post(base, '/term/inject', { session: 'nope', text: 'hi' })).status).toBe(409)
  })

  it('is reachable via the /api/terminal/inject alias', async () => {
    const { base } = await start('', 60_000, { term: true })
    await post(base, '/term', { command: 'shell', session: 'chat-y' })
    expect(
      (await post(base, '/api/terminal/inject', { session: 'chat-y', text: 'hi' })).status,
    ).toBe(202)
  })

  it('the transcript route decodes an encoded canonical id and echoes it', async () => {
    // The doc table advertises this surface as canonical-capable, but the
    // canonical shape only survives the URL as `%3A` — an undecoded segment
    // would reach denSessionRef unparseable and silently answer empty.
    const home = mkdtempSync(join(tmpdir(), 'den-tx-http-'))
    dirs.push(home)
    const id = 'a1b2c3d4-1111-4222-8333-444455556666'
    const slug = join(home, 'projects', '-home-rivet')
    mkdirSync(slug, { recursive: true })
    writeFileSync(
      join(slug, `${id}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: 'over http' } }) + '\n',
    )
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = home
    try {
      const { base } = await start('', 60_000, { term: true })
      const canonical = `claude-code:${id}`
      const res = await fetch(
        `${base}/term/harness-sessions/${encodeURIComponent(canonical)}/transcript`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: string; command: string; turns: { text: string }[] }
      expect(body.command).toBe('claude')
      expect(body.turns.map((t) => t.text)).toEqual(['over http'])
      expect(body.id).toBe(canonical) // echoed as asked, not as the room key
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })

  it('non-session room keys survive every flipped edge byte-exact', async () => {
    // The den's key space is not all sessions: `task:<id>` is the task
    // engine's namespace and `den-pty-…` is an unpinned PTY's synthetic room.
    // Unit tests pin the passthrough; this pins the HTTP/WS wiring around it.
    const { base } = await start('', 60_000, { term: true })
    for (const room of ['task:9f2c', 'den-pty-1a2b3c4d', 'unknown-4211']) {
      await post(base, '/event', { ...EV, session: room, title: `title-${room}` })
      const st = (await (
        await fetch(`${base}/state?session=${encodeURIComponent(room)}`)
      ).json()) as { session: string; state: { title: string } }
      expect(st.session).toBe(room)
      expect(st.state.title).toBe(`title-${room}`)

      const { sessions } = (await (await fetch(`${base}/sessions`)).json()) as {
        sessions: { id: string }[]
      }
      expect(sessions.some((s) => s.id === room)).toBe(true)

      // …and DELETE addresses the same literal room
      expect(
        (await fetch(`${base}/session?session=${encodeURIComponent(room)}`, { method: 'DELETE' }))
          .status,
      ).toBe(200)
    }
  })

  it('GET /state resolves a canonical id and echoes it back verbatim', async () => {
    // Echo-as-asked, matching the transcript read and the transcript watch: a
    // client keyed on canonical SessionIds has to be able to correlate the
    // response with the thread it asked about. Resolution stays internal.
    const { base } = await start('', 60_000, { term: true })
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    await post(base, '/event', { ...EV, session: uuid })

    const bare = (await (await fetch(`${base}/state?session=${uuid}`)).json()) as {
      session: string
      state: { title: string }
    }
    expect(bare).toMatchObject({ session: uuid, state: { title: 'hello' } })

    const canonical = (await (
      await fetch(`${base}/state?session=${encodeURIComponent(`claude-code:${uuid}`)}`)
    ).json()) as { session: string; state: { title: string } }
    expect(canonical.state.title).toBe('hello') // same room
    expect(canonical.session).toBe(`claude-code:${uuid}`) // asked id, not the room key
  })

  it('accepts a canonical SessionId for the same PTY as its bare join key', async () => {
    // Hub chat keys threads on `<harness-id>:<native>` (identity table); the
    // den's own key space is the room, so every session-keyed edge resolves
    // one onto the other rather than making the client carry both.
    fakeProcs.length = 0
    const { base } = await start('', 60_000, { term: true })
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    // spawn with the canonical id — the room, and so the store filename, is
    // still the bare native id
    const spawn = await post(base, '/term', { command: 'shell', session: `claude-code:${uuid}` })
    expect(spawn.status).toBe(201)
    expect(((await spawn.json()) as { denSession: string }).denSession).toBe(uuid)
    fakeProcs[0].emit('data', Buffer.from('welcome'))
    await new Promise((r) => setTimeout(r, 30))
    // both shapes reach the same PTY
    for (const session of [uuid, `claude-code:${uuid}`]) {
      const inj = await post(base, '/term/inject', { session, text: 'hi' })
      expect(inj.status).toBe(202)
      await new Promise((r) => setTimeout(r, 120))
    }
  })

  it('inject reaches the handler on loopback (409 when no live harness)', async () => {
    const { base } = await start('', 60_000, { term: true })
    expect((await post(base, '/term/inject', { session: 'x', text: 'hi' })).status).toBe(409)
  })

  it('409s injecting into an exited-but-lingering harness', async () => {
    fakeProcs.length = 0
    const { base } = await start('', 60_000, { term: true })
    await post(base, '/term', { command: 'shell', session: 'chat-z' })
    // exit the harness; its record lingers (exitLingerMs) and the session
    // alias still resolves, but write() refuses a non-running proc.
    fakeProcs[0].emit('exit', 0)
    expect((await post(base, '/term/inject', { session: 'chat-z', text: 'hi' })).status).toBe(409)
  })
})

describe('gateway API aliases (G2/G3/G6) + SPA carve-out', () => {
  it('POST /api/events ingests a batch; GET /api/events/sessions lists', async () => {
    const { base } = await start()
    const res = await post(base, '/api/events', [EV])
    expect(res.status).toBe(200)
    const body = (await (await fetch(`${base}/api/events/sessions`)).json()) as {
      sessions: unknown[]
    }
    expect(body.sessions).toHaveLength(1)
  })

  it('GET /api/mesh behaves exactly like /mesh.json (alias parity)', async () => {
    const { base } = await start()
    // Environment-agnostic: with no mesh file both 404, with one both 200 —
    // the alias must never diverge from the canonical route.
    const [aliased, canonical] = await Promise.all([
      fetch(`${base}/api/mesh`),
      fetch(`${base}/mesh.json`),
    ])
    expect(aliased.status).toBe(canonical.status)
  })

  it('GET /api/terminal/config answers like /term/config', async () => {
    const { base } = await start()
    const [a, b] = await Promise.all([
      fetch(`${base}/api/terminal/config`),
      fetch(`${base}/term/config`),
    ])
    expect(a.status).toBe(b.status)
  })

  it('GET /api/terminal/harness-sessions/:id/transcript is nested-aliased (not 404)', async () => {
    // Nested paths are NOT in the exact API_ALIASES map — canonicalize must
    // still rewrite /api/terminal/* → /term/* or RivetHub resync sees "not found".
    // Also: static SPA must not swallow /term/* after that rewrite.
    const staticDir = mkdtempSync(join(tmpdir(), 'den-static-tx-'))
    dirs.push(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html>SPA')
    const { base } = await start('', 60_000, { term: true, staticDir })
    const [a, b] = await Promise.all([
      fetch(`${base}/api/terminal/harness-sessions/no-such-session/transcript`),
      fetch(`${base}/term/harness-sessions/no-such-session/transcript`),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const body = (await a.json()) as { id: string; command: string; turns: unknown[] }
    expect(body).toMatchObject({ id: 'no-such-session', command: '', turns: [] })
    expect(await b.json()).toEqual(body)
    // Must be JSON, not the SPA shell
    expect(a.headers.get('content-type')).toMatch(/json/)
  })

  it('WS /api/events/ws behaves like /ws (snapshot on connect)', async () => {
    const { base, port } = await start()
    await post(base, '/event', EV)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events/ws`)
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (d) => resolve(String(d)))
      ws.once('error', reject)
    })
    ws.close()
    expect((JSON.parse(first) as { type: string }).type).toBe('snapshot')
  })

  it('static SPA fallback never hijacks /api/* (G1 regression)', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'den-static-'))
    dirs.push(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html>SPA')
    const { base } = await start('', 60_000, {
      staticDir,
      extraRoutes: [
        {
          prefix: '/api/echo',
          handler: (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"api":true}')
          },
        },
      ],
    })
    // extensionless GET under /api must reach the mount, not index.html
    expect(await (await fetch(`${base}/api/echo/thing`)).json()).toEqual({ api: true })
    // and unknown /api paths 404 as JSON-ish, not the SPA shell
    const miss = await fetch(`${base}/api/unknown`)
    expect(miss.headers.get('content-type')).not.toContain('text/html')
    // the SPA still serves everywhere else
    expect(await (await fetch(`${base}/some/route`)).text()).toContain('SPA')
  })
})
