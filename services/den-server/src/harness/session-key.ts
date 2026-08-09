/**
 * Den join key ⟷ canonical SessionId (harness control plane, § Legacy keys).
 *
 * The den's own key space is the ROOM key: the string a PTY runs under
 * (`RIVET_DEN_SESSION`), that v1 AgentEvents carry as `session`, that the den
 * viewer joins with `?session=`, and that the on-disk harness stores file a
 * transcript under. For every session the hub opens that key IS the harness's
 * native session id — the term manager pins it at spawn so the room, the
 * store filename and the drawer row line up.
 *
 * The identity table canonicalizes the surfaces ABOVE that: hub chat's thread
 * key is a `SessionId`. So every den surface that used to take only a bare
 * native id now takes either shape and resolves it here — bare ids keep
 * working as aliases (§ Legacy keys: "Bare native uuid … alias →
 * `<harness-id>:<uuid>`"), and canonical ids stop being rejected as junk.
 *
 * Deliberately NOT a validator: den rooms hold plenty of strings that are
 * neither shape (`den-pty-1a2b3c4d` for an unpinned PTY, `unknown-<ppid>`
 * from an old translator, an operator's hand-rolled room, `task:<id>` from
 * the task engine). Those are their own key space and pass through untouched.
 */

import { parseSessionId } from '@rivetos/types'
import { normalizeSessionId } from './alias.js'

/**
 * The den room key for any inbound session id.
 *
 * - canonical `<harness-id>:<native>` → the native half (Claude's
 *   path-fallback form collapses to its uuid first, per § Legacy keys
 *   precedence)
 * - bare native id → itself
 * - anything else (a synthetic room, `task:<id>`, junk) → itself, unchanged
 *
 * Never throws: callers are HTTP/WS edges whose existing contract is to treat
 * an unknown id as "no such session", not to 400 on it.
 */
export function denJoinKey(raw: string): string {
  let normalized: ReturnType<typeof normalizeSessionId>
  try {
    normalized = normalizeSessionId(raw)
  } catch {
    return raw
  }
  if (normalized.kind === 'bare') return normalized.nativeSessionId
  return parseSessionId(normalized.sessionId).nativeSessionId
}
