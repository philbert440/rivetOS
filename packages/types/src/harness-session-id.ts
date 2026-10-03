/**
 * SessionId codec for the harness control plane — parse/format plus the
 * single-segment `enc()`/`dec()` used by den resource names and gateway path
 * params.
 *
 * Runtime half of the harness contract (types live in `harness.ts`, same split
 * as `task.ts` / `task-result.ts`). Pure string work: no I/O, no deps, and no
 * Node-only globals, so browser clients (`@rivetos/gateway-client`, hub) can
 * use the same codec the node uses.
 *
 * Source of truth: docs/ARCHITECTURE.md § Session identity.
 */

import { HarnessError } from './errors.js'
import { HARNESS_IDS } from './harness.js'
import type { HarnessId, SessionId } from './harness.js'

function invalid(message: string, id: string): HarnessError {
  return new HarnessError('invalid_session_id', message, { context: { id } })
}

function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
}

/**
 * Split a canonical `<harness-id>:<native-session-id>` on the FIRST colon.
 *
 * Native ids are opaque and may themselves contain `:` (and `/`, for Claude's
 * path-derived legacy keys), so only the first colon is structural. Validation
 * is as-is — surrounding whitespace is rejected, never trimmed, so a stray
 * space can't silently alias two different capture keys onto one session.
 *
 * @throws HarnessError `invalid_session_id`
 */
export function parseSessionId(id: string): { harnessId: HarnessId; nativeSessionId: string } {
  if (typeof id !== 'string') throw invalid('SessionId must be a string', String(id))
  if (id !== id.trim()) throw invalid('SessionId has leading/trailing whitespace', id)
  const i = id.indexOf(':')
  if (i <= 0) throw invalid('SessionId is missing a harness-id prefix', id)
  if (i === id.length - 1) throw invalid('SessionId has an empty native session id', id)
  const harnessId = id.slice(0, i)
  if (!isHarnessId(harnessId)) throw invalid(`unknown harness id: ${harnessId}`, id)
  return { harnessId, nativeSessionId: id.slice(i + 1) }
}

/**
 * Compose a canonical SessionId. Validates through `parseSessionId`, so
 * anything `formatSessionId` returns round-trips.
 *
 * @throws HarnessError `invalid_session_id`
 */
export function formatSessionId(harnessId: HarnessId, nativeSessionId: string): SessionId {
  const id = `${harnessId}:${nativeSessionId}`
  parseSessionId(id)
  return id as SessionId
}

/** `true` if `id` is a well-formed canonical SessionId. */
export function isSessionId(id: string): id is SessionId {
  try {
    parseSessionId(id)
    return true
  } catch {
    return false
  }
}

const NATIVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every capture key a session may be stored under, for a key a client asks
 * with. Historical rows are never rewritten (harness-control-plane.md
 * § Legacy keys), so a read that joins on `ros_conversations.session_key`
 * must try them all:
 *
 *   - the key as given;
 *   - for a canonical `<harness-id>:<native>` id, the bare native half — a
 *     den-spawned harness captures under the bare den join key it inherited
 *     via RIVETOS_SESSION_KEY;
 *   - for Claude's path-fallback form `<harness-id>:<project-slug>/<uuid>`,
 *     the collapsed `<harness-id>:<uuid>` and the bare `<uuid>`.
 *
 * Same rule as `bareAliasOf` (@rivetos/core) and `collapsePathFallback`
 * (den-server), which stay replicas only because those packages cannot
 * import each other; this is the copy both — and the memory plugin — can
 * share. A key that is not a SessionId (`task:<id>`, an already-bare id)
 * aliases to itself only. The requested key is always first.
 */
export function sessionKeyAliases(key: string): string[] {
  const out = [key]
  const i = key.indexOf(':')
  if (i <= 0 || i === key.length - 1) return out
  const harnessId = key.slice(0, i)
  if (!isHarnessId(harnessId)) return out
  const native = key.slice(i + 1)
  const slash = native.lastIndexOf('/')
  const tail = slash < 0 ? '' : native.slice(slash + 1)
  if (tail !== '' && NATIVE_UUID_RE.test(tail)) {
    out.push(`${harnessId}:${tail}`, tail)
  } else {
    out.push(native)
  }
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// Single-segment codec: enc(SessionId) = unpadded base64url of the UTF-8 id
// ---------------------------------------------------------------------------
//
// Percent-encoded `/` inside a path segment is unreliable across routers and
// proxies, and Claude's path-fallback native ids contain `/` — so den resource
// names and gateway `:sessionId` params carry the base64url form instead.

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

function toBinaryString(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

function fromBinaryString(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Encode a SessionId as one URL/path-safe segment: unpadded base64url of the
 * UTF-8 bytes. Validates the input first — only canonical ids get encoded.
 *
 * @throws HarnessError `invalid_session_id`
 */
export function encodeSessionIdSegment(sessionId: string): string {
  parseSessionId(sessionId)
  const bytes = new TextEncoder().encode(sessionId)
  return btoa(toBinaryString(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Inverse of `encodeSessionIdSegment`. Rejects padded/whitespace/non-base64url
 * input and anything that doesn't decode to a canonical SessionId.
 *
 * @throws HarnessError `invalid_session_id`
 */
export function decodeSessionIdSegment(segment: string): SessionId {
  if (typeof segment !== 'string' || !BASE64URL_RE.test(segment)) {
    throw invalid('session id segment is not unpadded base64url', segment)
  }
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  let binary: string
  try {
    binary = atob(b64)
  } catch (cause) {
    throw new HarnessError('invalid_session_id', 'session id segment failed base64url decode', {
      cause: cause instanceof Error ? cause : undefined,
      context: { segment },
    })
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(fromBinaryString(binary))
  } catch (cause) {
    throw new HarnessError('invalid_session_id', 'session id segment is not valid UTF-8', {
      cause: cause instanceof Error ? cause : undefined,
      context: { segment },
    })
  }
  parseSessionId(decoded)
  return decoded as SessionId
}
