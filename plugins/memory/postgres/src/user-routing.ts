/**
 * Per-user memory routing — one node, several humans, separate databases.
 *
 * The node owner's memory stays the plugin's main `PostgresMemory` exactly as
 * before. When `RIVETOS_USER_DBS` maps additional user ids to their own
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

export interface UserDbEntry {
  pgUrl?: string
  /** Env file handed to spawned harness sessions (den PTY / claude-cli);
   *  carried here so one env var describes a user completely. */
  envFile?: string
}

/** A usable target has at least one non-empty string field. */
export function isUsableUserDb(entry: unknown): entry is UserDbEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const e = entry as Record<string, unknown>
  const okString = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
  if ('pgUrl' in e && e.pgUrl !== undefined && !okString(e.pgUrl)) return false
  if ('envFile' in e && e.envFile !== undefined && !okString(e.envFile)) return false
  return okString(e.pgUrl) || okString(e.envFile)
}

/** Parse RIVETOS_USER_DBS: {"coco":{"pgUrl":"postgres://…"}}. Entries that
 *  fail shape validation are dropped with a warning; a malformed document
 *  returns undefined (routing off) rather than throwing at boot. */
export function parseUserDbs(raw: string | undefined): Record<string, UserDbEntry> | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    console.error('[memory-postgres] RIVETOS_USER_DBS is not valid JSON — user routing disabled')
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[memory-postgres] RIVETOS_USER_DBS is not a JSON object — user routing disabled')
    return undefined
  }
  const out: Record<string, UserDbEntry> = {}
  for (const [userId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (userId.trim() === '') continue
    if (!isUsableUserDb(entry)) {
      console.error(`[memory-postgres] RIVETOS_USER_DBS entry for "${userId}" is unusable — dropped`)
      continue
    }
    out[userId] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
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
    return (
      this.forSession(sessionId).loadSessionSettings?.(sessionId) ?? Promise.resolve(null)
    )
  }
}
