/**
 * Per-user memory routing — one node, several humans, separate databases.
 *
 * The node owner's memory stays the plugin's main `PostgresMemory` exactly as
 * before. When the users.json registry maps additional user ids to their own
 * Postgres URLs, `RoutingMemory` fronts the registered Memory slot and
 * delegates each call to the store owned by the user the call belongs to.
 *
 * ONE routing key everywhere: the session-key suffix. Session keys are
 * server-derived (`${channelId}:${userId}` in turn-handler, where userId is
 * den's cert-stamped identity or a trusted platform id) — client-supplied
 * fields never reach it. `getContextForTurn`/`search` take an explicit
 * `userId` option instead, sourced from the same trusted values.
 *
 * Anything that resolves to an unmapped user (including `gateway-user`,
 * platform ids, and the task engine's `task:<id>` namespace) falls through to
 * the main store — unmapped traffic behaves exactly as it did before this
 * module existed.
 */

import type { Memory, MemoryEntry, MemorySearchResult, Message } from '@rivetos/types'
// One shared policy for what a routable user is — den's stamping, this
// plugin's stores, and the claude-cli spawn env must agree (see user-dbs.ts).
export { isUsableUserDb, userDbsFromRegistry } from '@rivetos/types'
export type { UserDbEntry } from '@rivetos/types'

/**
 * Tombstone for a configured user whose store failed to initialize: every
 * call REJECTS. Falling through to the owner store would silently mix the
 * user's traffic into the owner's database — erroring is the privacy-
 * preserving direction (same call as the claude-cli spawn refusal).
 */
export class BlockedMemory implements Memory {
  constructor(private readonly userId: string) {}
  private refuse(): Promise<never> {
    return Promise.reject(
      new Error(`memory for user "${this.userId}" is unavailable (store failed to initialize)`),
    )
  }
  append(): Promise<string> {
    return this.refuse()
  }
  search(): Promise<MemorySearchResult[]> {
    return this.refuse()
  }
  getContextForTurn(): Promise<string> {
    return this.refuse()
  }
  getSessionHistory(): Promise<Message[]> {
    return this.refuse()
  }
  saveSessionSettings(): Promise<void> {
    return this.refuse()
  }
  loadSessionSettings(): Promise<Record<string, unknown> | null> {
    return this.refuse()
  }
}

/** The session-key convention is `${channelId}:${userId}` (turn-handler).
 *  `task:<id>` is the task engine's reserved namespace, never a user key. */
export function userFromSessionKey(sessionId: string): string | undefined {
  if (sessionId.startsWith('task:')) return undefined
  const idx = sessionId.lastIndexOf(':')
  if (idx < 0 || idx === sessionId.length - 1) return undefined
  return sessionId.slice(idx + 1)
}

export class RoutingMemory implements Memory {
  constructor(
    private readonly main: Memory,
    private readonly byUser: Map<string, Memory>,
  ) {}

  private forUser(userId: string | undefined): Memory {
    if (!userId) return this.main
    return this.byUser.get(userId) ?? this.main
  }

  private forSession(sessionId: string): Memory {
    return this.forUser(userFromSessionKey(sessionId))
  }

  append(entry: MemoryEntry): Promise<string> {
    return this.forSession(entry.sessionId).append(entry)
  }

  search(
    query: string,
    options?: {
      agent?: string
      limit?: number
      scope?: 'messages' | 'summaries' | 'both'
      userId?: string
    },
  ): Promise<MemorySearchResult[]> {
    return this.forUser(options?.userId).search(query, options)
  }

  getContextForTurn(
    query: string,
    agent: string,
    options?: { maxTokens?: number; userId?: string },
  ): Promise<string> {
    return this.forUser(options?.userId).getContextForTurn(query, agent, options)
  }

  getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]> {
    return this.forSession(sessionId).getSessionHistory(sessionId, options)
  }

  getTaskHistory(taskId: string, options?: { limit?: number }): Promise<Message[]> {
    // Tasks are node-owner work; user stores never run the task engine.
    return this.main.getTaskHistory?.(taskId, options) ?? Promise.resolve([])
  }

  saveSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    return (
      this.forSession(sessionId).saveSessionSettings?.(sessionId, settings) ?? Promise.resolve()
    )
  }

  loadSessionSettings(sessionId: string): Promise<Record<string, unknown> | null> {
    return this.forSession(sessionId).loadSessionSettings?.(sessionId) ?? Promise.resolve(null)
  }
}
