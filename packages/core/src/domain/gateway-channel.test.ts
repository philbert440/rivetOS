/**
 * Gateway channel (G5) — REST + WS surfaces over a bare http server, with a
 * fake turn pipeline (onMessage handler echoing via channel.send).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { describe, it, expect, afterEach } from 'vitest'
import { createGatewayChannel, type GatewayChannelHandle } from './gateway-channel.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function start(opts?: { failTurn?: boolean; delayMs?: number }): Promise<{
  base: string
  port: number
  gw: GatewayChannelHandle
}> {
  const gw = createGatewayChannel()
  gw.channel.onMessage(async (message) => {
    if (opts?.failTurn) throw new Error('provider exploded')
    await new Promise((r) => setTimeout(r, opts?.delayMs ?? 5))
    await gw.channel.send({ channelId: message.channelId, text: `echo: ${message.text}` })
  })
  await gw.channel.start()

  const server: Server = createServer((req, res) => {
    void gw.routes[0].handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === gw.upgrade.path) gw.upgrade.handle(req, socket, head, url)
    else socket.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  cleanups.push(async () => {
    await gw.close()
    await new Promise((r) => server.close(r))
  })
  return { base: `http://127.0.0.1:${port}`, port, gw }
}

const post = (base: string, session: string, body: unknown, query = '') =>
  fetch(`${base}/api/sessions/${session}/messages${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('gateway channel /api/sessions', () => {
  it('POST fires a turn (202); the reply lands in the ring and session list', async () => {
    const { base } = await start()
    const res = await post(base, 's1', { text: 'hello' })
    expect(res.status).toBe(202)

    await new Promise((r) => setTimeout(r, 50))
    const { messages } = (await (
      await fetch(`${base}/api/sessions/s1/messages`)
    ).json()) as { messages: Array<{ role: string; text: string }> }
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:hello', 'assistant:echo: hello'])

    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; messages: number }>
    }
    expect(sessions[0]).toMatchObject({ id: 's1', messages: 2 })
  })

  it('POST ?wait=1 long-polls the assistant reply', async () => {
    const { base } = await start({ delayMs: 20 })
    const res = await post(base, 's2', { text: 'ping' }, '?wait=1&timeoutMs=5000')
    expect(res.status).toBe(200)
    const { message } = (await res.json()) as { message: { role: string; text: string } }
    expect(message.role).toBe('assistant')
    expect(message.text).toBe('echo: ping')
  })

  it('?wait deadline answers 504 without dropping the turn', async () => {
    const { base } = await start({ delayMs: 300 })
    const res = await post(base, 's3', { text: 'slow' }, '?wait=1&timeoutMs=50')
    expect(res.status).toBe(504)
    // the turn still completes afterwards
    await new Promise((r) => setTimeout(r, 400))
    const { messages } = (await (
      await fetch(`${base}/api/sessions/s3/messages`)
    ).json()) as { messages: unknown[] }
    expect(messages).toHaveLength(2)
  })

  it('a failed turn surfaces as an assistant warning message', async () => {
    const { base } = await start({ failTurn: true })
    const res = await post(base, 's4', { text: 'boom' }, '?wait=1&timeoutMs=5000')
    expect(res.status).toBe(200)
    const { message } = (await res.json()) as { message: { text: string } }
    expect(message.text).toContain('turn failed')
  })

  it('WS subscribers get message frames, filtered by session', async () => {
    const { base, port } = await start()
    const frames: Array<{ kind: string; text?: string }> = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=s5`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.on('message', (d) => frames.push(JSON.parse(String(d)) as { kind: string }))
    cleanups.push(() => ws.close())

    await post(base, 's5', { text: 'mine' }, '?wait=1&timeoutMs=5000')
    await post(base, 'other', { text: 'not mine' }, '?wait=1&timeoutMs=5000')
    await new Promise((r) => setTimeout(r, 50))

    const texts = frames.filter((f) => f.kind === 'message').map((f) => f.text)
    expect(texts).toEqual(['mine', 'echo: mine'])
  })

  it('concurrent ?wait long-polls resolve FIFO — no cross-delivery', async () => {
    const { base } = await start({ delayMs: 30 })
    const [a, b] = await Promise.all([
      post(base, 's7', { text: 'first' }, '?wait=1&timeoutMs=5000'),
      (async () => {
        await new Promise((r) => setTimeout(r, 10))
        return post(base, 's7', { text: 'second' }, '?wait=1&timeoutMs=5000')
      })(),
    ])
    const ra = ((await a.json()) as { message: { text: string } }).message.text
    const rb = ((await b.json()) as { message: { text: string } }).message.text
    expect(ra).toBe('echo: first')
    expect(rb).toBe('echo: second')
  })

  it('validates bodies: 400 on missing text', async () => {
    const { base } = await start()
    expect((await post(base, 's6', {})).status).toBe(400)
  })
})
