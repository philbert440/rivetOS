import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createDenServer, type DenServer } from './server.js'
import type { DenConfig } from './config.js'

const servers: DenServer[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

async function start(token = ''): Promise<{ den: DenServer; base: string; port: number }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'den-server-'))
  dirs.push(stateDir)
  const config: DenConfig = { port: 0, host: '127.0.0.1', token, stateDir, staticDir: '', packsDir: '' }
  const den = createDenServer(config)
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
    ws.on('message', (d: Buffer) => messages.push(JSON.parse(d.toString()) as Record<string, unknown>))
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
    const fromOther = (await (await fetch(`${base}/layout?viewer=phil`)).json()) as Record<string, unknown>
    expect(fromOther.desk).toEqual({ x: 1 })
    await post(base, '/layout?viewer=phil', { desk: { x: 2 } })
    const own = (await (await fetch(`${base}/layout?viewer=phil`)).json()) as Record<string, unknown>
    expect(own.desk).toEqual({ x: 2 })
    expect((await post(base, '/layout?viewer=../evil', {})).status).toBe(400)
    const rawBad = await fetch(`${base}/layout`, { method: 'POST', body: 'not json' })
    expect(rawBad.status).toBe(400)
  })

  it('enforces bearer auth on everything but /healthz', async () => {
    const { base, port } = await start('sekrit')
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect((await post(base, '/event', EV)).status).toBe(401)
    expect((await fetch(`${base}/sessions`)).status).toBe(401)
    expect((await post(base, '/event', EV, { authorization: 'Bearer sekrit' })).status).toBe(200)
    // ?token= form for browser WS
    expect((await fetch(`${base}/sessions?token=sekrit`)).status).toBe(200)

    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const deniedResult = await new Promise((resolve) => {
      denied.once('error', () => resolve('rejected'))
      denied.once('open', () => resolve('open'))
    })
    expect(deniedResult).toBe('rejected')

    const ok = new WebSocket(`ws://127.0.0.1:${port}/ws?token=sekrit`)
    await new Promise((r, j) => {
      ok.once('open', r)
      ok.once('error', j)
    })
    ok.close()
  })
})
