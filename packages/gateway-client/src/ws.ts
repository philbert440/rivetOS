/**
 * Reconnecting WS subscription over the gateway's server→client frame
 * channels (/api/sessions/ws now, /api/notifications/ws in 4e).
 *
 * Uses the platform WebSocket (browser / node ≥22 undici) through a minimal
 * structural type so the package needs neither lib.dom nor the 'ws' package
 * at runtime. Auth rides `?token=` — browsers cannot set headers on WS.
 */

import type { GatewayClientConfig } from '@rivetos/types'

export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: never) => void): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface SubscriptionOptions<TFrame> {
  /** WS path, e.g. '/api/sessions/ws'. */
  path: string
  query?: Record<string, string | undefined>
  onFrame: (frame: TFrame) => void
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void
  /** Test seam; defaults to the platform WebSocket. */
  factory?: WebSocketFactory
  /** Reconnect backoff cap in ms (default 15s; base 500ms, doubling). */
  maxBackoffMs?: number
}

export interface Subscription {
  close(): void
  /** Send a control message (e.g. transcript watch/unwatch). Returns false
   *  when the socket isn't open — callers re-send on the next 'open'. */
  send(data: unknown): boolean
}

const defaultFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (!Ctor) throw new Error('no platform WebSocket — pass a factory')
  return new Ctor(url)
}

export function subscribe<TFrame>(
  config: GatewayClientConfig,
  opts: SubscriptionOptions<TFrame>,
): Subscription {
  const factory = opts.factory ?? defaultFactory
  const maxBackoff = opts.maxBackoffMs ?? 15_000
  let closed = false
  let ws: WebSocketLike | undefined
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const url = (): string => {
    const u = new URL(
      opts.path,
      config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`,
    )
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) u.searchParams.set(key, value)
    }
    // Operators note: the token appears in server/proxy access logs — the
    // unavoidable browser tradeoff (no WS headers). LAN-trust posture today.
    if (config.token) u.searchParams.set('token', config.token)
    return u.toString()
  }

  const connect = (): void => {
    if (closed) return
    // One pending reconnect at most: a socket that emits close twice (proxy
    // half-close, error→close races) must not leave an orphaned timer that
    // fires after close() or spawns a second live socket (#296 review).
    if (timer) clearTimeout(timer)
    timer = undefined
    opts.onStatus?.('connecting')
    const socket = factory(url())
    ws = socket
    socket.addEventListener('open', () => {
      if (closed) {
        socket.close(1000)
        return
      }
      attempt = 0
      opts.onStatus?.('open')
    })
    socket.addEventListener('message', (event: never) => {
      const data = (event as { data: unknown }).data
      if (typeof data !== 'string') return
      try {
        opts.onFrame(JSON.parse(data) as TFrame)
      } catch {
        // Tolerate unparseable frames — a future server may add non-JSON
        // keepalives; dropping one frame must not kill the subscription.
      }
    })
    socket.addEventListener('close', () => {
      opts.onStatus?.('closed')
      if (closed) return
      if (timer) clearTimeout(timer) // double-close must not stack timers
      const backoff = Math.min(500 * 2 ** attempt, maxBackoff)
      attempt += 1
      timer = setTimeout(connect, backoff + Math.random() * 250)
      // Node returns a Timeout with unref; browsers return a number.
      ;(timer as { unref?: () => void }).unref?.()
    })
    socket.addEventListener('error', () => {
      // close always follows error; reconnect is handled there.
    })
  }

  connect()

  return {
    close(): void {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close(1000)
    },
    send(data: unknown): boolean {
      if (closed || !ws || ws.readyState !== 1) return false
      try {
        ws.send(JSON.stringify(data))
        return true
      } catch {
        return false
      }
    },
  }
}
