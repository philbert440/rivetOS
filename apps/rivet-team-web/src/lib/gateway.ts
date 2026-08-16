/**
 * The gateway surface rivet-team talks to.
 *
 * Session turn methods keep RivetGateway names (`postMessage`, `watchSessions`)
 * so a later per-user bind can swap the stub. Notes/memory for this app are
 * **not** `GET /api/memory/search` (that is the agent corpus). They go through
 * `/api/team/notes*` keyed by the signed-in user. Household memory and voice
 * stay out of scope.
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
    userId: string,
    query: { q: string; limit?: number },
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
