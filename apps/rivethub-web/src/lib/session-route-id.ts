/**
 * Session page URL codec. Path params use encodeSessionIdSegment for
 * canonical ids (Claude native ids contain `/`). Bare native ids are still
 * accepted for legacy deep links and resolved by the gateway.
 */

import {
  decodeSessionIdSegment,
  encodeSessionIdSegment,
  isSessionId,
  type SessionId,
} from '@rivetos/types'

export type ResolvedSessionRoute =
  { kind: 'canonical'; sessionId: SessionId } | { kind: 'bare'; nativeId: string }

/**
 * Resolve a `/sessions/$sessionId` path segment.
 *
 * Order: base64url-encoded canonical → raw canonical → bare native id.
 * Encode rejects bare ids, so a Claude path-shaped native must already be
 * wrapped in a canonical SessionId before it can ride the URL.
 */
export function resolveSessionRouteParam(segment: string): ResolvedSessionRoute {
  try {
    return { kind: 'canonical', sessionId: decodeSessionIdSegment(segment) }
  } catch {
    // not an encoded segment
  }
  if (isSessionId(segment)) {
    return { kind: 'canonical', sessionId: segment }
  }
  return { kind: 'bare', nativeId: segment }
}

/** Lookup id handed to getHarnessSession / attachHarnessSession. */
export function sessionLookupId(resolved: ResolvedSessionRoute): string {
  return resolved.kind === 'canonical' ? resolved.sessionId : resolved.nativeId
}

/**
 * `$sessionId` value for `navigate({ params })` / `<Link params>`. Canonical
 * ids become base64url (no `/`); bare native keys pass through RAW. The
 * router runs encodeURIComponent on params itself and decodes on match, so
 * pre-encoding here would double-encode (`%2F` → `%252F`) and the page would
 * resolve the wrong id.
 */
export function sessionRouteParam(sessionKey: string): string {
  if (isSessionId(sessionKey)) return encodeSessionIdSegment(sessionKey)
  return sessionKey
}

/**
 * Literal href for a session detail URL (copy link, `<a href>`). No router in
 * between, so the bare key is percent-encoded here to stay one segment.
 */
export function sessionDetailPath(sessionKey: string): string {
  return `/sessions/${encodeURIComponent(sessionRouteParam(sessionKey))}`
}

/** Chat deep link — `/?session=<chat key>` (canonical or bare). */
export function chatSessionHref(chatKey: string): string {
  return `/?session=${encodeURIComponent(chatKey)}`
}
