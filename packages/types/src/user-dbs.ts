/**
 * Per-user database handle used by the users.json registry.
 *
 * A user id is routable IFF it has a usable entry here; "usable" must mean
 * the same thing at the stamp, the store, and the spawn, or a user can be
 * tagged by one layer and unroutable in another — which is how
 * cross-database leaks happen.
 *
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
