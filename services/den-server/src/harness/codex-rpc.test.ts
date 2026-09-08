import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { CodexRpcClient } from './codex-rpc.js'
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
async function setup() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  cleanup.push(() => {
    for (const s of server.clients) s.terminate()
    server.close()
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const client = new CodexRpcClient(`ws://127.0.0.1:${address.port}`, 500)
  cleanup.push(() => client.close())
  const received: Record<string, unknown>[] = []
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>
      received.push(frame)
      if (frame.method === 'initialize') socket.send(JSON.stringify({ id: frame.id, result: {} }))
      else if (frame.method === 'thread/start')
        socket.send(JSON.stringify({ id: frame.id, result: { thread: { id: 'native' } } }))
      else if (frame.method === 'turn/start') socket.terminate()
    }),
  )
  return { server, client, received }
}
it('initializes before requests and preserves native server request IDs', async () => {
  const { client, server, received } = await setup()
  expect(await client.request('thread/start', {})).toEqual({ thread: { id: 'native' } })
  expect(received.map((f) => f.method)).toEqual(['initialize', 'initialized', 'thread/start'])
  const response = new Promise<void>((resolve) =>
    client.subscribe((f) => {
      if (f.method === 'approval') {
        client.respond(f.id!, { decision: 'accept' })
        resolve()
      }
    }),
  )
  const socket = [...server.clients][0]
  socket.send(JSON.stringify({ id: 'request-7', method: 'approval', params: {} }))
  await response
  const [data] = await once(socket, 'message')
  expect(JSON.parse(String(data))).toEqual({ id: 'request-7', result: { decision: 'accept' } })
})
it('rejects a disconnected mutation without replaying it', async () => {
  const { client, received } = await setup()
  await expect(client.request('turn/start', { input: [] })).rejects.toThrow(
    'outcome may be unknown',
  )
  await client.request('thread/start', {})
  expect(received.filter((f) => f.method === 'turn/start')).toHaveLength(1)
  expect(client.generation).toBe(2)
})
it('rejects non-loopback and credential-bearing endpoints', () => {
  for (const url of ['ws://example.com', 'wss://127.0.0.1', 'ws://user:secret@127.0.0.1']) {
    expect(() => new CodexRpcClient(url)).toThrow('loopback')
  }
})

it('accepts IPv6 loopback URLs', () => {
  const client = new CodexRpcClient('ws://[::1]:5175')
  client.close()
})

it('backs off reconnects from one second to thirty seconds and resets after initialization', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  let healthy = false
  server.on('connection', (socket) => {
    if (!healthy) {
      socket.terminate()
      return
    }
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { id?: number; method?: string }
      if (frame.id !== undefined) socket.send(JSON.stringify({ id: frame.id, result: {} }))
    })
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const client = new CodexRpcClient(`ws://127.0.0.1:${address.port}`)
  let notify!: () => void
  client.subscribe((frame) => {
    if (frame.method === '$disconnected' || frame.method === '$connected') notify()
  })
  try {
    let edge = new Promise<void>((resolve) => {
      notify = resolve
    })
    await client.request('thread/read', {}).catch(() => undefined)
    await edge
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      expect(timer.mock.calls.at(-1)?.[1]).toBe(delay)
      edge = new Promise<void>((resolve) => {
        notify = resolve
      })
      await vi.advanceTimersByTimeAsync(delay)
      await edge
    }
    healthy = true
    edge = new Promise<void>((resolve) => {
      notify = resolve
    })
    await vi.advanceTimersByTimeAsync(30000)
    await edge
    edge = new Promise<void>((resolve) => {
      notify = resolve
    })
    for (const socket of server.clients) socket.terminate()
    await edge
    expect(timer.mock.calls.at(-1)?.[1]).toBe(1000)
  } finally {
    client.close()
    for (const socket of server.clients) socket.terminate()
    server.close()
    timer.mockRestore()
    vi.useRealTimers()
  }
})
