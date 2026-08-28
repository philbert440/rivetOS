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

import type { IncomingHttpHeaders } from 'node:http'

export const TRUSTED_USER_HEADER = 'x-rivetos-user'

/** The den-stamped routing identity, or undefined. Non-string / duplicated
 *  header values (which den's delete-then-set can never produce) are treated
 *  as absent rather than trusted. */
export function routedUserFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers[TRUSTED_USER_HEADER]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}
