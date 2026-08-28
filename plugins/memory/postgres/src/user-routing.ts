/**
 * Per-user memory routing — one node, several humans, separate databases.
 *
 * The node owner's memory stays the plugin's main `PostgresMemory` exactly as
 * before. When `RIVETOS_USER_DBS` maps additional user ids to their own
 * Postgres URLs, `RoutingMemory` fronts the registered Memory slot and
 * delegates each call to the store owned by the user the call belongs to:
 *
 *   - `append`      → `entry.metadata.userId`, else the session-key suffix
 *   - session/history methods → the session-key suffix (`channelId:userId`,
 *     see turn-handler's sessionKey)
 *   - `getContextForTurn`     → the explicit `options.userId`
 *
 * Anything that resolves to an unmapped user (including `gateway-user`,
 * `phil`, task sessions `task:<id>`) falls through to the main store —
 * unmapped traffic behaves exactly as it did before this module existed.
 */

import type { Memory, MemoryEntry, MemorySearchResult, Message } from '@rivetos/types'

export interface UserDbEntry {
  pgUrl?: string
  /** Env file handed to spawned harness sessions (den PTY / claude-cli);
   *  carried here so one env var describes a user completely. */
  envFile?: string
}

/** Parse RIVETOS_USER_DBS: {"coco":{"pgUrl":"postgres://…"}}. Malformed input
 *  returns undefined (routing off) rather than throwing at boot. */
export function parseUserDbs(raw: string | undefined): Record<string, UserDbEntry> | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, UserDbEntry>
  } catch {
    /* fall through */
  }
  console.error('[memory-postgres] RIVETOS_USER_DBS is not a JSON object — user routing disabled')
  return undefined
}

/** The session-key convention is `${channelId}:${userId}` (turn-handler). */
export function userFromSessionKey(sessionId: string): string | undefined {
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
    const metaUser =
      typeof entry.metadata?.userId === 'string' ? (entry.metadata.userId as string) : undefined
    return this.forUser(metaUser ?? userFromSessionKey(entry.sessionId)).append(entry)
  }

  search(
    query: string,
    options?: { agent?: string; limit?: number; scope?: 'messages' | 'summaries' | 'both' },
  ): Promise<MemorySearchResult[]> {
    return this.main.search(query, options)
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
    return (
      this.forSession(sessionId).loadSessionSettings?.(sessionId) ?? Promise.resolve(null)
    )
  }
}
