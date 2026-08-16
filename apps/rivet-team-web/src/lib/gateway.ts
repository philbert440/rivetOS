/**
 * The gateway surface rivet-team talks to.
 *
 * Method names, paths, and return types match `@rivetos/gateway-client`
 * RivetGateway for the session + memory subset:
 *   GET  /api/sessions
 *   GET  /api/sessions/:id/messages
 *   POST /api/sessions/:id/messages
 *   WS   /api/sessions/ws
 *   GET  /api/memory/search
 *   GET  /healthz
 *
 * Personas are team-local this slice (user-specific roster, not a gateway
 * resource yet). Household memory and voice are out of scope.
 */

import type {
  GatewayClientConfig,
  MemorySearchResponse,
  Persona,
  SessionMessagesResponse,
  SessionPostAccepted,
  SessionPostRequest,
  SessionsListResponse,
  SessionWsFrame,
  Subscription,
  WatchOptions,
} from './types.js'

export interface TeamGateway {
  readonly config: GatewayClientConfig

  listSessions(signal?: AbortSignal): Promise<SessionsListResponse>
  sessionMessages(sessionId: string, signal?: AbortSignal): Promise<SessionMessagesResponse>
  postMessage(sessionId: string, body: SessionPostRequest): Promise<SessionPostAccepted>
  watchSessions(
    onFrame: (frame: SessionWsFrame) => void,
    sessionId?: string,
    opts?: WatchOptions,
  ): Subscription
  memorySearch(
    query: { q: string; scope?: 'messages' | 'summaries' | 'both'; limit?: number },
    signal?: AbortSignal,
  ): Promise<MemorySearchResponse>
  health(signal?: AbortSignal): Promise<boolean>

  /** Team-local roster. Not on RivetGateway yet. */
  listPersonas(userId: string): Persona[]
}

let current: TeamGateway | undefined

export function setGateway(gateway: TeamGateway): void {
  current = gateway
}

export function getGateway(): TeamGateway {
  if (!current) throw new Error('gateway not installed — call setGateway() at boot')
  return current
}
