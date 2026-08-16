/**
 * Wire + team-domain types.
 *
 * Session / memory / gateway-config shapes are the public contract from
 * `@rivetos/types` `gateway-api.ts` (and the Memory plugin surface). This
 * slice inlines the subset rivet-team uses so the app runs standalone
 * before it is dropped into the rivetOS workspace. Do not drift method
 * names or field names — a later slice swaps the stub for
 * `new RivetGateway({ baseUrl })`.
 */

export type GatewayAuthMode = 'none' | 'mtls'

export interface GatewayClientConfig {
  /** Origin of the node's gateway, e.g. `https://192.0.2.112:5174`. */
  baseUrl: string
  token?: never
  authMode?: GatewayAuthMode
}

export interface SessionSummary {
  id: string
  lastActive: number
  messages: number
}

export interface SessionsListResponse {
  sessions: SessionSummary[]
}

export interface SessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  ts: number
}

export interface SessionMessagesResponse {
  messages: SessionMessage[]
}

export interface SessionPostRequest {
  text: string
  userId?: string
  agent?: string
}

export interface SessionPostAccepted {
  accepted: true
  session: string
}

export interface StreamEvent {
  type: 'text' | 'reasoning' | 'tool_start' | 'tool_result' | 'status' | 'interrupt' | 'done' | 'error'
  content: string
  metadata?: Record<string, unknown>
}

export type SessionWsFrame =
  | ({ kind: 'message' } & SessionMessage)
  | { kind: 'stream'; session: string; event: StreamEvent }
  | { kind: 'sessions-dirty' }

export interface MemorySearchHit {
  id: string
  content: string
  role: string
  agent: string
  score: number
  createdAt: number
}

export interface MemorySearchResponse {
  hits: MemorySearchHit[]
}

export interface Subscription {
  close(): void
  send(data: unknown): boolean
}

export type WsStatus = 'connecting' | 'open' | 'closed'

export interface WatchOptions {
  onStatus?: (status: WsStatus) => void
}

/** User-specific persona: name + system prompt + exactly one thread + node. */
export interface Persona {
  id: string
  name: string
  systemPrompt: string
  /** Gateway session id — one thread per persona. */
  threadId: string
  nodeId: string
  /** Seeded demo persona (not user-created). */
  sample?: boolean
}

/** Local stream card/chip (working indicator, later tool cards). */
export interface StreamCard {
  id: string
  kind: 'working' | 'info'
  label: string
}

/** Team-tagged message sitting on top of the gateway SessionMessage. */
export interface TeamMessage extends SessionMessage {
  userId: string
  personaId: string
  nodeId: string
  cards?: StreamCard[]
}

export const LOCAL_USER_ID = 'local-user'
export const LOCAL_NODE_ID = 'local-node'
