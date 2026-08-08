/**
 * Session-id alias store + legacy-key normalization (harness control plane,
 * Phase 2).
 *
 * Alias resolution is CONTROL-PLANE-OWNED: the gateway resolves a superseded
 * or legacy id to its canonical `<harness-id>:<native-session-id>` BEFORE
 * dispatching to a driver, so drivers only ever see canonical ids and never
 * consult this store (docs/plans/harness-control-plane.md § Contract
 * semantics).
 *
 * Two distinct jobs live here:
 *
 *   1. **Rotation aliases** — a harness that replaces its native id (compact,
 *      fork, crash recovery) emits `session-updated` with `previousSessionId`.
 *      We record `previous → canonical`. Chains never expire, always terminate
 *      at the newest id, are cycle-checked, and are depth-capped at 32.
 *
 *   2. **Legacy shapes** — the repo already holds several key shapes for one
 *      interactive session (§ Legacy keys). Pure string rules go here; the
 *      shapes that need a store probe (a bare native uuid) are resolved by the
 *      registry against its own probe cache, which is NOT this store — that
 *      mapping is derivable on demand and never rotates.
 *
 * `task:<taskId>` is deliberately NOT handled: it is a parallel, non-harness
 * conversation-key namespace and must never be parsed as a SessionId.
 */

import { HarnessError, parseSessionId, type SessionId } from '@rivetos/types'

/** Chain hygiene: beyond this something is broken, so reject loudly. */
export const MAX_ALIAS_CHAIN_DEPTH = 32

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `true` when `value` is a bare native uuid (the den drawer / hub chat shape). */
export function isBareNativeUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function invalid(message: string, id: string): HarnessError {
  return new HarnessError('invalid_session_id', message, { context: { id } })
}

/**
 * Collapse Claude's path-fallback capture key onto its canonical form:
 * `claude-code:<project-slug>/<uuid>` → `claude-code:<uuid>`.
 *
 * `deriveSessionKey` in the capture plugin produces the path form when the
 * session uuid isn't known yet; the uuid form is canonical and wins
 * (§ Legacy keys, precedence). Native ids that contain `/` but do NOT end in a
 * uuid are left alone — they are opaque host strings, not path fallbacks.
 */
export function collapsePathFallback(id: SessionId): SessionId {
  const { harnessId, nativeSessionId } = parseSessionId(id)
  const slash = nativeSessionId.lastIndexOf('/')
  if (slash < 0) return id
  const tail = nativeSessionId.slice(slash + 1)
  if (!isBareNativeUuid(tail)) return id
  return `${harnessId}:${tail}`
}

/**
 * Normalize any inbound id string to a canonical SessionId, applying the
 * pure-string half of the legacy table. Bare native uuids cannot be resolved
 * here (they carry no harness) — the caller gets `bare` back and probes the
 * registered drivers.
 *
 * @throws HarnessError `invalid_session_id`
 */
export function normalizeSessionId(
  raw: string,
): { kind: 'canonical'; sessionId: SessionId } | { kind: 'bare'; nativeSessionId: string } {
  if (raw === '') throw invalid('session id is empty', raw)
  if (raw !== raw.trim()) throw invalid('session id has leading/trailing whitespace', raw)
  if (raw.startsWith('task:')) {
    throw invalid('task:<taskId> is a task conversation key, not a SessionId', raw)
  }
  if (isBareNativeUuid(raw)) return { kind: 'bare', nativeSessionId: raw }
  // parseSessionId throws invalid_session_id for everything else that is not
  // `<known-harness>:<non-empty>` — including agent nicknames (`claude:…`).
  return { kind: 'canonical', sessionId: collapsePathFallback(raw as SessionId) }
}

export interface AliasStore {
  /**
   * Record a rotation alias. Both ids MUST share a harness id; the control
   * plane rejects cross-harness aliases (§ Rotation, rule 8).
   */
  record(previous: SessionId, canonical: SessionId): void
  /** Follow the chain to the newest id. Unknown ids resolve to themselves. */
  resolve(id: SessionId): SessionId
  /**
   * Is this id anywhere in a chain (including rotated-away ids)? Alias chains
   * occupy the namespace, so a `startSession` that pins a matching native id
   * is a `session_id_collision` (§ Collision rules, rule 3).
   */
  knows(id: SessionId): boolean
  /** Every id that resolves to `canonical`, newest-last. Test/debug surface. */
  chainFor(canonical: SessionId): SessionId[]
  size(): number
}

export function createAliasStore(): AliasStore {
  /** previous → next. The value is one hop, not necessarily canonical. */
  const next = new Map<SessionId, SessionId>()
  /** Every id we have ever seen on either side of an alias. */
  const seen = new Set<SessionId>()

  const resolve = (id: SessionId): SessionId => {
    let current = id
    const walked = new Set<SessionId>([current])
    for (let depth = 0; depth < MAX_ALIAS_CHAIN_DEPTH; depth++) {
      const hop = next.get(current)
      if (hop === undefined) return current
      if (walked.has(hop)) {
        throw invalid(`alias chain for ${id} contains a cycle at ${hop}`, id)
      }
      walked.add(hop)
      current = hop
    }
    throw invalid(`alias chain for ${id} exceeds depth ${String(MAX_ALIAS_CHAIN_DEPTH)}`, id)
  }

  return {
    record(previous, canonical): void {
      const prev = parseSessionId(previous)
      const canon = parseSessionId(canonical)
      if (prev.harnessId !== canon.harnessId) {
        throw invalid(
          `cross-harness alias rejected: ${previous} → ${canonical}`,
          `${previous} → ${canonical}`,
        )
      }
      if (previous === canonical) return // self-alias is a no-op, not an error
      // Resolve BEFORE writing so a cycle is caught while the map is still
      // consistent (a recorded cycle would poison every later resolve()).
      if (resolve(canonical) === previous) {
        throw invalid(
          `alias ${previous} → ${canonical} would create a cycle`,
          `${previous} → ${canonical}`,
        )
      }
      next.set(previous, canonical)
      seen.add(previous)
      seen.add(canonical)
      // Depth guard on write too — a long chain must fail at the rotation
      // that broke it, not at some later unrelated read.
      resolve(previous)
    },
    resolve,
    knows: (id) => seen.has(id),
    chainFor(canonical): SessionId[] {
      const members: SessionId[] = []
      for (const id of seen) {
        if (id === canonical) continue
        try {
          if (resolve(id) === canonical) members.push(id)
        } catch {
          /* broken chain — not a member for reporting purposes */
        }
      }
      members.push(canonical)
      return members
    },
    size: () => next.size,
  }
}
