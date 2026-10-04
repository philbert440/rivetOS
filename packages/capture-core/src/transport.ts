import { resolveDenUrl } from './den-url.js'

/**
 * Which backend a short-lived capture hook writes to.
 *
 * `den` posts to the node's own den and opens no Postgres connection.
 * `pg` is the direct pool, kept for one release. A present
 * `RIVETOS_USER_ID` (any value except unset or `''`, including whitespace)
 * selects `den` only together with `RIVETOS_USER_TOKEN`: loopback callers
 * are the owner, so a routed user without the token the node minted for
 * them would write the wrong store. That holds even when transport is
 * forced to `den`. With the token, the den serves the request as that user.
 *
 * For an https den, `rivetos_resolve_den` unsets `RIVET_DEN_URL` when the CA
 * file is missing but still exports `RIVET_DEN_CA`. That pair means the
 * launcher disabled den; do not let `resolveDenUrl`'s default port override
 * it. A plain-http den needs no CA, so its URL is kept (with `RIVET_DEN_CA`
 * still exported) and this pair never forms.
 */

export interface CaptureUser {
  id: string
  token: string
}

export type CaptureTransport =
  /** `warnings` — one line per `RIVET_DEN_URL` guard that fired (see `guardDenUrl`); callers log them. */
  /** `user` — the routed user this session was spawned for, and the token that proves it to the den. */
  | { kind: 'den'; denUrl: string; warnings?: string[]; user?: CaptureUser }
  | { kind: 'pg'; pgUrl: string }
  | { kind: 'none'; reason: string }

const USER_BLOCKS_DEN =
  'RIVETOS_USER_ID is set — den transport would hit the owner pool on loopback — and RIVETOS_PG_URL is not set'

function trimmed(value: string | undefined): string {
  return value?.trim() ?? ''
}

export function resolveCaptureTransport(
  env: NodeJS.ProcessEnv,
  readConfig?: () => string | undefined,
): CaptureTransport {
  const forced = trimmed(env.RIVETOS_CAPTURE_TRANSPORT)
  const launcherDisabledDen =
    trimmed(env.RIVET_DEN_URL).length === 0 && trimmed(env.RIVET_DEN_CA).length > 0
  const resolved = launcherDisabledDen ? undefined : resolveDenUrl(env, readConfig)
  const denUrl = resolved?.denUrl
  const routedUser = env.RIVETOS_USER_ID !== undefined && env.RIVETOS_USER_ID !== ''
  const userToken = routedUser ? trimmed(env.RIVETOS_USER_TOKEN) : ''
  const den = (url: string): CaptureTransport => ({
    kind: 'den',
    denUrl: url,
    ...(resolved?.warnings ? { warnings: resolved.warnings } : {}),
    ...(userToken ? { user: { id: env.RIVETOS_USER_ID as string, token: userToken } } : {}),
  })
  const pgUrl = trimmed(env.RIVETOS_PG_URL)
  const userBlocksDen = routedUser && userToken === ''

  if (forced === 'den') {
    if (!denUrl) {
      return {
        kind: 'none',
        reason: 'RIVETOS_CAPTURE_TRANSPORT=den but RIVET_DEN_URL is not set',
      }
    }
    if (userBlocksDen) {
      if (pgUrl) return { kind: 'pg', pgUrl }
      return { kind: 'none', reason: USER_BLOCKS_DEN }
    }
    return den(denUrl)
  }

  if (forced === 'pg') {
    if (!pgUrl) {
      return { kind: 'none', reason: 'RIVETOS_CAPTURE_TRANSPORT=pg but RIVETOS_PG_URL is not set' }
    }
    return { kind: 'pg', pgUrl }
  }

  if (denUrl && !userBlocksDen) return den(denUrl)
  if (pgUrl) return { kind: 'pg', pgUrl }
  if (userBlocksDen && denUrl) return { kind: 'none', reason: USER_BLOCKS_DEN }
  return { kind: 'none', reason: 'RIVET_DEN_URL and RIVETOS_PG_URL are not set' }
}
