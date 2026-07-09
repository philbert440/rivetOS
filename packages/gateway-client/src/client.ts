/**
 * RivetGateway — the typed client over a node's gateway API. This package is
 * the ONLY bridge RivetHub clients (web, desktop, android-via-docs) may use;
 * nothing here imports runtime packages, and every shape comes verbatim from
 * @rivetos/types gateway-api.ts / wiki.ts.
 */

import type {
  CatalogAgentsResponse,
  CatalogSheet,
  GatewayClientConfig,
  MeshOverview,
  NotificationFrame,
  OutcomesResponse,
  SessionMessagesResponse,
  SessionPostAccepted,
  SessionPostReply,
  SessionPostRequest,
  SessionsListResponse,
  SessionWsFrame,
  TaskCreateRequest,
  TaskKillResponse,
  TaskResponse,
  TasksListResponse,
  TaskStatus,
  TaskSteerAccepted,
  WikiGapsResponse,
  WikiIndexResponse,
  WikiPageResponse,
} from '@rivetos/types'
import type {
  TermConfigResponse,
  HarnessSessionsResponse,
  HarnessTranscriptResponse,
  TermInjectRequest,
  TermInjectResponse,
  TermListResponse,
  TermSpawnRequest,
  TermSpawnResponse,
} from '@rivetos/types'
import { request, type QueryValue } from './http.js'
import {
  subscribe,
  type Subscription,
  type SubscriptionOptions,
  type WebSocketFactory,
} from './ws.js'

export interface WaitOptions {
  /** Long-poll for the terminal row / assistant reply. */
  wait?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface TaskListQuery {
  status?: TaskStatus
  agentId?: string
  limit?: number
}

export interface OutcomesQuery {
  /** epoch ms or a date string the server can Date.parse. */
  since?: string | number
  until?: string | number
  agentId?: string
  origin?: string
}

export interface WikiIndexQuery {
  q?: string
  tag?: string
  entity?: string
  limit?: number
  offset?: number
}

export interface WatchOptions {
  onStatus?: SubscriptionOptions<never>['onStatus']
  /** Test seam / non-platform environments. */
  factory?: WebSocketFactory
}

export class RivetGateway {
  readonly config: GatewayClientConfig

  constructor(config: GatewayClientConfig) {
    this.config = config
  }

  // -- sessions -------------------------------------------------------------

  listSessions(signal?: AbortSignal): Promise<SessionsListResponse> {
    return request(this.config, '/api/sessions', { signal })
  }

  sessionMessages(sessionId: string, signal?: AbortSignal): Promise<SessionMessagesResponse> {
    return request(this.config, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      signal,
    })
  }

  /** Durable backfill for a harness conversation (seamless modes): the
   *  committed transcript from memory, for a cold/reconnecting client. Live
   *  frames then arrive on the sessions WS. */
  conversationMessages(key: string, signal?: AbortSignal): Promise<SessionMessagesResponse> {
    return request(this.config, `/api/conversations/${encodeURIComponent(key)}/messages`, {
      signal,
    })
  }

