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
  DevicesListResponse,
  DeviceOpenResponse,
  WorkflowsListResponse,
  WorkflowDefSummary,
  WorkflowRunsListResponse,
  WorkflowRunDetailResponse,
  WorkflowStartRunRequest,
  WorkflowStartRunResponse,
  WorkflowResumeRequest,
  WorkflowResumeResponse,
  WorkflowKillResponse,
  WorkflowValidateResponse,
  FilesUploadResponse,
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
  AudioMicStatus,
  AudioMicHealth,
} from '@rivetos/types'
import type { DenSessionsResponse, FilesListResponse, FilesMutateResponse } from '@rivetos/types'
import { GatewayError, request, type QueryValue } from './http.js'
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

  // -- workflows (v1 slice C) ------------------------------------------------

  listWorkflows(signal?: AbortSignal): Promise<WorkflowsListResponse> {
    return request(this.config, '/api/workflows', { signal })
  }

  getWorkflow(workflowId: string, signal?: AbortSignal): Promise<{ workflow: WorkflowDefSummary }> {
    return request(this.config, `/api/workflows/${encodeURIComponent(workflowId)}`, { signal })
  }

  /**
   * Validate a workflow def on disk (manifest schema, agent frontmatter,
   * empty-prompt checks + run.ts determinism lint). Does not mutate files.
   */
  validateWorkflow(workflowId: string, signal?: AbortSignal): Promise<WorkflowValidateResponse> {
    return request(this.config, `/api/workflows/${encodeURIComponent(workflowId)}/validate`, {
      method: 'POST',
      body: {},
      signal,
    })
  }

  startWorkflowRun(
    workflowId: string,
    body: WorkflowStartRunRequest = {},
    opts: { wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<WorkflowStartRunResponse> {
    return request(this.config, `/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: 'POST',
      body,
      query: opts.wait ? { wait: 'true' } : undefined,
      signal: opts.signal,
    })
  }

  listWorkflowRuns(
    query: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<WorkflowRunsListResponse> {
    return request(this.config, '/api/workflow-runs', {
      query: query,
      signal,
    })
  }

  getWorkflowRun(runId: string, signal?: AbortSignal): Promise<WorkflowRunDetailResponse> {
    return request(this.config, `/api/workflow-runs/${encodeURIComponent(runId)}`, { signal })
  }

  resumeWorkflowRun(
    runId: string,
    body: WorkflowResumeRequest,
    opts: { wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<WorkflowResumeResponse> {
    return request(this.config, `/api/workflow-runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      body,
      query: opts.wait ? { wait: 'true' } : undefined,
      signal: opts.signal,
    })
  }

  killWorkflowRun(runId: string, signal?: AbortSignal): Promise<WorkflowKillResponse> {
    return request(this.config, `/api/workflow-runs/${encodeURIComponent(runId)}/kill`, {
      method: 'POST',
      signal,
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

  // -- mesh devices (Settings → Devices) --------------------------------------

  devicesList(signal?: AbortSignal): Promise<DevicesListResponse> {
    return request(this.config, '/api/devices', { signal })
  }

  deviceAdd(name: string, signal?: AbortSignal): Promise<DeviceOpenResponse> {
    return request(this.config, '/api/devices', {
      method: 'POST',
      body: { name },
      signal,
    })
  }

  deviceRevoke(id: string, signal?: AbortSignal): Promise<{ ok: true }> {
    return request(this.config, `/api/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
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

  /** Live den session roster from the node's event reducer (sidebar Den
   *  list) — every session that has emitted den events, recency-ordered. */
  denSessions(signal?: AbortSignal): Promise<DenSessionsResponse> {
    return request(this.config, '/api/events/sessions', { signal })
  }

  // -- audio MicBridge (host mic → virtual node input; docs/MICBRIDGE.md) ----

  /** MicBridge status (armed, fifo, sample rate). Requires RIVETOS_DEN_AUDIO=1. */
  audioStatus(signal?: AbortSignal): Promise<AudioMicStatus> {
    return request(this.config, '/api/audio', { signal })
  }

  audioHealth(signal?: AbortSignal): Promise<AudioMicHealth> {
    return request(this.config, '/api/audio/health', { signal })
  }

  /**
   * Attach URL for WS /api/audio/mic — binary s16le PCM after a JSON hello.
   * Caller opens the socket (same pattern as terminalWsUrl).
   */
  audioMicWsUrl(): string {
    const u = new URL(
      '/api/audio/mic',
      this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`,
    )
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    if (this.config.token) u.searchParams.set('token', this.config.token)
    return u.toString()
  }

  // -- files (shared filestore, fenced to the node's files root) --------------

  filesList(path: string, signal?: AbortSignal): Promise<FilesListResponse> {
    return request(this.config, '/api/files/list', { query: { path }, signal })
  }

  /** Browser download/open URL for one file. Token rides ?token= (same
   *  pattern as terminalWsUrl — an <a href>/window.open can't carry a
   *  bearer header). */
  fileDownloadUrl(path: string): string {
    const u = new URL(
      '/api/files/download',
      this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`,
    )
    u.searchParams.set('path', path)
    if (this.config.token) u.searchParams.set('token', this.config.token)
    return u.toString()
  }

  /**
   * Read a text file under the files root via GET /api/files/download.
   * Uses the same fence as the browser download URL; throws GatewayError on
   * non-2xx (including 403 escape / 404 missing).
   */
  async filesReadText(path: string, signal?: AbortSignal): Promise<string> {
    const url = this.fileDownloadUrl(path)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: this.config.token ? { authorization: `Bearer ${this.config.token}` } : undefined,
        signal,
      })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new GatewayError(0, `gateway unreachable: ${msg}`, undefined)
    }
    if (!res.ok) {
      const body: unknown = await res
        .clone()
        .json()
        .catch(() => res.text().catch(() => undefined))
      const message =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `gateway ${res.status} on /api/files/download`
      throw new GatewayError(res.status, message, body)
    }
    return res.text()
  }

  /**
   * Save text/bytes to an existing or new path under the files root via
   * upload+overwrite. Splits the root-relative path into dir + name.
   */
  async filesSave(
    path: string,
    body: string | Blob | ArrayBuffer,
    opts: { signal?: AbortSignal } = {},
  ): Promise<FilesUploadResponse> {
    const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
    const slash = trimmed.lastIndexOf('/')
    const dir = slash < 0 ? '' : trimmed.slice(0, slash)
    const name = slash < 0 ? trimmed : trimmed.slice(slash + 1)
    if (!name) throw new GatewayError(400, 'filesSave: empty file name', undefined)
    const blob =
      typeof body === 'string' ? new Blob([body], { type: 'text/plain;charset=utf-8' }) : body
    return this.filesUpload(dir, name, blob, { overwrite: true, signal: opts.signal })
  }

  /** Upload raw bytes as `<dir>/<name>` under the files root. No-clobber by
   *  default; pass overwrite to replace. Bypasses request(): the body is
   *  binary, not JSON. */
  async filesUpload(
    dir: string,
    name: string,
    body: Blob | ArrayBuffer,
    opts: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<FilesUploadResponse> {
    const u = new URL(
      '/api/files/upload',
      this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`,
    )
    u.searchParams.set('dir', dir)
    u.searchParams.set('name', name)
    if (opts.overwrite) u.searchParams.set('overwrite', '1')
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`
    let res: Response
    try {
      res = await fetch(u.toString(), {
        method: 'POST',
        headers,
        body,
        signal: opts.signal,
      })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new GatewayError(0, `gateway unreachable: ${msg}`, undefined)
    }
    const parsed: unknown = await res.json().catch(() => undefined)
    if (!res.ok) {
      const message =
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `gateway ${res.status} on /api/files/upload`
      throw new GatewayError(res.status, message, parsed)
    }
    return parsed as FilesUploadResponse
  }

  /** Create an empty directory under `dir` named `name`. */
  filesMkdir(dir: string, name: string, signal?: AbortSignal): Promise<FilesMutateResponse> {
    return request(this.config, '/api/files/mkdir', {
      method: 'POST',
      query: { dir, name },
      signal,
    })
  }

  /** Rename or move within the files root (`from` / `to` are root-relative). */
  filesRename(from: string, to: string, signal?: AbortSignal): Promise<FilesMutateResponse> {
    return request(this.config, '/api/files/rename', {
      method: 'POST',
      query: { from, to },
      signal,
    })
  }

  /** Delete a file or directory. Non-empty dirs need `recursive: true`. */
  filesDelete(
    path: string,
    opts: { recursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<FilesMutateResponse> {
    return request(this.config, '/api/files/delete', {
      method: 'DELETE',
      query: { path, recursive: opts.recursive ? 1 : undefined },
      signal: opts.signal,
    })
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
