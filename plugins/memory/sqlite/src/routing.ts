/**
 * Per-user memory on SQLite: one file per user. The node owner's store takes
 * everything that is not another registry user's; each other user in the
 * users registry gets a file of their own, and is never served from (or
 * written into) anyone else's. Same routing rule as the Postgres backend:
 * a turn's `userId`, or the user part of a `<channel>:<user>` session key.
 */

import type {
  Memory,
  MemoryBackend,
  MemoryEntry,
  MemorySearchResult,
  Message,
} from '@rivetos/types'
import type { SqliteMemory } from './adapter.js'

/** A user whose store could not be opened: refused, never sent to the owner's. */
export const BLOCKED = Symbol('blocked user store')

/** `<channel>:<user>`; `task:<id>` is the task engine's and never a user's. */
export function userFromSessionKey(sessionId: string): string | undefined {
  if (sessionId.startsWith('task:')) return undefined
  const at = sessionId.lastIndexOf(':')
  if (at < 0 || at === sessionId.length - 1) return undefined
  return sessionId.slice(at + 1)
}

/** A user id that is safe as a directory name. */
export function isSafeUserId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) && !id.includes('..')
}

export class SqliteRoutingMemory implements Memory {
  constructor(
    private readonly main: SqliteMemory,
    private readonly users: ReadonlyMap<string, SqliteMemory | typeof BLOCKED>,
  ) {}

  /** The store for a user id: theirs if they have one, the owner's otherwise. */
  storeFor(userId: string | undefined): SqliteMemory {
    if (!userId) return this.main
    const store = this.users.get(userId)
    if (store === undefined) return this.main
    if (store === BLOCKED) {
      throw new Error(`memory for user "${userId}" is unavailable (store failed to open)`)
    }
    return store
  }

  private forSession(sessionId: string): SqliteMemory {
    return this.storeFor(userFromSessionKey(sessionId))
  }

  /** The owner's store and every user store that opened. */
  stores(): SqliteMemory[] {
    const out = [this.main]
    for (const store of this.users.values()) if (store !== BLOCKED) out.push(store)
    return out
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
    return this.storeFor(options?.userId).search(query, options)
  }

  getContextForTurn(
    query: string,
    agent: string,
    options?: { maxTokens?: number; userId?: string },
  ): Promise<string> {
    return this.storeFor(options?.userId).getContextForTurn(query, agent, options)
  }

  getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]> {
    return this.forSession(sessionId).getSessionHistory(sessionId, options)
  }

  getTaskHistory(taskId: string, options?: { limit?: number }): Promise<Message[]> {
    // Tasks are the node owner's work; user stores never run the task engine.
    return this.main.getTaskHistory(taskId, options)
  }

  saveSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    return this.forSession(sessionId).saveSessionSettings(sessionId, settings)
  }

  loadSessionSettings(sessionId: string): Promise<Record<string, unknown> | null> {
    return this.forSession(sessionId).loadSessionSettings(sessionId)
  }

  /** Stop every store's job loop. */
  async stopWorkers(): Promise<void> {
    for (const store of this.stores()) await store.stopWorkers()
  }

  /** Close every store. */
  close(): void {
    for (const store of this.stores()) store.close()
  }

  /** The owner's backend (requests den left unstamped). */
  backend(): MemoryBackend {
    return this.main.backend()
  }

  /**
   * The backend for a den-stamped user: their own store. Null for a user
   * with no store here (unknown, or one that failed to open): the routes
   * refuse them. Never the owner's.
   */
  backendForUser(userId: string): MemoryBackend | null {
    const store = this.users.get(userId)
    return store === undefined || store === BLOCKED ? null : store.backend()
  }
}
