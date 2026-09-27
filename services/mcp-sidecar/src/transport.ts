/**
 * Which backend the sidecar uses for memory, wiki, and delegate tools.
 *
 * `den` is HTTPS to the node's own den (no Postgres in this process).
 * `pg` is the direct pools. A non-empty `RIVETOS_USER_ID` never selects
 * `den`: loopback callers are the owner, so a routed user would read and
 * write the wrong pool. That holds even when transport is forced to `den`.
 */

export type SidecarTransport =
  { kind: 'den'; denUrl: string } | { kind: 'pg'; pgUrl: string } | { kind: 'none'; reason: string }

const USER_BLOCKS_DEN =
  'RIVETOS_USER_ID is set — den transport would hit the owner pool on loopback — and RIVETOS_PG_URL is not set'

function trimmed(value: string | undefined): string {
  return value?.trim() ?? ''
}

/**
 * `RIVETOS_MCP_TRANSPORT=den|pg` forces. Default: `den` when `RIVET_DEN_URL`
 * is set and `RIVETOS_USER_ID` is empty, else `pg` when `RIVETOS_PG_URL` is
 * set, else `none`. Forced `den` without a URL is `none`. A routed user id
 * refuses `den` and keeps `pg` (or `none` when no Postgres URL is set).
 */
export function resolveSidecarTransport(env: NodeJS.ProcessEnv): SidecarTransport {
  const forced = trimmed(env.RIVETOS_MCP_TRANSPORT)
  const denUrl = trimmed(env.RIVET_DEN_URL)
  const pgUrl = trimmed(env.RIVETOS_PG_URL)
  const userBlocksDen = env.RIVETOS_USER_ID !== undefined && env.RIVETOS_USER_ID !== ''

  if (forced === 'den') {
    if (!denUrl) {
      return { kind: 'none', reason: 'RIVETOS_MCP_TRANSPORT=den but RIVET_DEN_URL is not set' }
    }
    if (userBlocksDen) {
      if (pgUrl) return { kind: 'pg', pgUrl }
      return { kind: 'none', reason: USER_BLOCKS_DEN }
    }
    return { kind: 'den', denUrl }
  }

  if (forced === 'pg') {
    if (!pgUrl) {
      return { kind: 'none', reason: 'RIVETOS_MCP_TRANSPORT=pg but RIVETOS_PG_URL is not set' }
    }
    return { kind: 'pg', pgUrl }
  }

  if (denUrl && !userBlocksDen) return { kind: 'den', denUrl }
  if (pgUrl) return { kind: 'pg', pgUrl }
  if (userBlocksDen && denUrl) return { kind: 'none', reason: USER_BLOCKS_DEN }
  return { kind: 'none', reason: 'RIVET_DEN_URL and RIVETOS_PG_URL are not set' }
}

/** One startup line. Postgres URLs are not included (they can carry a password). */
export function sidecarTransportLog(transport: SidecarTransport, env: NodeJS.ProcessEnv): string {
  if (transport.kind === 'den') {
    return `[rivetos-mcp-sidecar] transport=den ${transport.denUrl}`
  }
  if (transport.kind === 'pg') {
    const userId = env.RIVETOS_USER_ID
    const denUrl = trimmed(env.RIVET_DEN_URL)
    if (userId && denUrl) {
      return '[rivetos-mcp-sidecar] transport=pg — RIVETOS_USER_ID is set; den transport would hit the owner pool on loopback'
    }
    return '[rivetos-mcp-sidecar] transport=pg'
  }
  return `[rivetos-mcp-sidecar] transport=none — ${transport.reason}`
}
