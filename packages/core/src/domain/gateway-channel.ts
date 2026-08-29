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
 *        [?wait=1&timeoutMs=]              agent?, thinking?, systemPrompt?};
 *                                          ?wait blocks for the assistant reply
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
import { HARNESS_IDS, SYSTEM_PROMPT_MAX_CHARS, splitHermesReasoning } from '@rivetos/types'
import { routedUserFromHeaders } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('GatewayChannel')

/**
 * Legacy-key alias for the read paths (harness-control-plane.md § Legacy
 * keys). Both stores this channel reads are keyed on the BARE native id — the
 * live ring by the den room key an AgentEvent carries, the memory transcript
 * by whatever `RIVETOS_SESSION_KEY` a den-spawned harness inherited — while a
 * client keyed on the identity table asks with the canonical
 * `<harness-id>:<native>` SessionId. Historical rows are never rewritten, so
 * a canonical miss retries under the native half.
 *
 * Returns `undefined` when there is no alias to try (the id is already bare,
 * or is not a SessionId at all — `task:<id>` is a different namespace and is
 * deliberately not parsed as one).
 */
export function bareAliasOf(id: string): string | undefined {
  const i = id.indexOf(':')
  if (i <= 0 || i === id.length - 1) return undefined
  if (!(HARNESS_IDS as readonly string[]).includes(id.slice(0, i))) return undefined
  const native = id.slice(i + 1)
  // Collapse Claude's path-fallback capture key the same way den-server's
  // `collapsePathFallback` (services/den-server/src/harness/alias.ts, reached
  // through `denSessionRef`) does: `claude-code:<project-slug>/<uuid>` aliases
  // to `<uuid>`, not to `<slug>/<uuid>`. The conversations store legitimately
  // holds path-form keys (§ Legacy keys row 2), so two alias implementations
  // disagreeing on that shape is a real miss, not a theoretical one. Kept as a
  // replica rather than a shared import because @rivetos/core must not depend
  // on den-server; `bareAliasOf` and `denSessionRef` share a test vector.
  const slash = native.lastIndexOf('/')
  if (slash >= 0 && UUID_RE.test(native.slice(slash + 1))) return native.slice(slash + 1)
  return native
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const RING_MAX = 200
const DEFAULT_WAIT_MS = 120_000
const MAX_WAIT_MS = 600_000
const MAX_BODY_BYTES = 256 * 1024
const MAX_BUFFERED = 1024 * 1024

// Wire contract lives in @rivetos/types gateway-api.ts; ring entries ARE the
// wire shape.
type RingMessage = SessionMessage

/** Input for a programmatic turn (OpenAI /v1/chat/completions and tests). */
export interface GatewayTurnInput {
  sessionId: string
  text: string
  agent?: string
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Optional system-prompt override; applied once when the session prompt is built. */
  systemPrompt?: string
  userId?: string
  /** Live StreamEvents for this session while the turn runs. */
  onStream?: (event: StreamEvent) => void
  /** Max ms to wait for the assistant reply (default 120s, cap 600s). */
  timeoutMs?: number
}

export type GatewayTurnResult =
  { ok: true; message: SessionMessage } | { ok: false; status: number; error: string }

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
  /**
   * Run one user turn through the gateway channel pipeline — records the user
   * message, fires the channel handler, waits for the **turn** to finish
   * (handler settled — not the first mid-turn `channel.send`), and optionally
   * forwards StreamEvents via `onStream`. Used by OpenAI `/v1/chat/completions`.
   *
   * Mid-turn sends (StreamManager partials on channels without `edit`, tool
   * logs, error bubbles) must not complete the wait; the committed final
   * assistant message after the handler returns is the result.
   */
  submitTurn(input: GatewayTurnInput): Promise<GatewayTurnResult>
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

const THINK_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const

function clipSystemPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, SYSTEM_PROMPT_MAX_CHARS)
}

