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
    if (config.token) u.searchParams.set('token', config.token)
    return u.toString()
  }

  const connect = (): void => {
    if (closed) return
    opts.onStatus?.('connecting')
    ws = factory(url())
    ws.addEventListener('open', () => {
      attempt = 0
      opts.onStatus?.('open')
    })
    ws.addEventListener('message', (event: never) => {
      const data = (event as { data: unknown }).data
      if (typeof data !== 'string') return
      try {
        opts.onFrame(JSON.parse(data) as TFrame)
      } catch {
        // Tolerate unparseable frames — a future server may add non-JSON
        // keepalives; dropping one frame must not kill the subscription.
      }
    })
    ws.addEventListener('close', () => {
      opts.onStatus?.('closed')
      if (closed) return
      const backoff = Math.min(500 * 2 ** attempt, maxBackoff)
      attempt += 1
      timer = setTimeout(connect, backoff + Math.random() * 250)
      // Node returns a Timeout with unref; browsers return a number.
      ;(timer as { unref?: () => void }).unref?.()
    })
    ws.addEventListener('error', () => {
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
  }
}
