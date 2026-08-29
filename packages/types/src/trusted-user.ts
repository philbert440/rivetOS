/**
 * Trusted per-user routing identity.
 *
 * den-server — the mTLS terminus — strips any inbound `x-rivetos-user` and
 * stamps the user id its device→user map resolves from the client cert. That
 * header is therefore the ONLY request-derived value allowed to select a
 * memory database. Client-controlled body fields (`userId`, OpenAI `user`)
 * must never route: before per-user routing they were labels; now they pick
 * a database.
 */

/** Structural header shape (Node's IncomingHttpHeaders) — kept dependency-free
 *  so this package stays safe to bundle for the browser. */
type HeaderMap = Record<string, string | string[] | undefined>

export const TRUSTED_USER_HEADER = 'x-rivetos-user'

/** The den-stamped routing identity, or undefined. Non-string / duplicated
 *  header values (which den's delete-then-set can never produce) are treated
 *  as absent rather than trusted. */
export function routedUserFromHeaders(headers: HeaderMap): string | undefined {
  const raw = headers[TRUSTED_USER_HEADER]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** Trichotomous form for surfaces where "absent header = owner" is a security
 *  boundary (the memory panel): a PRESENT but malformed value (duplicate
 *  array, empty string) must refuse, never collapse to the owner default.
 *  den's delete-then-set can't produce these; anything that does is not den. */
export function routedUserResult(
  headers: HeaderMap,
): { kind: 'owner' } | { kind: 'user'; id: string } | { kind: 'invalid' } {
  if (!(TRUSTED_USER_HEADER in headers) || headers[TRUSTED_USER_HEADER] === undefined) {
    return { kind: 'owner' }
  }
  const raw = headers[TRUSTED_USER_HEADER]
  if (typeof raw !== 'string' || raw === '') return { kind: 'invalid' }
  return { kind: 'user', id: raw }
}
