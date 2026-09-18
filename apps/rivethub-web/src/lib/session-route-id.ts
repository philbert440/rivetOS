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
 * Path segment for a session detail URL. Canonical ids are encoded; bare
 * native keys (legacy / draft) pass through encodeURIComponent so the router
 * keeps one segment.
 */
export function sessionPathSegment(sessionKey: string): string {
  if (isSessionId(sessionKey)) return encodeSessionIdSegment(sessionKey)
  return encodeURIComponent(sessionKey)
}

export function sessionDetailPath(sessionKey: string): string {
  return `/sessions/${sessionPathSegment(sessionKey)}`
}

/** Chat deep link — `/?session=<chat key>` (canonical or bare). */
export function chatSessionHref(chatKey: string): string {
  return `/?session=${encodeURIComponent(chatKey)}`
}
