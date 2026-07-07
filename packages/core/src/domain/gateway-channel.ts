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
  SessionMessage,
  SessionMessagesResponse,
  SessionPostAccepted,
  SessionPostReply,
  SessionsListResponse,
  SessionWsFrame,
  StreamEvent,
} from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('GatewayChannel')

const RING_MAX = 200
const DEFAULT_WAIT_MS = 120_000
const MAX_WAIT_MS = 600_000
const MAX_BODY_BYTES = 256 * 1024
const MAX_BUFFERED = 1024 * 1024

// Wire contract lives in @rivetos/types gateway-api.ts; ring entries ARE the
// wire shape.
type RingMessage = SessionMessage

export interface GatewayChannelHandle {
  channel: Channel
  routes: GatewayRoute[]
  upgrade: {
    path: string
    handle: (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void
  }
  /** Push an external frame to WS subscribers (seamless-modes den bridge). */
  emitFrame(frame: SessionWsFrame): void
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

  const broadcast = (frame: SessionWsFrame, sessionId: string): void => {
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
      // FIFO: one assistant reply resolves exactly ONE waiter. Turns on a
      // session are serialized per user by the runtime queue, so replies
      // arrive in submission order and FIFO pairing is correct; resolving
      // every waiter cross-delivered replies to concurrent long-polls
      // (review finding). Multi-user concurrent ?wait on one session can
      // still interleave — RivetHub uses one client per session; revisit
      // with per-turn correlation ids if that changes.
      const pending = waiters.get(message.channelId)
      const resolve = pending?.shift()
      if (resolve) resolve(msg)
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
            return json(res, 200, { sessions: list } satisfies SessionsListResponse)
          }

          if (!id || sub !== 'messages') return json(res, 404, { error: 'not found' })

          if (req.method === 'GET') {
            return json(res, 200, { messages: session(id).ring } satisfies SessionMessagesResponse)
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

            // Per-turn reasoning effort rides in metadata.thinking — the turn
            // handler reads it and falls back to the session level (RivetHub's
            // effort dropdown, persisted per-conversation client-side).
            const THINK = ['off', 'low', 'medium', 'high', 'xhigh']
            const thinking =
              typeof body.thinking === 'string' && THINK.includes(body.thinking)
                ? body.thinking
                : undefined
            const inbound: InboundMessage = {
              id: randomUUID(),
              userId: typeof body.userId === 'string' ? body.userId : 'gateway-user',
              channelId: id,
              chatType: 'direct',
              text: body.text,
              platform: 'gateway',
              agent: typeof body.agent === 'string' ? body.agent : opts?.defaultAgent,
              ...(thinking ? { metadata: { thinking } } : {}),
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

            if (!replyPromise)
              return json(res, 202, { accepted: true, session: id } satisfies SessionPostAccepted)
            const reply = await replyPromise
            if (!reply) return json(res, 504, { error: 'no reply before deadline' })
            return json(res, 200, { message: reply } satisfies SessionPostReply)
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
    // Seamless modes (5d): push an external frame to /api/sessions/ws
    // subscribers — the den-event bridge maps a harness's live AgentEvents
    // into stream/message frames so the chat view of a PTY conversation
    // streams like the chat-loop path. Message frames also land in the ring
    // so a late-connecting client's list/backfill sees them.
    emitFrame: (frame: SessionWsFrame): void => {
      if (frame.kind === 'message') {
        const s = session(frame.sessionId)
        if (!s.ring.some((m) => m.id === frame.id)) {
          const { kind: _k, ...msg } = frame
          s.ring.push(msg)
          if (s.ring.length > RING_MAX) s.ring.splice(0, s.ring.length - RING_MAX)
          s.lastActive = msg.ts
        }
        broadcast(frame, frame.sessionId)
      } else {
        broadcast(frame, frame.session)
      }
    },
    close: async () => {
      for (const sub of subscribers) sub.ws.terminate()
      subscribers.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

/**
 * Map a den AgentEvent to a sessions-WS frame for the chat view of a live
 * harness conversation (seamless modes 5d). Assistant/user text become
 * message frames (message.agent lands once on the harness Stop); thinking /
 * tool events become stream frames that drive the live "working…" indicators.
 * Returns null for events that aren't chat-relevant (session.start, activity,
 * raw term.line — the terminal view shows those).
 */
export function agentEventToFrame(ev: AgentEventForBridge): SessionWsFrame | null {
  const session = ev.session
  const ts = typeof ev.ts === 'number' ? ev.ts : Date.now()
  const str = (k: string): string => (typeof ev[k] === 'string' ? ev[k] : '')
  switch (ev.type) {
    case 'message.user':
      return {
        kind: 'message',
        id: randomUUID(),
        sessionId: session,
        role: 'user',
        text: str('text'),
        ts,
      }
    case 'message.agent':
      return {
        kind: 'message',
        id: randomUUID(),
        sessionId: session,
        role: 'assistant',
        text: str('text'),
        ts,
      }
    case 'thinking.delta':
      return { kind: 'stream', session, event: { type: 'reasoning', content: str('text') } }
    case 'tool.start':
      return { kind: 'stream', session, event: { type: 'tool_start', content: str('tool') } }
    case 'tool.end':
      return { kind: 'stream', session, event: { type: 'tool_result', content: str('tool') } }
    case 'session.end':
      return { kind: 'stream', session, event: { type: 'done', content: '' } }
    default:
      return null
  }
}

/** The ingested-AgentEvent shape the bridge reads (den-server passes this
 *  verbatim) — deliberately broad so core needn't depend on
 *  @rivetos/den-protocol; agentEventToFrame reads fields defensively. */
export interface AgentEventForBridge {
  session: string
  type: string
  ts?: number
  [k: string]: unknown
}
