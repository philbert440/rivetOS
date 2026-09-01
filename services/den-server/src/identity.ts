/**
 * Edge identity — resolve a den request to a UserContext once, at the TLS
 * terminus. Downstream code receives the context; it does not re-derive.
 */

import type { IncomingMessage } from 'node:http'
import {
  resolveUser,
  TRUSTED_USER_HEADER,
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
  if (ctx && !ctx.isOwner) req.headers[TRUSTED_USER_HEADER] = ctx.userId
}

/** Spawn env for capture. The full users map and admin URLs stay out. */
export function captureEnvFor(ctx: UserContext | undefined): Record<string, string> | undefined {
  if (!ctx || ctx.isOwner) return undefined
  const env: Record<string, string> = { RIVETOS_USER_ID: ctx.userId }
  if (ctx.db.pgUrl) env.RIVETOS_PG_URL = ctx.db.pgUrl
  if (ctx.db.envFile) env.RIVETOS_ENV_FILE = ctx.db.envFile
  return env
}
