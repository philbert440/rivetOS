/**
 * OpenAI-compatible /v1/* — models list, streaming + non-streaming completions,
 * x-rivet-conversation session pinning, StreamEvent→SSE mapping.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
import type { StreamEvent } from '@rivetos/types'
import {
  createGatewayChannel,
  type GatewayChannelHandle,
} from './gateway-channel.js'
import {
  createOpenAICompatRoute,
  lastUserText,
  normalizeConversationId,
  streamEventToChunkParts,
  uuidFromString,
} from './openai-compat.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function start(opts?: {
  agents?: Array<{ id: string }>
  streamEvents?: StreamEvent[]
  delayMs?: number
  failTurn?: boolean
}): Promise<{ base: string; gw: GatewayChannelHandle }> {
  const gw = createGatewayChannel({ defaultAgent: 'claude' })
  gw.channel.onMessage(async (message) => {
    if (opts?.failTurn) throw new Error('provider exploded')
    await new Promise((r) => setTimeout(r, opts?.delayMs ?? 5))
    const emit = gw.channel.onStreamEvent?.bind(gw.channel)
    if (opts?.streamEvents?.length) {
      for (const ev of opts.streamEvents) emit?.(message, ev)
    } else {
      emit?.(message, { type: 'text', content: `echo: ${message.text}` })
      emit?.(message, { type: 'done', content: '' })
    }
    await gw.channel.send({
      channelId: message.channelId,
      text: `echo: ${message.text}`,
    })
  })
  await gw.channel.start()

  const route = createOpenAICompatRoute({
    listAgents: async () => opts?.agents ?? [{ id: 'claude' }, { id: 'grok' }],
    gateway: gw,
    defaultAgent: 'claude',
  })
  const server: Server = createServer((req, res) => {
    void route.handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(async () => {
    await gw.close()
    await new Promise((r) => server.close(r))
  })
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    gw,
  }
}

describe('lastUserText / conversation helpers', () => {
  it('takes only the last user message text', () => {
    expect(
      lastUserText([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ]),
    ).toBe('second')
  })

  it('normalizes non-UUID conversation keys to stable UUIDs', () => {
    const a = normalizeConversationId('my-chat')
    const b = normalizeConversationId('my-chat')
    expect(a).toBe(b)
    expect(a).toMatch(UUID_RE)
    expect(normalizeConversationId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
    expect(uuidFromString('x')).toBe(uuidFromString('x'))
  })
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('streamEventToChunkParts', () => {
  it('maps text, reasoning, tools, status, done, error', () => {
    expect(streamEventToChunkParts({ type: 'text', content: 'hi' })).toEqual({
      delta: { content: 'hi' },
    })
    expect(streamEventToChunkParts({ type: 'reasoning', content: 'think' })).toEqual({
      delta: { reasoning_content: 'think' },
    })
    const tool = streamEventToChunkParts({
      type: 'tool_start',
      content: 'bash',
      metadata: { tool: 'bash', id: 't1', args: { cmd: 'ls' } },
    })
    expect(tool?.delta?.rivet_tools).toEqual([
      { id: 't1', name: 'bash', arguments: { cmd: 'ls' } },
    ])
    const result = streamEventToChunkParts({
      type: 'tool_result',
      content: 'ok',
      metadata: { id: 't1', output: 'ok' },
    })
    expect(result?.delta?.rivet_tools).toEqual([{ id: 't1', output: 'ok' }])
    expect(streamEventToChunkParts({ type: 'status', content: 'thinking' })).toEqual({
      delta: {},
      extra: { rivet_status: 'thinking' },
    })
    expect(streamEventToChunkParts({ type: 'done', content: '' })).toMatchObject({
      finish: 'stop',
      done: true,
    })
    expect(streamEventToChunkParts({ type: 'error', content: 'boom' })).toEqual({
      error: { message: 'boom' },
    })
  })
})

describe('GET /v1/models', () => {
  it('maps agents to OpenAI model list shape', async () => {
    const { base } = await start({ agents: [{ id: 'claude' }, { id: 'grok' }] })
    const res = await fetch(`${base}/v1/models`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      data: Array<{ id: string; object: string; owned_by: string }>
    }
    expect(body.object).toBe('list')
    expect(body.data).toEqual([
      { id: 'claude', object: 'model', created: 0, owned_by: 'rivetos' },
      { id: 'grok', object: 'model', created: 0, owned_by: 'rivetos' },
    ])
  })
})

describe('POST /v1/chat/completions (non-stream)', () => {
  it('returns one assistant message from the last user turn', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [
          { role: 'user', content: 'ignored earlier' },
          { role: 'assistant', content: 'prior' },
          { role: 'user', content: 'hello' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      model: string
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
      rivet_conversation: string
    }
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('claude')
    expect(body.choices[0]?.message).toEqual({ role: 'assistant', content: 'echo: hello' })
    expect(body.choices[0]?.finish_reason).toBe('stop')
    expect(body.rivet_conversation).toMatch(UUID_RE)
  })
})

describe('POST /v1/chat/completions (stream)', () => {
  it('folds StreamEvent→SSE chunks in order and terminates with [DONE]', async () => {
    const { base } = await start({
      streamEvents: [
        { type: 'reasoning', content: 'hmm' },
        { type: 'text', content: 'hel' },
        { type: 'text', content: 'lo' },
        {
          type: 'tool_start',
          content: 'bash',
          metadata: { id: 'c1', tool: 'bash', args: { cmd: 'ls' } },
        },
        { type: 'tool_result', content: 'out', metadata: { id: 'c1', output: 'out' } },
        { type: 'status', content: 'working' },
        { type: 'done', content: '' },
      ],
    })
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const raw = await res.text()
    const frames = raw
      .split('\n\n')
      .map((b) => b.trim())
      .filter(Boolean)
    expect(frames[frames.length - 1]).toBe('data: [DONE]')

    const parsed = frames
      .slice(0, -1)
      .map((f) => {
        expect(f.startsWith('data: ')).toBe(true)
        return JSON.parse(f.slice(6)) as {
          object: string
          choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>
          rivet_status?: string
        }
      })
    expect(parsed.every((p) => p.object === 'chat.completion.chunk')).toBe(true)
    // opening role delta
    expect(parsed[0]?.choices[0]?.delta).toMatchObject({ role: 'assistant' })
    const deltas = parsed.slice(1).map((p) => p.choices[0]?.delta)
    expect(deltas).toEqual(
      expect.arrayContaining([
        { reasoning_content: 'hmm' },
        { content: 'hel' },
        { content: 'lo' },
      ]),
    )
    expect(deltas.some((d) => Array.isArray(d?.rivet_tools))).toBe(true)
    // final stop
    const last = parsed[parsed.length - 1]
    expect(last?.choices[0]?.finish_reason).toBe('stop')
  })
})

describe('x-rivet-conversation pins the session', () => {
  it('reuses the same gateway session for header-keyed turns', async () => {
    const { base, gw } = await start()
    const conv = '11111111-2222-3333-4444-555555555555'
    const post = () =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rivet-conversation': conv,
        },
        body: JSON.stringify({
          model: 'claude',
          messages: [{ role: 'user', content: 'turn' }],
        }),
      })
    const r1 = (await (await post()).json()) as { rivet_conversation: string }
    const r2 = (await (await post()).json()) as { rivet_conversation: string }
    expect(r1.rivet_conversation).toBe(conv)
    expect(r2.rivet_conversation).toBe(conv)

    // Ring lives on the gateway channel under the conversation id
    const list = await new Promise<{ sessions: Array<{ id: string; messages: number }> }>(
      (resolve, reject) => {
        // hit /api/sessions via gw.routes[0]
        const server = createServer((req, res) => {
          void gw.routes[0]!.handler(req, res)
        })
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as AddressInfo).port
          void fetch(`http://127.0.0.1:${port}/api/sessions`)
            .then((r) => r.json())
            .then((j) => {
              server.close()
              resolve(j as { sessions: Array<{ id: string; messages: number }> })
            })
            .catch(reject)
        })
      },
    )
    const s = list.sessions.find((x) => x.id === conv)
    expect(s).toBeDefined()
    // 2 user + 2 assistant
    expect(s!.messages).toBe(4)
  })

  it('falls back to body.user when the header is absent', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        user: 'android-device-7',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    const body = (await res.json()) as { rivet_conversation: string }
    expect(body.rivet_conversation).toBe(normalizeConversationId('android-device-7'))
  })
})
