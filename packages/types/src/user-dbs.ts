/**
 * RIVETOS_USER_DBS — the per-user memory routing map, one policy for every
 * consumer (den-server stamping, @rivetos/memory-postgres stores, the
 * claude-cli provider's spawn env). A user id is routable IFF it has a
 * usable entry here; "usable" must mean the same thing at the stamp, the
 * store, and the spawn, or a user can be tagged by one layer and unroutable
 * in another — which is how cross-database leaks happen.
 *
 * Shape: {"<userId>": {"pgUrl": "postgres://…", "envFile": "/path"?}}.
 * `pgUrl` is REQUIRED — it is the routing target. `envFile` is additive
 * (extra env for spawned harness sessions), never sufficient alone.
 */

export interface UserDbEntry {
  pgUrl: string
  envFile?: string
}

/** True for an object with a non-empty string `pgUrl` (and, when present, a
 *  non-empty string `envFile`). */
export function isUsableUserDb(entry: unknown): entry is UserDbEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const e = entry as Record<string, unknown>
  const okString = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
  if (!okString(e.pgUrl)) return false
  if ('envFile' in e && e.envFile !== undefined && !okString(e.envFile)) return false
  return true
}

/** Parse the env var. Unusable entries are dropped with a warning naming the
 *  user; a malformed document returns undefined (routing off) with an error
 *  naming the variable. Never throws. */
export function parseUserDbs(raw: string | undefined): Record<string, UserDbEntry> | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    console.error('[rivetos] RIVETOS_USER_DBS is not valid JSON — per-user routing disabled')
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[rivetos] RIVETOS_USER_DBS is not a JSON object — per-user routing disabled')
    return undefined
  }
  const out: Record<string, UserDbEntry> = {}
  for (const [userId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (userId.trim() === '') continue
    if (!isUsableUserDb(entry)) {
      console.error(`[rivetos] RIVETOS_USER_DBS entry for "${userId}" is unusable — dropped`)
      continue
    }
    out[userId] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}