  /** Fire-and-forget turn; replies arrive on the sessions WS. */
  postMessage(sessionId: string, body: SessionPostRequest): Promise<SessionPostAccepted> {
    return request(this.config, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body,
    })
  }

  /** Long-poll variant: blocks until the assistant reply (or 504s). */
  postMessageAndWait(
    sessionId: string,
    body: SessionPostRequest,
    opts: Omit<WaitOptions, 'wait'> = {},
  ): Promise<SessionPostReply> {
    return request(this.config, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body,
      query: { wait: 1, timeoutMs: opts.timeoutMs },
      signal: opts.signal,
    })
  }

  /** Live message/stream frames; omit sessionId to watch every session. */
  watchSessions(
    onFrame: (frame: SessionWsFrame) => void,
    sessionId?: string,
    opts: WatchOptions = {},
  ): Subscription {
    return subscribe<SessionWsFrame>(this.config, {
      path: '/api/sessions/ws',
      query: { session: sessionId },
      onFrame,
      onStatus: opts.onStatus,
      factory: opts.factory,
    })
  }

  // -- tasks ----------------------------------------------------------------

  createTask(body: TaskCreateRequest, opts: WaitOptions = {}): Promise<TaskResponse> {
    return request(this.config, '/api/tasks', {
      method: 'POST',
      body,
      query: opts.wait ? { wait: 1, timeoutMs: opts.timeoutMs } : undefined,
      signal: opts.signal,
    })
  }

  listTasks(query: TaskListQuery = {}, signal?: AbortSignal): Promise<TasksListResponse> {
    return request(this.config, '/api/tasks', {
      query: query as Record<string, QueryValue>,
      signal,
    })
  }

  getTask(taskId: string, signal?: AbortSignal): Promise<TaskResponse> {
    return request(this.config, `/api/tasks/${encodeURIComponent(taskId)}`, { signal })
  }

  waitTask(taskId: string, opts: Omit<WaitOptions, 'wait'> = {}): Promise<TaskResponse> {
    return request(this.config, `/api/tasks/${encodeURIComponent(taskId)}/wait`, {
      query: { timeoutMs: opts.timeoutMs },
      signal: opts.signal,
    })
  }

  steerTask(taskId: string, message: string): Promise<TaskSteerAccepted> {
    return request(this.config, `/api/tasks/${encodeURIComponent(taskId)}/steer`, {
      method: 'POST',
      body: { message },
    })
  }

  killTask(taskId: string): Promise<TaskKillResponse> {
    return request(this.config, `/api/tasks/${encodeURIComponent(taskId)}/kill`, {
      method: 'POST',
    })
  }

  // -- catalog / outcomes / mesh ---------------------------------------------

  catalog(signal?: AbortSignal): Promise<CatalogSheet> {
    return request(this.config, '/api/catalog', { signal })
  }

  catalogAgents(signal?: AbortSignal): Promise<CatalogAgentsResponse> {
    return request(this.config, '/api/catalog/agents', { signal })
  }

  outcomes(query: OutcomesQuery = {}, signal?: AbortSignal): Promise<OutcomesResponse> {
    return request(this.config, '/api/outcomes', {
      query: query as Record<string, QueryValue>,
      signal,
    })
  }

  meshOverview(signal?: AbortSignal): Promise<MeshOverview> {
    return request(this.config, '/api/mesh', { signal })
  }

  // -- wiki -------------------------------------------------------------------

  wikiIndex(query: WikiIndexQuery = {}, signal?: AbortSignal): Promise<WikiIndexResponse> {
    return request(this.config, '/api/wiki', {
      query: query as Record<string, QueryValue>,
      signal,
    })
  }

  wikiGaps(limit?: number, signal?: AbortSignal): Promise<WikiGapsResponse> {
    return request(this.config, '/api/wiki/_gaps', { query: { limit }, signal })
  }

  wikiPage(slug: string, signal?: AbortSignal): Promise<WikiPageResponse> {
    return request(this.config, `/api/wiki/${encodeURIComponent(slug)}`, { signal })
  }

  wikiRaw(slug: string, signal?: AbortSignal): Promise<string> {
    return request(this.config, `/api/wiki/${encodeURIComponent(slug)}/raw`, {
      raw: true,
      signal,
    })
  }

  // -- terminal (den PTY surface via the /api/terminal aliases) ---------------

  termConfig(signal?: AbortSignal): Promise<TermConfigResponse> {
    return request(this.config, '/api/terminal/config', { signal })
  }

  termList(signal?: AbortSignal): Promise<TermListResponse> {
    return request(this.config, '/api/terminal/list', { signal })
  }

  /** The node's harness sessions, read from their on-disk stores (seamless
   *  drawer) — node+harness specific by construction. Open one by spawning
   *  with { session, resume: <id> }. */
  harnessSessions(signal?: AbortSignal): Promise<HarnessSessionsResponse> {
    return request(this.config, '/api/terminal/harness-sessions', { signal })
  }

  /** On-disk harness transcript for hard-resync of the chat UI from TUI state. */
  harnessTranscript(sessionId: string, signal?: AbortSignal): Promise<HarnessTranscriptResponse> {
    return request(
      this.config,
      `/api/terminal/harness-sessions/${encodeURIComponent(sessionId)}/transcript`,
      { signal },
    )
  }

  termSpawn(body: TermSpawnRequest = {}): Promise<TermSpawnResponse> {
    return request(this.config, '/api/terminal', { method: 'POST', body })
  }

  termKill(ptyId: string): Promise<{ ok: true }> {
    return request(this.config, '/api/terminal', {
      method: 'DELETE',
      query: { id: ptyId },
    })
  }

  /** Inject a chat turn into a conversation's live harness stdin (seamless
   *  modes) — requires a PTY already spawned for the session. */
  termInject(body: TermInjectRequest): Promise<TermInjectResponse> {
    return request(this.config, '/api/terminal/inject', { method: 'POST', body })
  }

  /**
   * Attach URL for WS /api/terminal/ws (binary protocol — hello JSON frame,
   * then scrollback/live bytes; see den-server term/ws.ts). The caller opens
   * the socket itself (xterm needs raw binary; the subscribe() helper is
   * JSON-frame-only). Token rides ?token= like every gateway WS.
   */
  terminalWsUrl(attach: { id?: string; session?: string }): string {
    const u = new URL(
      '/api/terminal/ws',
      this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`,
    )
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    if (attach.id) u.searchParams.set('id', attach.id)
    if (attach.session) u.searchParams.set('session', attach.session)
    if (this.config.token) u.searchParams.set('token', this.config.token)
    return u.toString()
  }

  // -- notifications (4e — server route lands with the escalation WS) --------

  watchNotifications(
    onFrame: (frame: NotificationFrame) => void,
    opts: WatchOptions = {},
  ): Subscription {
    return subscribe<NotificationFrame>(this.config, {
      path: '/api/notifications/ws',
      onFrame,
      onStatus: opts.onStatus,
      factory: opts.factory,
    })
  }

  // -- health -----------------------------------------------------------------

  /** Cheap reachability probe (den-server /healthz, never token-gated) —
   *  sent tokenless so the credential never rides a probe. */
  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      await request({ baseUrl: this.config.baseUrl }, '/healthz', { signal })
      return true
    } catch {
      return false
    }
  }
}
