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

import { parseSessionId, type HarnessId } from '@rivetos/types'
import { normalizeSessionId } from './alias.js'

/** The roster tokens whose on-disk stores `term/harness-sessions` can read. */
export type StoreCommand = 'claude' | 'grok' | 'hermes' | 'kimi'

/**
 * `HarnessId` → the roster token naming its store.
 *
 * A literal rather than an import from the four driver modules: those import
 * `term/harness-sessions`, which is the main consumer of this map, so reaching
 * for their constants would invert the dependency. Roster tokens are UI/spawn
 * labels and never key material (§ Legacy keys) — this is a lookup table for
 * picking a reader, not an identity.
 */
const STORE_COMMAND: Record<HarnessId, StoreCommand> = {
  'claude-code': 'claude',
  'grok-build': 'grok',
  'kimi-code': 'kimi',
  hermes: 'hermes',
}

/** What an inbound session id says about where its session lives. */
export interface DenSessionRef {
  /** The den room key / native session id — what the stores are filed under. */
  native: string
  /**
   * The store the id NAMES, set only when the id was canonical. `undefined`
   * means the caller has to probe, which is the documented legacy behavior for
   * a bare id and nothing more: a canonical id identifies its harness, and
   * answering it from another harness's store would be a cross-store
   * fall-through the identity standard forbids (§ Collision rules, rule 2).
   */
  command?: StoreCommand
}

/**
 * Resolve any inbound session id onto the den's key space.
 *
 * - canonical `<harness-id>:<native>` → its native half plus the named store
 *   (Claude's path-fallback form collapses to its uuid first, per § Legacy
 *   keys precedence)
 * - bare native id → itself, no store named
 * - anything else (a synthetic room, `task:<id>`, junk) → itself, unchanged
 *
 * Never throws: callers are HTTP/WS edges whose existing contract is to treat
 * an unknown id as "no such session", not to 400 on it.
 */
export function denSessionRef(raw: string): DenSessionRef {
  let normalized: ReturnType<typeof normalizeSessionId>
  try {
    normalized = normalizeSessionId(raw)
  } catch {
    return { native: raw }
  }
  if (normalized.kind === 'bare') return { native: normalized.nativeSessionId }
  const { harnessId, nativeSessionId } = parseSessionId(normalized.sessionId)
  return { native: nativeSessionId, command: STORE_COMMAND[harnessId] }
}

/**
 * The den room key for any inbound session id — `denSessionRef().native`, for
 * the edges that only need to reach the right room and have no store to pick.
 */
export function denJoinKey(raw: string): string {
  return denSessionRef(raw).native
}
