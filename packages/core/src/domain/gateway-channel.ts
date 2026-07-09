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
  MessageUsage,
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
  /** Push an external frame to WS subscribers + ring message frames
   *  (seamless-modes; exposed for the bridge and tests). */
  emitFrame(frame: SessionWsFrame): void
  /** Bridge one live harness AgentEvent into the chat view (seamless modes).
   *  Stateful: coalesces per-block assistant text into one committed message
   *  per turn; skips `task:` sessions. Wire to den-server's onAgentEvent. */
  bridgeAgentEvent(ev: AgentEventForBridge): void
  close(): Promise<void>
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Flatten a memory Message.content (string | ContentPart[]) to display text
 *  for the chat backfill — join the text parts, drop non-text parts. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((p) =>
        p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .join('')
  return ''
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

/** Just the memory slice the backfill route needs (seamless modes 5e). */
type MemoryBackfill = {
  getSessionHistory(
    sessionId: string,
    options?: { limit?: number },
  ): Promise<Array<{ role: string; content: unknown }>>
}

export function createGatewayChannel(opts?: {
  defaultAgent?: string
  /** Lazy accessor for the durable transcript store — memory registers on the
   *  runtime AFTER the channel is built, so read it at request time. */
  getMemory?: () => MemoryBackfill | undefined
}): GatewayChannelHandle {
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

  // Seamless-modes bridge state: per-session accumulated assistant text,
  // flushed to ONE message frame at the turn boundary (see bridgeAgentEvent).
  const pendingAssistant = new Map<string, string>()
  // Turn stats ride the FINAL message.agent block (Claude Code attaches them);
  // stash until the assistant turn is committed, then attach to the frame.
  const pendingStats = new Map<
    string,
    { usage?: MessageUsage; model?: string; durationMs?: number }
  >()

  const emitFrame = (frame: SessionWsFrame): void => {
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
    {
      // Seamless modes (5e): durable backfill for a harness conversation —
      // GET /api/conversations/:key/messages reads the memory transcript
      // (the ring is process-local + live only; a cold or reconnecting client
      // reads the committed history here, then the sessions WS streams live).
      prefix: '/api/conversations',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rest = url.pathname.slice('/api/conversations'.length).replace(/^\//, '')
          const [rawKey, sub] = rest.split('/')
          const key = decodeURIComponent(rawKey ?? '')
          const limRaw = url.searchParams.get('limit')
          const limN = limRaw ? Number.parseInt(limRaw, 10) : NaN
          const limit = Number.isFinite(limN) && limN > 0 ? Math.min(limN, 1000) : 200

          if (req.method !== 'GET' || !key || sub !== 'messages')
            return json(res, 404, { error: 'not found' })
          const mem = opts?.getMemory?.()
          if (!mem) return json(res, 200, { messages: [] } satisfies SessionMessagesResponse)
          const history = await mem.getSessionHistory(key, { limit })
          const messages = history
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m, i) => ({
              id: `${key}:${String(i)}`,
              sessionId: key,
              role: m.role as 'user' | 'assistant',
              text: contentToText(m.content),
              ts: 0,
            }))
          return json(res, 200, { messages } satisfies SessionMessagesResponse)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn(`conversations api error: ${msg}`)
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
    // Seamless modes (5d): broadcast a frame to /api/sessions/ws subscribers;
    // ring message frames so a late client's backfill sees them. Exposed for
    // tests + the bridge below.
    emitFrame,
    // Seamless modes (5d): bridge a live harness AgentEvent into the chat
    // view. STATEFUL by design (#313 review): message.agent fires per text
    // block, not once — so interim blocks stream as text deltas and coalesce
    // into ONE assistant message committed at the turn boundary (next user
    // turn, or session.end), never one bubble per block. thinking/tool events
    // drive the live "working…" indicators. `task:` sessions are the task
    // engine's namespace and are skipped (no RivetHub-chat pollution).
    bridgeAgentEvent: (ev: AgentEventForBridge): void => {
      const sid = ev.session
      if (typeof sid !== 'string' || sid.startsWith('task:')) return
      const str = (k: string): string => (typeof ev[k] === 'string' ? ev[k] : '')
      const ts = typeof ev.ts === 'number' ? ev.ts : Date.now()
      const flushAssistant = (): void => {
        const text = pendingAssistant.get(sid)
        if (text) {
          const stats = pendingStats.get(sid)
          emitFrame({
            kind: 'message',
            id: randomUUID(),
            sessionId: sid,
            role: 'assistant',
            text,
            ts,
            // turn stats (Claude Code): undefined for harnesses that don't
            // report them — the client just omits the nerd line.
            ...(stats?.usage ? { usage: stats.usage } : {}),
            ...(stats?.model ? { model: stats.model } : {}),
            ...(stats?.durationMs !== undefined ? { durationMs: stats.durationMs } : {}),
          })
          pendingAssistant.delete(sid)
        }
        // clear stats on EVERY flush boundary, even with no committable text —
        // a stray stats-only event must never bleed into the next turn (grok
        // review).
        pendingStats.delete(sid)
      }
      switch (ev.type) {
        case 'message.user':
          flushAssistant() // a new user turn commits the prior assistant turn
          emitFrame({
            kind: 'message',
            id: randomUUID(),
            sessionId: sid,
            role: 'user',
            text: str('text'),
            ts,
          })
          break
        case 'message.agent': {
          // interim block: accumulate + stream (one committed bubble per turn)
          pendingAssistant.set(sid, (pendingAssistant.get(sid) ?? '') + str('text'))
          emitFrame({ kind: 'stream', session: sid, event: { type: 'text', content: str('text') } })
          // the FINAL block of a turn may carry token stats (validated upstream
          // by parseEvent) — stash them for the flush that commits this turn.
          if (
            (ev.usage && typeof ev.usage === 'object') ||
            typeof ev.model === 'string' ||
            typeof ev.durationMs === 'number'
          ) {
            const stats = pendingStats.get(sid) ?? {}
            if (ev.usage && typeof ev.usage === 'object') stats.usage = ev.usage as MessageUsage
            if (typeof ev.model === 'string') stats.model = ev.model
            if (typeof ev.durationMs === 'number') stats.durationMs = ev.durationMs
            pendingStats.set(sid, stats)
          }
          break
        }
        case 'thinking.delta':
          emitFrame({
            kind: 'stream',
            session: sid,
            event: { type: 'reasoning', content: str('text') },
          })
          break
        case 'activity': {
          // Hermes/den activity labels ("thinking", "writing_plan", …) → status
          // line on the live bubble so non-Claude harnesses show progress too.
          const label = str('activity') || str('text') || 'working…'
          emitFrame({
            kind: 'stream',
            session: sid,
            event: { type: 'status', content: label },
          })
          break
        }
        case 'tool.start': {
          // Optional args/input from harness adapters (when present) ride in
          // metadata so Hub can title tools and extract ask-user chips.
          // Summarize (200-char strings) — never forward raw Write bodies /
          // full secrets onto the all-sessions WS (tools-aisdk parity).
          // Missing args are fine — UI degrades to the tool name only.
          const toolName = str('tool')
          const rawArgs = ev.args ?? ev.input ?? ev.arguments
          const metadata: Record<string, unknown> = { tool: toolName }
          const summarized = summarizeBridgeArgs(rawArgs)
          if (summarized !== undefined) metadata.args = summarized
          emitFrame({
            kind: 'stream',
            session: sid,
            event: { type: 'tool_start', content: toolName, metadata },
          })
          break
        }
        case 'tool.end': {
          const toolName = str('tool')
          emitFrame({
            kind: 'stream',
            session: sid,
            event: {
              type: 'tool_result',
              content: toolName,
              metadata: toolName ? { tool: toolName } : undefined,
            },
          })
          break
        }
        case 'session.end':
          flushAssistant() // commit the final assistant turn
          emitFrame({ kind: 'stream', session: sid, event: { type: 'done', content: '' } })
          break
      }
    },
    close: async () => {
      for (const sub of subscribers) sub.ws.terminate()
      subscribers.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

/** The ingested-AgentEvent shape the bridge reads (den-server passes this
 *  verbatim) — deliberately broad so core needn't depend on
 *  @rivetos/den-protocol; the bridge reads fields defensively. */
export interface AgentEventForBridge {
  session: string
  type: string
  ts?: number
  [k: string]: unknown
}

const BRIDGE_ARG_KEYS_MAX = 40
const BRIDGE_ARG_STR_MAX = 200
/** Deep enough for AskUserQuestion { questions: [{ options: [{ label }] }] }. */
const BRIDGE_ARG_DEPTH_MAX = 5
const SECRET_KEY_RE =
  /^(?:.*(?:password|passwd|secret|token|api[_-]?key|authorization|auth|credential|private[_-]?key).*)$/i

/**
 * Value-pattern redaction for free-text args (parity with den-hook redact()).
 * Catches secrets embedded in ordinary keys like `command`.
 */
function redactValuePatterns(s: string): string {
  return s
    .replace(/\b(bearer|basic)\s+[\w+./=-]{8,}/gi, '$1 [redacted]')
    .replace(
      /\b([\w-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[\w-]*\s*[=:]\s*)\S+/gi,
      '$1[redacted]',
    )
    .replace(
      /\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[a-z]-[\w-]{10,}|sk-[A-Za-z0-9_-]{16,}|eyJ[\w-]{8,}\.[\w-]+\.[\w-]+)\b/g,
      '[redacted]',
    )
}

function capStr(s: string): string {
  const r = redactValuePatterns(s)
  return r.length > BRIDGE_ARG_STR_MAX ? r.slice(0, BRIDGE_ARG_STR_MAX) + '…' : r
}

/**
 * Cap + redact tool args for the sessions WS (all-subscribers).
 * - secret-ish keys → "[redacted]"
 * - string values run through value-pattern redact then length-capped
 * - nested objects to depth 5, key count 40 (den-hook parity)
 */
function summarizeBridgeArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as unknown
    } catch {
      return { value: capStr(raw) }
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined
  return summarizeBridgeValue(obj, 0) as Record<string, unknown>
}

function summarizeBridgeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return capStr(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= BRIDGE_ARG_DEPTH_MAX) {
    if (Array.isArray(value)) return `[array:${value.length}]`
    if (typeof value === 'object') return '[omitted]'
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => summarizeBridgeValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let n = 0
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= BRIDGE_ARG_KEYS_MAX) {
        out['…'] = 'truncated'
        break
      }
      if (SECRET_KEY_RE.test(key)) {
        out[key] = '[redacted]'
        continue
      }
      out[key] = summarizeBridgeValue(v, depth + 1)
    }
    return out
  }
  // unknown primitives (bigint/symbol) — don't Object-string them
  return typeof value === 'bigint' ? value.toString() : '[omitted]'
}