/** Per-turn extras that ride InboundMessage.metadata (effort + system prompt). */
function turnMetadata(input: {
  thinking?: unknown
  systemPrompt?: unknown
}): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {}
  if (
    typeof input.thinking === 'string' &&
    (THINK_LEVELS as readonly string[]).includes(input.thinking)
  ) {
    metadata.thinking = input.thinking
  }
  const systemPrompt = clipSystemPrompt(input.systemPrompt)
  if (systemPrompt) metadata.systemPrompt = systemPrompt
  return Object.keys(metadata).length > 0 ? metadata : undefined
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

/** Push-based transcript sync (seamless modes v2): the den server's store
 *  watcher, refcounted per WS-subscribed session. */
export interface TranscriptWatchHooks {
  watch(session: string): void
  unwatch(session: string): void
  /** Re-emit a full snapshot (client lost a delta). No refcount change. */
  sync(session: string): void
}

export function createGatewayChannel(opts?: {
  defaultAgent?: string
  /** Lazy accessor for the durable transcript store — memory registers on the
   *  runtime AFTER the channel is built, so read it at request time. */
  getMemory?: () => MemoryBackfill | undefined
  /** When present, clients can send {type:'watch'|'unwatch', session} on the
   *  sessions WS to subscribe to pushed transcript frames. */
  transcript?: TranscriptWatchHooks
}): GatewayChannelHandle {
  const sessions = new Map<string, { ring: RingMessage[]; lastActive: number }>()
  const subscribers = new Set<{ ws: WebSocket; session?: string }>()
  /** ?wait long-polls: resolved by the next assistant message per session. */
  const waiters = new Map<string, Array<(m: RingMessage) => void>>()
  /** Per-session stream listeners (OpenAI SSE + programmatic turns). */
  const streamListeners = new Set<{ session: string; fn: (event: StreamEvent) => void }>()
  let onMessageHandler: ((message: InboundMessage) => Promise<void>) | undefined

  const notifyStream = (sessionId: string, event: StreamEvent): void => {
    for (const l of streamListeners) {
      if (l.session === sessionId) l.fn(event)
    }
  }

  const session = (id: string): { ring: RingMessage[]; lastActive: number } => {
    let s = sessions.get(id)
    if (!s) {
      s = { ring: [], lastActive: Date.now() }
      sessions.set(id, s)
    }
    return s
  }

  /**
   * The ring entry an id addresses — the ONE rule reads and writes share.
   *
   * The bridge keys the ring on the den room (the native id); hub chat asks
   * with the canonical `<harness-id>:<native>`, so a canonical id has to reach
   * the native entry. Presence alone is the wrong test for "has its own":
   * an EMPTY own entry must lose to a non-empty alias, or reads and writes
   * disagree and the transcript forks. A process carrying a phantom
   * `{ ring: [] }` under a canonical key — minted by an older build, or by a
   * write that allocated before the den session existed — would otherwise
   * self-heal on read (serving the native history) and then take the next
   * write into the empty own ring, flipping every later read from the full
   * history to a one-message ring. That is the original mint-shadow blocker
   * in reverse.
   *
   * Order: own non-empty → alias non-empty → own. The fallback returns `id`
   * whether or not an entry exists there; only writes may create one.
   */
  const ringKeyFor = (id: string): string => {
    const own = sessions.get(id)
    if (own && own.ring.length > 0) return id
    const alias = bareAliasOf(id)
    if (alias === undefined) return id
    const aliased = sessions.get(alias)
    if (!aliased || aliased.ring.length === 0) return id
    // Serving the alias past an empty own entry: drop the phantom, so
    // `GET /api/sessions` stops advertising a session with no messages while
    // the real transcript lives under the native key.
    if (own) sessions.delete(id)
    return alias
  }

  /**
   * Read a session's ring WITHOUT allocating one.
   *
   * `session()` is get-or-create, which used to be harmless: a bare GET minted
   * a bare entry and the bridge writes bare, so the minted entry was the one
   * future frames landed in. Under canonical keys it is a trap — a canonical
   * GET arriving BEFORE the first frame (the hub's cold-open ordering, gated
   * on `storeEmpty`) would mint an empty ring, make that key authoritative
   * forever, and permanently shadow the native history behind it.
   */
  const readRing = (id: string): RingMessage[] => sessions.get(ringKeyFor(id))?.ring ?? []

  /** sessionId undefined = deliver to every subscriber (drawer signals). */
  const broadcast = (frame: SessionWsFrame, sessionId: string | undefined): void => {
    const payload = JSON.stringify(frame)
    for (const sub of subscribers) {
      if (sub.ws.readyState !== 1) continue
      if (sessionId !== undefined && sub.session && sub.session !== sessionId) continue
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
  /** Raw message.agent accumulation — split at emit/flush so a Hermes box
   *  that arrives in chunks is stripped as a whole, not per delta. */
  const pendingRaw = new Map<string, string>()
  /** Previous emitted reasoning for delta calculation (B3). */
  const pendingReasoning = new Map<string, string>()
  /** Track harness per session for B5 scoping. */
  const pendingHarness = new Map<string, string>()
  // Turn stats ride the FINAL message.agent block (Claude Code attaches them);
  // stash until the assistant turn is committed, then attach to the frame.
  const pendingStats = new Map<
    string,
    { usage?: MessageUsage; model?: string; durationMs?: number }
  >()

  const emitFrame = (frame: SessionWsFrame): void => {
    if (frame.kind === 'message') {
      const s = session(frame.sessionId)
      const { kind: _k, ...msg } = frame
      let inserted = false
      if (!s.ring.some((m) => m.id === msg.id)) {
        s.ring.push(msg)
        if (s.ring.length > RING_MAX) s.ring.splice(0, s.ring.length - RING_MAX)
        s.lastActive = msg.ts
        inserted = true
      }
      broadcast(frame, frame.sessionId)
      // Harness bridge commits assistant turns via emitFrame (not channel.send);
      // resolve ?wait / submitTurn waiters the same way channel.send does.
      if (inserted && msg.role === 'assistant') {
        const pending = waiters.get(msg.sessionId)
        const resolve = pending?.shift()
        if (resolve) resolve(msg)
      }
    } else if (frame.kind === 'sessions-dirty') {
      broadcast(frame, undefined) // drawer signal — every subscriber
    } else {
      broadcast(frame, frame.session)
      if (frame.kind === 'stream') notifyStream(frame.session, frame.event)
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
      notifyStream(message.channelId, event)
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
          const [rawId, sub] = rest === '' ? [undefined, undefined] : rest.split('/')
          // Canonical SessionIds carry a `:`, which encodeURIComponent escapes
          // — decode before it is used as a key (bare uuids are unaffected).
          const id = rawId === undefined ? undefined : decodeURIComponent(rawId)

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
            // Alias read: the ring is filed under the den room key the bridge
            // saw, so a canonical id falls back to its native half — and never
            // allocates, or it would shadow that history (see `readRing`).
            return json(res, 200, { messages: readRing(id) } satisfies SessionMessagesResponse)
          }

          if (req.method === 'POST') {
            if (!onMessageHandler) return json(res, 503, { error: 'channel not started' })
            // One key for the whole turn — the inbound `channelId`, the ring
            // append, the long-poll waiter and the error reply all have to
            // agree, or the user turn and its answer land in different rings.
            // A canonical id with no ring of its own joins the legacy
            // bare-keyed one rather than forking a second transcript.
            const key = ringKeyFor(id)
            const body = await readJsonBody(req).catch((err: unknown) => {
              json(res, (err as Error).message === 'body too large' ? 413 : 400, {
                error: (err as Error).message,
              })
              return null
            })
            if (body === null) return
            if (body === undefined || typeof body.text !== 'string' || body.text.trim() === '')
              return json(res, 400, { error: 'text (string) is required' })

            // Per-turn extras ride in metadata: thinking (effort dropdown) and
            // systemPrompt (agent-preset override, applied once at session init).
            const metadata = turnMetadata(body)
            // den-server resolves the mTLS device cert to a user and stamps
            // this header after stripping any inbound value. It is the ONLY
            // identity that may route memory — the body's userId field is
            // client-controlled and is deliberately ignored (it used to be a
            // label; with per-user routing it would select a database).
            const certUser = routedUserFromHeaders(req.headers)
            const inbound: InboundMessage = {
              id: randomUUID(),
              userId: certUser ?? 'gateway-user',
              channelId: key,
              chatType: 'direct',
              text: body.text,
              platform: 'gateway',
              agent: typeof body.agent === 'string' ? body.agent : opts?.defaultAgent,
              ...(metadata ? { metadata } : {}),
              timestamp: Math.floor(Date.now() / 1000),
            }
            record(key, 'user', body.text)

            const wait =
              url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true'
            const replyPromise = wait
              ? new Promise<RingMessage | undefined>((resolve) => {
                  const raw = url.searchParams.get('timeoutMs')
                  const n = raw ? Number.parseInt(raw, 10) : NaN
                  const waitMs =
                    Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WAIT_MS) : DEFAULT_WAIT_MS
                  const list = waiters.get(key) ?? []
                  waiters.set(key, list)
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
                channelId: key,
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
          let history = await mem.getSessionHistory(key, { limit })
          // Alias read: capture files a den-spawned harness under the bare
          // den join key it inherited via RIVETOS_SESSION_KEY, so a canonical
          // ask with no rows retries the native half. Nothing is rewritten —
          // the alias covers the read forever (§ Legacy keys).
          if (history.length === 0) {
            const alias = bareAliasOf(key)
            if (alias !== undefined) history = await mem.getSessionHistory(alias, { limit })
          }
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
    // Per-socket transcript subscriptions (watch/unwatch control messages).
    // Refcounted against the den server's store watcher; everything this
    // socket watched is released when it goes away.
    const watchedBySocket = new Set<string>()
    const release = (): void => {
      subscribers.delete(sub)
      for (const sid of watchedBySocket) opts?.transcript?.unwatch(sid)
      watchedBySocket.clear()
    }
    if (opts?.transcript) {
      const transcript = opts.transcript
      ws.on('message', (data: Buffer | string) => {
        let msg: unknown
        try {
          msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
        } catch {
          return // tolerate junk — never kill the socket over a bad frame
        }
        const m = msg as { type?: unknown; session?: unknown }
        if (typeof m.session !== 'string' || !m.session || m.session.length > 256) return
        if (m.type === 'watch' && !watchedBySocket.has(m.session)) {
          watchedBySocket.add(m.session)
          transcript.watch(m.session)
        } else if (m.type === 'unwatch' && watchedBySocket.has(m.session)) {
          watchedBySocket.delete(m.session)
          transcript.unwatch(m.session)
        } else if (m.type === 'sync' && watchedBySocket.has(m.session)) {
          transcript.sync(m.session)
        }
      })
    }
    ws.on('close', release)
    ws.on('error', release)
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
    async submitTurn(input: GatewayTurnInput): Promise<GatewayTurnResult> {
      if (!onMessageHandler) return { ok: false, status: 503, error: 'channel not started' }
      const text = input.text.trim()
      if (!text) return { ok: false, status: 400, error: 'text (string) is required' }

      // Same one-key-per-turn discipline as the HTTP POST handler: this is the
      // OpenAI-compat door onto the identical ring, so a canonical session id
      // here must join the transcript the den bridge is filling rather than
      // fork a second one.
      const key = ringKeyFor(input.sessionId)
      const metadata = turnMetadata(input)
      const inbound: InboundMessage = {
        id: randomUUID(),
        userId: input.userId ?? 'gateway-user',
        channelId: key,
        chatType: 'direct',
        text,
        platform: 'gateway',
        agent: input.agent ?? opts?.defaultAgent,
        ...(metadata ? { metadata } : {}),
        timestamp: Math.floor(Date.now() / 1000),
      }
      // Capture the user-message id so we can pick the *last* assistant after
      // this turn — not a StreamManager mid-turn partial that arrives first.
      const userMsg = record(key, 'user', text)

      const listener = input.onStream ? { session: key, fn: input.onStream } : undefined
      if (listener) streamListeners.add(listener)

      const waitMs =
        input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? Math.min(input.timeoutMs, MAX_WAIT_MS)
          : DEFAULT_WAIT_MS

      // Completion = turn handler settled (genuine end-of-turn), NOT the first
      // channel.send. Gateway has no edit(), so StreamManager's first partial
      // text / tool-log is a mid-turn send; resolving waiters on that truncated
      // the OpenAI SSE stream and dropped later deltas (PR #381 review).
      const turnDone = onMessageHandler(inbound).catch(async (err: unknown) => {
        log.warn(`gateway turn failed: ${(err as Error).message}`)
        await channel.send({
          channelId: key,
          text: `⚠️ turn failed: ${(err as Error).message}`,
        })
      })

      try {
        const outcome = await Promise.race([
          turnDone.then(() => 'done' as const),
          new Promise<'timeout'>((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), waitMs)
            timer.unref()
          }),
        ])
        if (outcome === 'timeout') {
          return { ok: false, status: 504, error: 'no reply before deadline' }
        }

        // Non-allocating, like every other read: `record(key, …)` above
        // guarantees the entry exists, so this is only belt for the invariant.
        const ring = sessions.get(key)?.ring ?? []
        const userIdx = ring.findIndex((m) => m.id === userMsg.id)
        const after = userIdx >= 0 ? ring.slice(userIdx + 1) : ring
        // Final committed assistant wins over mid-turn partials / tool logs.
        const reply = [...after].reverse().find((m) => m.role === 'assistant')
        if (!reply) return { ok: false, status: 504, error: 'no reply before deadline' }
        return { ok: true, message: reply }
      } finally {
        if (listener) streamListeners.delete(listener)
      }
    },
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
        const raw = pendingRaw.get(sid) ?? pendingAssistant.get(sid)
        pendingRaw.delete(sid)
        const isHermes = pendingHarness.get(sid) === 'hermes'
        const text = raw ? (isHermes ? splitHermesReasoning(raw).text : raw) : ''
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
        }
        pendingAssistant.delete(sid)
        pendingReasoning.delete(sid)
        pendingHarness.delete(sid)
        // clear stats on EVERY flush boundary, even with no committable text —
        // a stray stats-only event must never bleed into the next turn (grok
        // review).
        pendingStats.delete(sid)
      }
      switch (ev.type) {
        case 'message.user': {
          flushAssistant() // a new user turn commits the prior assistant turn
          // Backstop for older den hooks: harness-injected wrappers (task
          // notifications, reminders, command echoes) are not user speech —
          // never bubble them into chat (same prefix list as the transcript
          // parser in den-server harness-sessions.ts).
          const text = str('text')
          if (
            /^(<command-|<local-command|<system-reminder|<task-notification|<user_info|Caveat:)/.test(
              text,
            )
          ) {
            break
          }
          emitFrame({
            kind: 'message',
            id: randomUUID(),
            sessionId: sid,
            role: 'user',
            text,
            ts,
          })
          break
        }
        case 'message.agent': {
          // interim block: accumulate + stream (one committed bubble per turn).
          // Hermes TUI reasoning boxes ride this field — split them out so the
          // live bubble and the committed row are the reply only.
          const chunk = str('text')
          const raw = (pendingRaw.get(sid) ?? '') + chunk
          pendingRaw.set(sid, raw)
          const isHermes = ev.harness === 'hermes'
          if (isHermes && !pendingHarness.has(sid)) pendingHarness.set(sid, 'hermes')
          const split = isHermes ? splitHermesReasoning(raw) : { reasoning: '', text: raw }
          if (split.reasoning) {
            const prevReasoning = pendingReasoning.get(sid) ?? ''
            if (split.reasoning.startsWith(prevReasoning)) {
              const reasoningDelta = split.reasoning.slice(prevReasoning.length)
              if (reasoningDelta) {
                emitFrame({
                  kind: 'stream',
                  session: sid,
                  event: { type: 'reasoning', content: reasoningDelta },
                })
                pendingReasoning.set(sid, split.reasoning)
              }
            } else if (split.reasoning !== prevReasoning) {
              emitFrame({
                kind: 'stream',
                session: sid,
                event: { type: 'reasoning', content: split.reasoning },
              })
              pendingReasoning.set(sid, split.reasoning)
            }
          }
          const prev = pendingAssistant.get(sid) ?? ''
          if (split.text.startsWith(prev)) {
            const delta = split.text.slice(prev.length)
            if (delta) {
              emitFrame({
                kind: 'stream',
                session: sid,
                event: { type: 'text', content: delta },
              })
            }
          } else if (split.text && split.text !== prev) {
            emitFrame({
              kind: 'stream',
              session: sid,
              event: { type: 'text', content: split.text },
            })
          }
          pendingAssistant.set(sid, split.text)
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
          const summarized = summarizeBridgeArgs(
            rawArgs,
            ASK_TOOL_RE.test(toolName) ? ASK_LIMITS : BRIDGE_LIMITS,
          )
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
        case 'turn.end':
        case 'session.end':
          // Commit the accumulated reply as ONE assistant message, then tell
          // clients the turn is over. turn.end (harness Stop hook) is the real
          // boundary — before it existed the flush waited for the NEXT user
          // turn, so RivetHub's live bubble never cleared and its send queue
          // deadlocked after the first streamed reply.
          flushAssistant()
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

/** Ask-tool args are user-facing verbatim: the option label the Hub renders
 *  IS the text sent back as the user's answer, so the generic 200-char cap
 *  would make the user "say" a mangled label. Wider string/depth budget for
 *  the ask shapes only — redaction and the array/key caps stay. */
const ASK_TOOL_RE = /^ask[_-]?user(?:[_-]?question)?$/i
const ASK_ARG_STR_MAX = 2000
const ASK_ARG_DEPTH_MAX = BRIDGE_ARG_DEPTH_MAX + 2

interface BridgeArgLimits {
  strMax: number
  depthMax: number
}
const BRIDGE_LIMITS: BridgeArgLimits = {
  strMax: BRIDGE_ARG_STR_MAX,
  depthMax: BRIDGE_ARG_DEPTH_MAX,
}
const ASK_LIMITS: BridgeArgLimits = { strMax: ASK_ARG_STR_MAX, depthMax: ASK_ARG_DEPTH_MAX }
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

function capStr(s: string, max: number): string {
  const r = redactValuePatterns(s)
  return r.length > max ? r.slice(0, max) + '…' : r
}

/**
 * Cap + redact tool args for the sessions WS (all-subscribers).
 * - secret-ish keys → "[redacted]"
 * - string values run through value-pattern redact then length-capped
 * - nesting to `lim.depthMax` (5 generic, 7 for ask tools), key count 40
 *   (den-hook parity); array cap 20 applies to every tool
 */
function summarizeBridgeArgs(
  raw: unknown,
  lim: BridgeArgLimits = BRIDGE_LIMITS,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as unknown
    } catch {
      return { value: capStr(raw, lim.strMax) }
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined
  return summarizeBridgeValue(obj, 0, lim) as Record<string, unknown>
}

function summarizeBridgeValue(value: unknown, depth: number, lim: BridgeArgLimits): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return capStr(value, lim.strMax)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= lim.depthMax) {
    if (Array.isArray(value)) return `[array:${value.length}]`
    if (typeof value === 'object') return '[omitted]'
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => summarizeBridgeValue(item, depth + 1, lim))
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
      out[key] = summarizeBridgeValue(v, depth + 1, lim)
    }
    return out
  }
  // unknown primitives (bigint/symbol) — don't Object-string them
  return typeof value === 'bigint' ? value.toString() : '[omitted]'
}
