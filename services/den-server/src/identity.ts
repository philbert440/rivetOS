/**
 * Edge identity — resolve a den request to a UserContext once, at the TLS
 * terminus. Downstream code receives the context; it does not re-derive.
 */

import type { IncomingMessage } from 'node:http'
import {
  mintUserToken,
  resolveUser,
  resolveUserById,
  TRUSTED_USER_HEADER,
  USER_TOKEN_ENV,
  USER_TOKEN_HEADER,
  userForToken,
  type ResolveUserResult,
  type UserContext,
  type UsersRegistry,
} from '@rivetos/types'
import { clientDevice, isLoopbackRemote } from './auth.js'

export type { UserContext }

const bound = new WeakMap<IncomingMessage, UserContext>()

export function bindRequestUser(req: IncomingMessage, ctx: UserContext): void {
  bound.set(req, ctx)
}

export function boundRequestUser(req: IncomingMessage): UserContext | undefined {
  return bound.get(req)
}

/** Loopback → owner. Remote without a device cert → refuse. Otherwise registry. */
export function resolveRequestUser(
  registry: UsersRegistry,
  req: IncomingMessage,
): ResolveUserResult {
  // A session this node spawned for another user says so with its token.
  // Presenting one is a claim to be that user: a token that is unknown (the
  // node restarted, or it was never minted) is refused, not served as the
  // owner, and one from off this machine is refused whatever it is.
  const token = req.headers[USER_TOKEN_HEADER]
  if (token !== undefined) {
    if (typeof token !== 'string') return { ok: false, error: 'malformed user token' }
    if (!isLoopbackRemote(req)) {
      return { ok: false, error: 'a user token is accepted from this machine only' }
    }
    const userId = userForToken(token)
    if (!userId) return { ok: false, error: 'unknown user token' }
    return resolveUserById(registry, userId)
  }
  if (isLoopbackRemote(req)) return resolveUser(registry, null)
  const dev = clientDevice(req)
  if (!dev) return { ok: false, error: 'no device identity on request' }
  return resolveUser(registry, dev.deviceId)
}

export { TRUSTED_USER_HEADER }

/** Stamp the trusted header for a non-owner. Owner keeps today's no-header path
 *  so unmapped main-store traffic is unchanged. Always strip inbound first. */
export function stampUserHeader(req: IncomingMessage, ctx: UserContext | undefined): void {
  // literal key (no-dynamic-delete); must stay equal to TRUSTED_USER_HEADER
  delete req.headers['x-rivetos-user']
  // The token has done its work; no route or mount needs to see it.
  delete req.headers['x-rivetos-user-token']
  if (ctx && !ctx.isOwner) req.headers[TRUSTED_USER_HEADER] = ctx.userId
}

/** Spawn env for capture. The full users map and admin URLs stay out. */
export function captureEnvFor(ctx: UserContext | undefined): Record<string, string> | undefined {
  if (!ctx || ctx.isOwner) return undefined
  const env: Record<string, string> = { RIVETOS_USER_ID: ctx.userId }
  if (ctx.db.pgUrl) env.RIVETOS_PG_URL = ctx.db.pgUrl
  // No database of their own: the user's store is this node's, reached
  // through the den with a token that says whose session it is.
  else env[USER_TOKEN_ENV] = mintUserToken(ctx.userId)
  if (ctx.db.envFile) env.RIVETOS_ENV_FILE = ctx.db.envFile
  return env
}
