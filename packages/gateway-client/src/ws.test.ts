import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { SessionWsFrame } from '@rivetos/types'
import { subscribe, type WebSocketLike } from './ws.js'

async function listen(wss: WebSocketServer): Promise<number> {
  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const addr = wss.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return addr.port
}

// node ≥22 ships a platform WebSocket; the default factory should find it.
const hasPlatformWs = typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'

describe('subscribe', () => {
  it.runIf(hasPlatformWs)('receives frames and appends token + query', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const port = await listen(wss)
    const seenUrls: string[] = []
    wss.on('connection', (ws, req) => {
      seenUrls.push(req.url ?? '')
      ws.send(
        JSON.stringify({
          kind: 'message',
          id: 'm1',
          sessionId: 'lobby',
          role: 'assistant',
          text: 'hi',
          ts: 1,
        } satisfies SessionWsFrame),
      )
    })

    const frames: SessionWsFrame[] = []
    await new Promise<void>((resolve) => {
      const sub = subscribe<SessionWsFrame>(
        { baseUrl: `http://127.0.0.1:${port}`, token: 'tok' },
        {
          path: '/api/sessions/ws',
          query: { session: 'lobby' },
          onFrame: (frame) => {
            frames.push(frame)
            sub.close()
            resolve()
          },
        },
      )
    })

    expect(frames[0]).toMatchObject({ kind: 'message', text: 'hi' })
    expect(seenUrls[0]).toContain('session=lobby')
    expect(seenUrls[0]).toContain('token=tok')
    wss.close()
  })

  it.runIf(hasPlatformWs)('reconnects after a server-side drop', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const port = await listen(wss)
    let connections = 0
    wss.on('connection', (ws) => {
      connections += 1
      if (connections === 1) ws.close() // force one reconnect cycle
      else ws.send(JSON.stringify({ kind: 'stream', session: 's', event: { type: 'x' } }))
    })

    await new Promise<void>((resolve) => {
      const sub = subscribe<{ kind: string }>(
        { baseUrl: `http://127.0.0.1:${port}` },
        {
          path: '/ws',
          maxBackoffMs: 600,
          onFrame: () => {
            sub.close()
            resolve()
          },
        },
      )
    })
    expect(connections).toBeGreaterThanOrEqual(2)
    wss.close()
  })

  it('close() stops reconnect attempts', async () => {
    let created = 0
    const factory = (): WebSocketLike => {
      created += 1
      const listeners = new Map<string, ((e: never) => void)[]>()
      const ws: WebSocketLike = {
        readyState: 0,
        send: () => {},
        close: () => {},
        addEventListener: (type, fn) => {
          const list = listeners.get(type) ?? []
          list.push(fn)
          listeners.set(type, list)
        },
      }
      // Simulate immediate connection failure → close event.
      queueMicrotask(() => listeners.get('close')?.forEach((fn) => fn(undefined as never)))
      return ws
    }

    const sub = subscribe({ baseUrl: 'http://127.0.0.1:9' }, {
      path: '/ws',
      onFrame: () => {},
      factory,
    })
    // Let the first close fire, then close the subscription.
    await new Promise((r) => setTimeout(r, 10))
    sub.close()
    const after = created
    await new Promise((r) => setTimeout(r, 700))
    expect(created).toBe(after)
  })
})
