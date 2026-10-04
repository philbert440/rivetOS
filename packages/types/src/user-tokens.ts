/**
 * Per-user tokens for sessions the node spawns on its own machine.
 *
 * A request from loopback is the node owner's. A session spawned for another
 * registry user (a CLI turn, a terminal) runs on the same machine, so its
 * capture hooks and memory tools also arrive from loopback. On a node whose
 * users each have a database, such a session is given that database's URL and
 * never talks to the den. On a node with file stores there is no URL to give:
 * the session is handed a token instead, sends it to the den, and the den
 * serves the request as the user the token was minted for.
 *
 * Tokens live in this process's memory only. They are minted on demand, one
 * per user, and are gone when the node stops: a session that outlives the
 * node is refused (never served as the owner) until it is spawned again.
 */

import { createHash, randomBytes } from 'node:crypto'

/** The request header a spawned session sends the den. Stripped before any route sees it. */
export const USER_TOKEN_HEADER = 'x-rivetos-user-token'
/** The environment variable a spawned session finds its token in. */
export const USER_TOKEN_ENV = 'RIVETOS_USER_TOKEN'

interface TokenStore {
  byUser: Map<string, string>
  /** sha256(token) → user id. Looked up by digest, so no token is compared byte by byte. */
  byDigest: Map<string, string>
}

// One store per process, whichever copy of this module is loaded.
const STORE_KEY = Symbol.for('rivetos.userTokens')

function store(): TokenStore {
  const holder = globalThis as unknown as Record<symbol, TokenStore | undefined>
  holder[STORE_KEY] ??= { byUser: new Map(), byDigest: new Map() }
  return holder[STORE_KEY]
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The token for this user, minted the first time it is asked for. */
export function mintUserToken(userId: string): string {
  const s = store()
  const existing = s.byUser.get(userId)
  if (existing) return existing
  // The id rides in front so a session can tell whose token it holds (its
  // capture spool is named from it); the secret is the part after the dot.
  const token = `${Buffer.from(userId, 'utf8').toString('base64url')}.${randomBytes(32).toString('base64url')}`
  s.byUser.set(userId, token)
  s.byDigest.set(digest(token), userId)
  return token
}

/** The user a token was minted for, or undefined. */
export function userForToken(token: string): string | undefined {
  if (token.length < 16 || token.length > 512) return undefined
  return store().byDigest.get(digest(token))
}

/** For tests. */
export function clearUserTokens(): void {
  const s = store()
  s.byUser.clear()
  s.byDigest.clear()
}
