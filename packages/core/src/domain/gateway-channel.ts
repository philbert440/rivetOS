/**
 * Gateway channel — /api/sessions (G5, Appendix F).
 *
 * RivetHub chat enters the NORMAL turn pipeline exactly like Telegram: the
 * channel is registered on the runtime, sessions are just channelIds, and
 * replies flow back through channel.send(). The gateway mounts:
 *
 *   GET  /api/sessions                     recency-ordered session list
 *   GET  /api/sessions/:id/messages        transcript ring (last N)
 *   POST /api/sessions/:id/messages        one user turn {text, userId?,
 *        [?wait=1&timeoutMs=]              agent?}; ?wait blocks for the
 *                                          assistant reply (long-poll)
 *   WS   /api/sessions/ws?session=<id>     live {kind:'message'|'stream'}
 *                                          frames; no session = all sessions
 *
 * Streaming: StreamEvents are forwarded on the SAME dedicated WS route,
 * deliberately separate from den's /api/events (viewers must not have to
 * filter turn deltas out of den's diorama stream — Appendix F).
 *
 * Message ring is process-local by design: durable transcripts already land
 * in memory via the normal pipeline; the ring only serves quick catch-up.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  Channel,
  GatewayRoute,
  InboundMessage,
  OutboundMessage,
  StreamEvent,
} from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('GatewayChannel')

const RING_MAX = 200
const DEFAULT_WAIT_MS = 120_000
const MAX_WAIT_MS = 600_000
const MAX_BODY_BYTES = 256 * 1024
const MAX_BUFFERED = 1024 * 1024

interface RingMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  ts: number
}

export interface GatewayChannelHandle {
  channel: Channel
  routes: GatewayRoute[]
  upgrade: {
    path: string
    handle: (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void
  }
  close(): Promise<void>
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      req.pause()
      throw new Error('body too large')
    }
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

export function createGatewayChannel(opts?: { defaultAgent?: string }): GatewayChannelHandle {
  const sessions = new Map<string, { ring: RingMessage[]; lastActive: number }>()
  const subscribers = new Set<{ ws: WebSocket; session?: string }>()
  /** ?wait long-polls: resolved by the next assistant message per session. */
  const waiters = new Map<string, Array<(m: RingMessage) => void>>()
  let onMessageHandler: ((message: InboundMessage) => Promise<void>) | undefined

  const session = (id: string): { ring: RingMessage[]; lastActive: number } => {
    let s = sessions.get(id)
    if (!s) {
      s = { ring: [], lastActive: Date.now() }
      sessions.set(id, s)
    }
    return s
  }

  const broadcast = (frame: Record<string, unknown>, sessionId: string): void => {
    const payload = JSON.stringify(frame)
    for (const sub of subscribers) {
      if (sub.ws.readyState !== 1 || (sub.session && sub.session !== sessionId)) continue
      if (sub.ws.bufferedAmount > MAX_BUFFERED) {
        sub.ws.terminate()
        subscribers.delete(sub)
        continue
      }
      sub.ws.send(payload)
    }
  }

  const record = (sessionId: string, role: RingMessage['role'], text: string): RingMessage => {
    const msg: RingMessage = { id: randomUUID(), sessionId, role, text, ts: Date.now() }
    const s = session(sessionId)
    s.ring.push(msg)
    if (s.ring.length > RING_MAX) s.ring.splice(0, s.ring.length - RING_MAX)
    s.lastActive = msg.ts
    broadcast({ kind: 'message', ...msg }, sessionId)
    return msg
  }

  const channel: Channel = {
    id: 'gateway',
    platform: 'gateway',
    start: () => {
      log.info('Gateway channel started (sessions via /api/sessions)')
      return Promise.resolve()
    },
    stop: () => Promise.resolve(),
    send(message: OutboundMessage): Promise<string | null> {
      if (!message.text) return Promise.resolve(null)
      const msg = record(message.channelId, 'assistant', message.text)
      const pending = waiters.get(message.channelId)
      if (pending?.length) {
        for (const resolve of pending.splice(0)) resolve(msg)
      }
      return Promise.resolve(msg.id)
    },
    onStreamEvent(message: InboundMessage, event: StreamEvent): void {
      broadcast({ kind: 'stream', session: message.channelId, event }, message.channelId)
    },
    onMessage(handler): void {
      onMessageHandler = handler
    },
    onCommand(): void {
      // Slash commands ride the normal text path for now; the runtime's
      // command handler intercepts them before queuing (registerChannel).
    },
  }

  const routes: GatewayRoute[] = [
    {
      prefix: '/api/sessions',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rest = url.pathname.slice('/api/sessions'.length).replace(/^\//, '')
          const [id, sub] = rest === '' ? [undefined, undefined] : rest.split('/')

          if (req.method === 'GET' && !id) {
            const list = [...sessions.entries()]
              .map(([sessionId, s]) => ({
                id: sessionId,
                lastActive: s.lastActive,
                messages: s.ring.length,
              }))
              .sort((a, b) => b.lastActive - a.lastActive)
            return json(res, 200, { sessions: list })
          }

          if (!id || sub !== 'messages') return json(res, 404, { error: 'not found' })

          if (req.method === 'GET') {
            return json(res, 200, { messages: session(id).ring })
          }

          if (req.method === 'POST') {
            if (!onMessageHandler) return json(res, 503, { error: 'channel not started' })
            const body = await readJsonBody(req).catch((err: unknown) => {
              json(res, (err as Error).message === 'body too large' ? 413 : 400, {
                error: (err as Error).message,
              })
              return null
            })
            if (body === null) return
            if (body === undefined || typeof body.text !== 'string' || body.text.trim() === '')
              return json(res, 400, { error: 'text (string) is required' })

            const inbound: InboundMessage = {
              id: randomUUID(),
              userId: typeof body.userId === 'string' ? body.userId : 'gateway-user',
              channelId: id,
              chatType: 'direct',
              text: body.text,
              platform: 'gateway',
              agent: typeof body.agent === 'string' ? body.agent : opts?.defaultAgent,
              timestamp: Math.floor(Date.now() / 1000),
            }
            record(id, 'user', body.text)

            const wait =
              url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true'
            const replyPromise = wait
              ? new Promise<RingMessage | undefined>((resolve) => {
                  const raw = url.searchParams.get('timeoutMs')
                  const n = raw ? Number.parseInt(raw, 10) : NaN
                  const waitMs =
                    Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WAIT_MS) : DEFAULT_WAIT_MS
                  const list = waiters.get(id) ?? []
                  waiters.set(id, list)
                  const timer = setTimeout(() => {
                    const idx = list.indexOf(done)
                    if (idx >= 0) list.splice(idx, 1)
                    resolve(undefined)
                  }, waitMs)
                  timer.unref()
                  function done(m: RingMessage): void {
                    clearTimeout(timer)
                    resolve(m)
                  }
                  list.push(done)
                })
              : undefined

            // Fire the turn — replies arrive via channel.send().
            void onMessageHandler(inbound).catch((err: unknown) => {
              log.warn(`gateway turn failed: ${(err as Error).message}`)
              void channel.send({
                channelId: id,
                text: `⚠️ turn failed: ${(err as Error).message}`,
              })
            })

            if (!replyPromise) return json(res, 202, { accepted: true, session: id })
            const reply = await replyPromise
            if (!reply) return json(res, 504, { error: 'no reply before deadline' })
            return json(res, 200, { message: reply })
          }

          return json(res, 405, { error: 'method not allowed' })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn(`sessions api error: ${msg}`)
          if (!res.headersSent) json(res, 500, { error: msg })
        }
      },
    },
  ]

  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sub = { ws, session: url.searchParams.get('session') ?? undefined }
    subscribers.add(sub)
    ws.on('close', () => subscribers.delete(sub))
    ws.on('error', () => subscribers.delete(sub))
  })

  return {
    channel,
    routes,
    upgrade: {
      path: '/api/sessions/ws',
      handle: (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      },
    },
    close: async () => {
      for (const sub of subscribers) sub.ws.terminate()
      subscribers.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
