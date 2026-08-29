/**
 * Gateway channel (G5) — REST + WS surfaces over a bare http server, with a
 * fake turn pipeline (onMessage handler echoing via channel.send).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { InboundMessage, SessionWsFrame } from '@rivetos/types'
import { describe, it, expect, afterEach } from 'vitest'
import {
  bareAliasOf,
  createGatewayChannel,
  type GatewayChannelHandle,
} from './gateway-channel.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function start(opts?: {
  failTurn?: boolean
  delayMs?: number
  inbound?: InboundMessage[]
}): Promise<{
  base: string
  port: number
  gw: GatewayChannelHandle
}> {
  const gw = createGatewayChannel()
  gw.channel.onMessage(async (message) => {
    opts?.inbound?.push(message)
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

  it('POST forwards systemPrompt and thinking on inbound metadata', async () => {
    const inbound: InboundMessage[] = []
    const { base } = await start({ inbound })
    const res = await post(
      base,
      'sp1',
      { text: 'hi', systemPrompt: '  be terse  ', thinking: 'high' },
      '?wait=1&timeoutMs=5000',
    )
    expect(res.status).toBe(200)
    expect(inbound).toHaveLength(1)
    expect(inbound[0]?.metadata).toEqual({ thinking: 'high', systemPrompt: 'be terse' })
  })

  it('POST omits empty systemPrompt from metadata', async () => {
    const inbound: InboundMessage[] = []
    const { base } = await start({ inbound })
    await post(base, 'sp2', { text: 'hi', systemPrompt: '   ' }, '?wait=1&timeoutMs=5000')
    expect(inbound[0]?.metadata).toBeUndefined()
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

  it('strips a Hermes Reasoning box out of the committed reply', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-hermes`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    const boxed = [
      '┌─ Reasoning ──────────────────────────────────────────────────────────────────────────────────────┐',
      '│ The user wants this leak gone.',
      '└──────────────────────────────────────────────────────────────────────────────────────────────────┘',
      '',
      'Done.',
    ].join('\n')
    gw.bridgeAgentEvent({ session: 'c-hermes', type: 'message.user', text: 'hi', ts: 1, harness: 'hermes' })
    gw.bridgeAgentEvent({ session: 'c-hermes', type: 'message.agent', text: boxed, harness: 'hermes' })
    gw.bridgeAgentEvent({ session: 'c-hermes', type: 'turn.end', harness: 'hermes' })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const assistant = got.filter((f) => f.kind === 'message' && f.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].kind === 'message' && assistant[0].text).toBe('Done.')
    expect(got.some((f) => f.kind === 'stream' && f.event.type === 'reasoning')).toBe(true)
    const textEvents = got.filter((f) => f.kind === 'stream' && f.event.type === 'text')
    expect(textEvents.every((f) => f.kind === 'stream' && !f.event.content.includes('┌─'))).toBe(
      true,
    )
  })

  it('B3: emits reasoning as deltas across chunks (Hermes only)', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-delta`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    gw.bridgeAgentEvent({ session: 'c-delta', type: 'message.user', text: 'hi', ts: 1, harness: 'hermes' })
    gw.bridgeAgentEvent({
      session: 'c-delta',
      type: 'message.agent',
      text: '┌─ Reasoning ──┐\n│ thinking line 1',
      harness: 'hermes',
    })
    gw.bridgeAgentEvent({
      session: 'c-delta',
      type: 'message.agent',
      text: '\n│ thinking line 2',
      harness: 'hermes',
    })
    gw.bridgeAgentEvent({ session: 'c-delta', type: 'turn.end', harness: 'hermes' })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const reasoningEvents = got.filter((f) => f.kind === 'stream' && f.event.type === 'reasoning')
    expect(reasoningEvents.length).toBeGreaterThan(0)
    const allReasoning = reasoningEvents
      .map((f) => (f.kind === 'stream' ? f.event.content : ''))
      .join('')
    expect(allReasoning).toContain('thinking line 1')
    expect(allReasoning).toContain('thinking line 2')
  })

  it('B5: does not strip reasoning from non-Hermes harnesses', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-claude`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    const boxed = [
      '┌─ Reasoning ──┐',
      '│ thinking',
      '└──────────────┘',
      'reply',
    ].join('\n')
    gw.bridgeAgentEvent({ session: 'c-claude', type: 'message.user', text: 'hi', ts: 1, harness: 'claude-code' })
    gw.bridgeAgentEvent({ session: 'c-claude', type: 'message.agent', text: boxed, harness: 'claude-code' })
    gw.bridgeAgentEvent({ session: 'c-claude', type: 'turn.end', harness: 'claude-code' })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const assistant = got.filter((f) => f.kind === 'message' && f.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].kind === 'message' && assistant[0].text).toBe(boxed)
  })

  it('harness-injected wrappers never bubble as user messages', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-wrap`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    gw.bridgeAgentEvent({
      session: 'c-wrap',
      type: 'message.user',
      text: '<task-notification>\n<task-id>x</task-id>\n</task-notification>',
      ts: 1,
    })
    gw.bridgeAgentEvent({ session: 'c-wrap', type: 'message.user', text: 'Caveat: local noise' })
    gw.bridgeAgentEvent({ session: 'c-wrap', type: 'message.user', text: 'real question', ts: 2 })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const users = got.filter((f) => f.kind === 'message' && f.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0].kind === 'message' && users[0].text).toBe('real question')
  })

  it('turn.end commits the reply and emits done — the session stays usable', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-turn`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    // turn 1: user → reply → Stop hook (turn.end), NOT session.end
    gw.bridgeAgentEvent({ session: 'c-turn', type: 'message.user', text: 'q1', ts: 1 })
    gw.bridgeAgentEvent({ session: 'c-turn', type: 'message.agent', text: 'a1' })
    gw.bridgeAgentEvent({ session: 'c-turn', type: 'turn.end' })
    // turn 2 on the SAME session — pendingAssistant must not bleed across
    gw.bridgeAgentEvent({ session: 'c-turn', type: 'message.user', text: 'q2', ts: 2 })
    gw.bridgeAgentEvent({ session: 'c-turn', type: 'message.agent', text: 'a2' })
    gw.bridgeAgentEvent({ session: 'c-turn', type: 'turn.end' })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const assistant = got.filter((f) => f.kind === 'message' && f.role === 'assistant')
    expect(assistant.map((f) => f.kind === 'message' && f.text)).toEqual(['a1', 'a2'])
    // each turn.end tells clients the turn is over (releases the send queue)
    expect(got.filter((f) => f.kind === 'stream' && f.event.type === 'done')).toHaveLength(2)
  })

  it('forwards optional tool args on tool.start for Hub chips/titles', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-args`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    gw.bridgeAgentEvent({
      session: 'c-args',
      type: 'tool.start',
      tool: 'AskUserQuestion',
      args: { questions: [{ options: [{ label: 'A' }] }] },
    })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const toolStart = got.find((f) => f.kind === 'stream' && f.event.type === 'tool_start')
    expect(toolStart?.kind).toBe('stream')
    if (toolStart?.kind === 'stream') {
      expect(toolStart.event.content).toBe('AskUserQuestion')
      expect(toolStart.event.metadata).toMatchObject({
        tool: 'AskUserQuestion',
        args: { questions: [{ options: [{ label: 'A' }] }] },
      })
    }
  })

  it('summarizes nested args and redacts secret keys on tool.start', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-redact`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    const huge = 'x'.repeat(500)
    gw.bridgeAgentEvent({
      session: 'c-redact',
      type: 'tool.start',
      tool: 'Write',
      args: {
        api_key: 'sk-super-secret',
        password: 'hunter2',
        nested: { content: huge, token: 'abc' },
      },
    })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const toolStart = got.find((f) => f.kind === 'stream' && f.event.type === 'tool_start')
    expect(toolStart?.kind).toBe('stream')
    if (toolStart?.kind === 'stream') {
      const args = toolStart.event.metadata?.args as Record<string, unknown>
      expect(args.api_key).toBe('[redacted]')
      expect(args.password).toBe('[redacted]')
      const nested = args.nested as Record<string, unknown>
      expect(nested.token).toBe('[redacted]')
      expect(String(nested.content).endsWith('…')).toBe(true)
      expect(String(nested.content).length).toBeLessThanOrEqual(201)
    }
  })

  it('redacts secret *values* inside ordinary keys like command', async () => {
    // The re-review blocker: key-name redaction alone still leaks
    // `command: "curl -H 'Authorization: Bearer sk-…'"` onto the sessions WS.
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-val`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    gw.bridgeAgentEvent({
      session: 'c-val',
      type: 'tool.start',
      tool: 'Bash',
      args: {
        command:
          "curl -H 'Authorization: Bearer sk-abc1234567890live' https://api.example.com && export API_KEY=sk-live-xyz",
      },
    })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const toolStart = got.find((f) => f.kind === 'stream' && f.event.type === 'tool_start')
    expect(toolStart?.kind).toBe('stream')
    if (toolStart?.kind === 'stream') {
      const args = toolStart.event.metadata?.args as Record<string, unknown>
      const cmd = String(args.command)
      expect(cmd).not.toContain('sk-abc1234567890live')
      expect(cmd).not.toContain('sk-live-xyz')
      expect(cmd.toLowerCase()).toContain('[redacted]')
    }
  })

  it('keeps long ask-tool option labels intact (the label IS the answer)', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-ask`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    // 500 chars: over the generic 200 cap, under the ask cap. The Hub sends
    // the rendered label back verbatim as the user's answer, so truncation
    // here would make the user "say" a mangled option.
    const longLabel = 'Use the streaming parser with backpressure — '.repeat(11)
    const ask = {
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: false,
          options: [{ label: longLabel, description: 'd' }],
        },
      ],
    }
    gw.bridgeAgentEvent({ session: 'c-ask', type: 'tool.start', tool: 'AskUserQuestion', args: ask })
    // Same payload under a non-ask tool must still truncate at the generic cap.
    gw.bridgeAgentEvent({ session: 'c-ask', type: 'tool.start', tool: 'Write', args: ask })
    // Redaction must survive the wider ask budget.
    gw.bridgeAgentEvent({
      session: 'c-ask',
      type: 'tool.start',
      tool: 'ask_user',
      args: { question: 'q', choices: ['a'], api_key: 'sk-super-secret' },
    })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const starts = got.filter((f) => f.kind === 'stream' && f.event.type === 'tool_start')
    expect(starts).toHaveLength(3)
    const labelOf = (f: SessionWsFrame): string => {
      if (f.kind !== 'stream') return ''
      const args = f.event.metadata?.args as {
        questions: Array<{ options: Array<{ label: string }> }>
      }
      return args.questions[0].options[0].label
    }
    expect(labelOf(starts[0])).toBe(longLabel)
    expect(labelOf(starts[1]).endsWith('…')).toBe(true)
    expect(labelOf(starts[1]).length).toBeLessThanOrEqual(201)
    const last = starts.at(-1)
    if (last?.kind === 'stream') {
      expect((last.event.metadata?.args as Record<string, unknown>).api_key).toBe('[redacted]')
    }
  })

  it('the ask budget is wider, not unlimited: 2000-char cap, value redaction, array cap', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c-ask-lim`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))

    const overLong = 'y'.repeat(2001)
    const leaky = `deploy with token=sk-abc1234567890live and continue ${'z'.repeat(300)}`
    gw.bridgeAgentEvent({
      session: 'c-ask-lim',
      type: 'tool.start',
      tool: 'AskUserQuestion',
      args: {
        questions: [
          {
            question: 'q',
            multiSelect: false,
            options: [
              { label: overLong },
              { label: leaky },
              ...Array.from({ length: 21 }, (_, i) => ({ label: `opt-${String(i)}` })),
            ],
          },
        ],
      },
    })
    await new Promise((r) => setTimeout(r, 40))
    ws.close()

    const frame = got.find((f) => f.kind === 'stream' && f.event.type === 'tool_start')
    expect(frame?.kind).toBe('stream')
    if (frame?.kind === 'stream') {
      const args = frame.event.metadata?.args as {
        questions: Array<{ options: Array<{ label: string }> }>
      }
      const options = args.questions[0].options
      // array cap still applies to ask payloads
      expect(options).toHaveLength(20)
      // 2001 chars → capped at the ASK budget, not the generic one
      expect(options[0].label.endsWith('…')).toBe(true)
      expect(options[0].label.length).toBeLessThanOrEqual(2001)
      expect(options[0].label.length).toBeGreaterThan(1000)
      // value-pattern redaction runs inside the wider budget too
      expect(options[1].label).not.toContain('sk-abc1234567890live')
      expect(options[1].label.toLowerCase()).toContain('[redacted]')
    }
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

  it('maps activity events to stream status (hermes / non-Claude progress)', async () => {
    const { gw, port } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/ws?session=c5`)
    const got: SessionWsFrame[] = []
    ws.on('message', (d: Buffer) => got.push(JSON.parse(d.toString()) as SessionWsFrame))
    await new Promise((r) => ws.once('open', r))
    gw.bridgeAgentEvent({ session: 'c5', type: 'activity', activity: 'thinking' })
    await new Promise((r) => setTimeout(r, 30))
    ws.close()
    const stream = got.find((f) => f.kind === 'stream')
    expect(stream?.kind === 'stream' && stream.event.type).toBe('status')
    expect(stream?.kind === 'stream' && stream.event.content).toBe('thinking')
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

  it('the ring is readable by canonical SessionId as well as by den room key', async () => {
    // The bridge keys the ring on the room key an AgentEvent carries; hub chat
    // asks with the canonical id. Alias read, no dual write (§ Legacy keys).
    const { gw, base } = await start()
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    gw.emitFrame({ kind: 'message', id: 'm9', sessionId: uuid, role: 'assistant', text: 'hi', ts: 1 })
    await new Promise((r) => setTimeout(r, 20))

    const key = encodeURIComponent(`claude-code:${uuid}`)
    const aliased = (await (await fetch(`${base}/api/sessions/${key}/messages`)).json()) as {
      messages: { id: string }[]
    }
    expect(aliased.messages.map((m) => m.id)).toEqual(['m9'])
    // and it did not mint a second, empty session under the canonical id
    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    expect(sessions.map((s) => s.id)).toEqual([uuid])
  })

  it('a canonical GET before the first frame does not shadow the native ring', async () => {
    // The hub's cold-open ordering: `storeEmpty` fires the ring backfill BEFORE
    // any bridge frame exists. A read that allocated here would make
    // `sessions.has(canonical)` true forever, the alias would never be
    // consulted again, and the real transcript would be invisible for the life
    // of the process.
    const { gw, base } = await start()
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    const key = encodeURIComponent(`claude-code:${uuid}`)

    const cold = (await (await fetch(`${base}/api/sessions/${key}/messages`)).json()) as {
      messages: unknown[]
    }
    expect(cold.messages).toEqual([])
    // nothing was allocated — no phantom in the session list
    const empty = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    expect(empty.sessions).toEqual([])

    // the bridge now fills the ring under the den room key…
    gw.emitFrame({ kind: 'message', id: 'm1', sessionId: uuid, role: 'user', text: 'hi', ts: 1 })
    await new Promise((r) => setTimeout(r, 20))

    // …and the SAME canonical read now finds it through the alias
    const warm = (await (await fetch(`${base}/api/sessions/${key}/messages`)).json()) as {
      messages: { id: string }[]
    }
    expect(warm.messages.map((m) => m.id)).toEqual(['m1'])
    const after = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    expect(after.sessions.map((s) => s.id)).toEqual([uuid])
  })

  it('a canonical POST joins the native ring instead of forking a second one', async () => {
    // Split-brain guard: the user turn, the assistant reply and the long-poll
    // waiter all have to land in the ring the den bridge is already filling.
    const { gw, base } = await start()
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    gw.emitFrame({ kind: 'message', id: 'm0', sessionId: uuid, role: 'user', text: 'earlier', ts: 1 })
    await new Promise((r) => setTimeout(r, 20))

    const res = await post(base, encodeURIComponent(`claude-code:${uuid}`), { text: 'hello' })
    expect(res.status).toBe(202)
    await new Promise((r) => setTimeout(r, 60))

    // one ring, in order: the bridged turn, the posted turn, its reply
    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    expect(sessions.map((s) => s.id)).toEqual([uuid])
    const { messages } = (await (
      await fetch(`${base}/api/sessions/${encodeURIComponent(`claude-code:${uuid}`)}/messages`)
    ).json()) as { messages: { role: string; text: string }[] }
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:earlier',
      'user:hello',
      'assistant:echo: hello',
    ])
  })

  it('a canonical POST after a self-healed GET still joins the native ring', async () => {
    // Reads and writes have to agree on which entry an id addresses. When they
    // disagreed, a canonical GET self-healed to the native history and the
    // NEXT canonical POST wrote somewhere else, flipping every later read from
    // the full transcript to a one-message ring — the original mint-shadow in
    // reverse.
    const { gw, base } = await start()
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    const key = encodeURIComponent(`claude-code:${uuid}`)
    gw.emitFrame({ kind: 'message', id: 'm0', sessionId: uuid, role: 'user', text: 'bridged', ts: 1 })
    await new Promise((r) => setTimeout(r, 20))

    // read first (self-heals through the alias)…
    const healed = (await (await fetch(`${base}/api/sessions/${key}/messages`)).json()) as {
      messages: { text: string }[]
    }
    expect(healed.messages.map((m) => m.text)).toEqual(['bridged'])

    // …then write, and read back: one ring, history intact
    await post(base, key, { text: 'hello' })
    await new Promise((r) => setTimeout(r, 60))
    const after = (await (await fetch(`${base}/api/sessions/${key}/messages`)).json()) as {
      messages: { role: string; text: string }[]
    }
    expect(after.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:bridged',
      'user:hello',
      'assistant:echo: hello',
    ])
    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    expect(sessions.map((s) => s.id)).toEqual([uuid]) // no phantom canonical row
  })

  it('a rejected POST allocates nothing', async () => {
    // `ringKeyFor` resolves before the body is validated, so it must not be a
    // get-or-create — a 400 that left an entry behind would be a phantom in
    // the listing and, worse, an empty own ring for later writes to prefer.
    const { base } = await start()
    const canonical = `claude-code:a1b2c3d4-1111-4222-8333-444455556666`
    expect((await post(base, encodeURIComponent(canonical), { text: '  ' })).status).toBe(400)
    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: unknown[]
    }
    expect(sessions).toEqual([])
  })

  it('submitTurn resolves the same key the HTTP POST would', async () => {
    // The OpenAI-compat surface is the same ring by another door; a canonical
    // session id there has to join the bridged transcript, not fork one.
    const { gw, base } = await start()
    const uuid = 'c3d4e5f6-3333-4444-8555-666677778888'
    gw.emitFrame({ kind: 'message', id: 'm0', sessionId: uuid, role: 'user', text: 'bridged', ts: 1 })
    await new Promise((r) => setTimeout(r, 20))

    const result = await gw.submitTurn({ sessionId: `claude-code:${uuid}`, text: 'via compat' })
    expect(result.ok).toBe(true)

    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    expect(sessions.map((s) => s.id)).toEqual([uuid]) // one ring, native-keyed
    const { messages } = (await (
      await fetch(`${base}/api/sessions/${encodeURIComponent(`claude-code:${uuid}`)}/messages`)
    ).json()) as { messages: { role: string; text: string }[] }
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:bridged',
      'user:via compat',
      'assistant:echo: via compat',
    ])
  })

  it('a canonical POST for a session nobody has seen still opens its own ring', async () => {
    // No native entry to join — the canonical id is the session, and a write
    // is allowed to allocate (only reads are not).
    const { base } = await start()
    const uuid = 'b2c3d4e5-2222-4333-8444-555566667777'
    const canonical = `claude-code:${uuid}`
    await post(base, encodeURIComponent(canonical), { text: 'fresh' })
    await new Promise((r) => setTimeout(r, 60))
    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    expect(sessions.map((s) => s.id)).toEqual([canonical])
  })
})

describe('bareAliasOf', () => {
  const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

  it('aliases a canonical id to its native half', () => {
    expect(bareAliasOf(`claude-code:${UUID}`)).toBe(UUID)
    expect(bareAliasOf('kimi-code:session_abc')).toBe('session_abc')
    expect(bareAliasOf('hermes:a:b:c')).toBe('a:b:c') // first colon only
  })

  it("collapses Claude's path-fallback form, matching den-server's denSessionRef", () => {
    // Shared vector: `services/den-server/src/harness/session-key.test.ts`
    // asserts the same input resolves to the same native id there. Two alias
    // implementations that disagree on a documented legacy shape would send
    // the gateway looking for a row the den edges would have found.
    expect(bareAliasOf(`claude-code:-home-rivet-proj/${UUID}`)).toBe(UUID)
    // a native id that merely contains `/` is opaque, not a path fallback
    expect(bareAliasOf('hermes:some/other')).toBe('some/other')
  })

  it('has no alias for a bare id or a foreign namespace', () => {
    expect(bareAliasOf(UUID)).toBeUndefined()
    expect(bareAliasOf('task:42')).toBeUndefined()
    expect(bareAliasOf('claude:nickname')).toBeUndefined()
    expect(bareAliasOf('den-pty-1a2b3c4d')).toBeUndefined()
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

  it('falls back to the bare native key when the canonical one has no rows', async () => {
    // A den-spawned harness inherits RIVETOS_SESSION_KEY = the bare join key,
    // so its conversation is filed under that; the hub now asks with the
    // canonical SessionId. Nothing is rewritten — the alias covers the read
    // (harness-control-plane.md § Legacy keys).
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    const asked: string[] = []
    const gw = createGatewayChannel({
      getMemory: () => ({
        getSessionHistory: async (key: string) => {
          asked.push(key)
          return key === uuid ? [{ role: 'user', content: 'legacy row' }] : []
        },
      }),
    })
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

    const key = encodeURIComponent(`claude-code:${uuid}`)
    const { messages } = (await (
      await fetch(`${base}/api/conversations/${key}/messages`)
    ).json()) as { messages: Array<{ text: string }> }
    expect(messages.map((m) => m.text)).toEqual(['legacy row'])
    // canonical first, native only as the fallback
    expect(asked).toEqual([`claude-code:${uuid}`, uuid])
  })

  it('never mistakes a task key for a SessionId', async () => {
    // `task:<id>` is a parallel conversation-key namespace, not an alias.
    const asked: string[] = []
    const gw = createGatewayChannel({
      getMemory: () => ({
        getSessionHistory: async (key: string) => {
          asked.push(key)
          return []
        },
      }),
    })
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
    await fetch(`http://127.0.0.1:${port}/api/conversations/${encodeURIComponent('task:42')}/messages`)
    expect(asked).toEqual(['task:42'])
  })
})

