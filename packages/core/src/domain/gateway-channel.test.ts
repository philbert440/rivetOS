/**
 * Gateway channel (G5) — REST + WS surfaces over a bare http server, with a
 * fake turn pipeline (onMessage handler echoing via channel.send).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { SessionWsFrame } from '@rivetos/types'
import { describe, it, expect, afterEach } from 'vitest'
import {
  createGatewayChannel,
  type GatewayChannelHandle,
} from './gateway-channel.js'

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

describe('bridgeAgentEvent (seamless-modes bridge)', () => {
  it('coalesces per-block assistant text into ONE message per turn', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c1`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    gw.bridgeAgentEvent({ session: 'c1', type: 'message.user', text: 'hi', ts: 1 })
    gw.bridgeAgentEvent({ session: 'c1', type: 'thinking.delta', text: 'hmm' })
    gw.bridgeAgentEvent({ session: 'c1', type: 'message.agent', text: 'part 1 ' }) // block 1
    gw.bridgeAgentEvent({ session: 'c1', type: 'tool.start', tool: 'Bash' })
    gw.bridgeAgentEvent({ session: 'c1', type: 'tool.end', tool: 'Bash' })
    gw.bridgeAgentEvent({ session: 'c1', type: 'message.agent', text: 'part 2' }) // block 2
    gw.bridgeAgentEvent({ session: 'c1', type: 'session.end' }) // turn boundary → commit
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const assistant = got.filter((f) => f.kind === 'message' && f.role === 'assistant')
    expect(assistant).toHaveLength(1) // ONE bubble, not one per block
    expect(assistant[0].kind === 'message' && assistant[0].text).toBe('part 1 part 2')
    // interim blocks streamed as text deltas (the live bubble)
    expect(got.filter((f) => f.kind === 'stream' && f.event.type === 'text')).toHaveLength(2)
    expect(got.some((f) => f.kind === 'stream' && f.event.type === 'reasoning')).toBe(true)
    expect(got.some((f) => f.kind === 'stream' && f.event.type === 'tool_start')).toBe(true)
    expect(got.some((f) => f.kind === 'message' && f.role === 'user')).toBe(true)
  })

  it('commits the prior assistant turn when the next user turn starts', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c2`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    gw.bridgeAgentEvent({ session: 'c2', type: 'message.agent', text: 'answer' })
    gw.bridgeAgentEvent({ session: 'c2', type: 'message.user', text: 'next' }) // flush prior
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const msgs = got.filter((f) => f.kind === 'message')
    expect(msgs.some((f) => f.kind === 'message' && f.role === 'assistant' && f.text === 'answer')).toBe(
      true,
    )
    expect(msgs.some((f) => f.kind === 'message' && f.role === 'user' && f.text === 'next')).toBe(true)
  })

  it('threads turn stats (usage/model/durationMs) from the final block onto the committed message', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c3`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    gw.bridgeAgentEvent({ session: 'c3', type: 'message.agent', text: 'interim ' }) // no stats
    gw.bridgeAgentEvent({
      session: 'c3',
      type: 'message.agent',
      text: 'final',
      usage: { promptTokens: 1200, completionTokens: 340, cachedTokens: 800 },
      model: 'claude-opus-4-8',
      durationMs: 4200,
    })
    gw.bridgeAgentEvent({ session: 'c3', type: 'session.end' }) // commit
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const assistant = got.filter((f) => f.kind === 'message' && f.role === 'assistant')
    expect(assistant).toHaveLength(1)
    const msg = assistant[0]
    expect(msg.kind === 'message' && msg.text).toBe('interim final')
    expect(msg.kind === 'message' && msg.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 340,
      cachedTokens: 800,
    })
    expect(msg.kind === 'message' && msg.model).toBe('claude-opus-4-8')
    expect(msg.kind === 'message' && msg.durationMs).toBe(4200)
  })

  it('omits turn stats when the harness reports none', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c4`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))
    gw.bridgeAgentEvent({ session: 'c4', type: 'message.agent', text: 'plain' })
    gw.bridgeAgentEvent({ session: 'c4', type: 'session.end' })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()
    const msg = got.find((f) => f.kind === 'message' && f.role === 'assistant')
    expect(msg?.kind === 'message' && msg.usage).toBeUndefined()
    expect(msg?.kind === 'message' && msg.model).toBeUndefined()
  })

  it('skips task: sessions (task engine namespace)', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws`) // all sessions
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))
    gw.bridgeAgentEvent({ session: 'task:abc', type: 'message.agent', text: 'x' })
    gw.bridgeAgentEvent({ session: 'task:abc', type: 'session.end' })
    await new Promise((r) => setTimeout(r, 30))
    ws.close()
    expect(got).toHaveLength(0)
  })
})

describe('emitFrame (seamless-modes push)', () => {
  it('broadcasts to a session subscriber and rings message frames', async () => {
    const { gw, base, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=conv-1`)
    const got: unknown[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString())))
    await new Promise((r) => ws.once('open', r))

    gw.emitFrame({ kind: 'stream', session: 'conv-1', event: { type: 'reasoning', content: 'x' } })
    gw.emitFrame({ kind: 'message', id: 'm1', sessionId: 'conv-1', role: 'assistant', text: 'hi', ts: 1 })
    gw.emitFrame({ kind: 'stream', session: 'other', event: { type: 'text', content: 'nope' } })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    expect(got.length).toBe(2) // the 'other' session frame is filtered out
    // the message frame landed in the ring (backfill sees it)
    const msgs = (await (await fetch(`${base}/api/sessions/conv-1/messages`)).json()) as {
      messages: { id: string }[]
    }
    expect(msgs.messages.some((m) => m.id === 'm1')).toBe(true)
  })
})

describe('GET /api/conversations/:key/messages (seamless-modes backfill 5e)', () => {
  async function startWithMemory(
    history: Array<{ role: string; content: unknown }>,
  ): Promise<string> {
    const gw = createGatewayChannel({ getMemory: () => ({ getSessionHistory: async () => history }) })
    await gw.channel.start()
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = gw.routes.find((r) => url.pathname.startsWith(r.prefix))
      void route?.handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    cleanups.push(async () => {
      await gw.close()
      await new Promise((r) => server.close(r))
    })
    return `http://127.0.0.1:${port}`
  }

  it('returns the durable transcript, user/assistant only, content flattened', async () => {
    const base = await startWithMemory([
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi ' },
          { type: 'text', text: 'there' },
        ],
      },
      { role: 'tool', content: 'tool junk' },
    ])
    const res = await fetch(`${base}/api/conversations/chat-abc/messages`)
    expect(res.status).toBe(200)
    const { messages } = (await res.json()) as {
      messages: Array<{ id: string; role: string; text: string }>
    }
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:hello', 'assistant:hi there'])
    expect(messages[0].id).toBe('chat-abc:0')
  })

  it('empty when no memory is registered; 404 on a malformed path', async () => {
    const gw = createGatewayChannel()
    await gw.channel.start()
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = gw.routes.find((r) => url.pathname.startsWith(r.prefix))
      void route?.handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    cleanups.push(async () => {
      await gw.close()
      await new Promise((r) => server.close(r))
    })
    const base = `http://127.0.0.1:${port}`
    const ok = (await (await fetch(`${base}/api/conversations/k/messages`)).json()) as {
      messages: unknown[]
    }
    expect(ok.messages).toEqual([])
    expect((await fetch(`${base}/api/conversations/k`)).status).toBe(404)
  })
})

