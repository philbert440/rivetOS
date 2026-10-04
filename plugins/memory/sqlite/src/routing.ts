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

/** How long a blocked user's store is left alone before the open is tried again. */
const BLOCKED_RETRY_MS = 60_000

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

/**
 * Two ids that would land in the same directory on a case-insensitive
 * filesystem, or on one that drops trailing dots, share a folded form.
 */
export function foldUserId(id: string): string {
  return id.toLowerCase().replace(/\.+$/, '')
}

// The methods are async so that a blocked user's refusal is a rejected
// promise, like every other failure of the Memory contract.
export class SqliteRoutingMemory implements Memory {
  private readonly users = new Map<string, SqliteMemory | typeof BLOCKED>()
  private readonly blockedAt = new Map<string, number>()

  /**
   * @param resolve Opens the store of another registry user who has none
   *   yet. Returns it, or `BLOCKED` (also assumed when it returns nothing).
   */
  constructor(
    private readonly main: SqliteMemory,
    users: ReadonlyMap<string, SqliteMemory | typeof BLOCKED>,
    private readonly resolve: (userId: string) => SqliteMemory | typeof BLOCKED | undefined = () =>
      undefined,
    /** Whether an id is another registry user right now. Default: the ids given at construction. */
    private readonly isOther: (userId: string) => boolean = (id) => users.has(id),
  ) {
    for (const [id, store] of users) {
      this.users.set(id, store)
      if (store === BLOCKED) this.blockedAt.set(id, Date.now())
    }
  }

  private lookup(userId: string): SqliteMemory | typeof BLOCKED | undefined {
    // Asked first, every time: an id that is not another registry user (the
    // owner's own ids, and a user who has since become the owner) is the
    // owner's, whatever was remembered about it.
    if (!this.isOther(userId)) {
      if (this.users.get(userId) === BLOCKED) {
        this.users.delete(userId)
        this.blockedAt.delete(userId)
      }
      return undefined
    }
    const known = this.users.get(userId)
    if (known !== undefined && known !== BLOCKED) return known
    // A blocked user stays refused; the open is tried again after a while,
    // so a passing failure does not lock them out until restart.
    if (known === BLOCKED) {
      const since = this.blockedAt.get(userId) ?? 0
      if (Date.now() - since < BLOCKED_RETRY_MS) return BLOCKED
    }
    const found = this.resolve(userId) ?? BLOCKED
    this.users.set(userId, found)
    if (found === BLOCKED) this.blockedAt.set(userId, Date.now())
    else this.blockedAt.delete(userId)
    return found
  }

  /** The store for a user id: theirs if they are another registry user, the owner's otherwise. */
  storeFor(userId: string | undefined): SqliteMemory {
    if (!userId) return this.main
    const store = this.lookup(userId)
    if (store === undefined) return this.main
    if (store === BLOCKED) {
      throw new Error(`memory for user "${userId}" is unavailable on this node`)
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

  async append(entry: MemoryEntry): Promise<string> {
    return this.forSession(entry.sessionId).append(entry)
  }

  async search(
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

  async getContextForTurn(
    query: string,
    agent: string,
    options?: { maxTokens?: number; userId?: string },
  ): Promise<string> {
    return this.storeFor(options?.userId).getContextForTurn(query, agent, options)
  }

  async getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]> {
    return this.forSession(sessionId).getSessionHistory(sessionId, options)
  }

  getTaskHistory(taskId: string, options?: { limit?: number }): Promise<Message[]> {
    // Tasks are the node owner's work; user stores never run the task engine.
    return this.main.getTaskHistory(taskId, options)
  }

  async saveSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    return this.forSession(sessionId).saveSessionSettings(sessionId, settings)
  }

  async loadSessionSettings(sessionId: string): Promise<Record<string, unknown> | null> {
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
    const store = this.lookup(userId)
    return store === undefined || store === BLOCKED ? null : store.backend()
  }
}
