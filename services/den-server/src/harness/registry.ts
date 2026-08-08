/**
 * HarnessDriver registry — the node's control plane (Phase 2).
 *
 * Drivers register at boot; the gateway resolves every request through here
 * and never touches a harness binary itself. The registry owns the three jobs
 * the contract calls "control-plane-owned":
 *
 *   - **Driver lookup + capability sheet** (`GET /api/harnesses`).
 *   - **Alias resolution before dispatch.** Legacy and superseded ids are
 *     collapsed to canonical here, so drivers only ever see canonical ids —
 *     including for `subscribe` (docs/plans/harness-control-plane.md
 *     § Contract semantics).
 *   - **Rotation bookkeeping.** The registry tails every driver's
 *     `subscribeEvents` stream; a `session-updated` carrying
 *     `previousSessionId` becomes an alias, so a client holding the old id
 *     keeps resolving.
 *
 * It also fans the per-driver registry streams out to WS subscribers
 * (`GET /api/harnesses/ws`).
 */

import {
  HARNESS_IDS,
  HarnessError,
  formatSessionId,
  parseSessionId,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessId,
  type HarnessSessionSummary,
  type SessionId,
} from '@rivetos/types'
import { createAliasStore, normalizeSessionId, type AliasStore } from './alias.js'

export interface HarnessDescriptor {
  harnessId: HarnessId
  capabilities: HarnessCapabilities
}

export interface ResolvedSession {
  driver: HarnessDriver
  /** Canonical id — what the driver is called with. */
  sessionId: SessionId
  /** The id the caller asked for, when it differed (superseded/legacy). */
  requestedId?: string
}

export interface HarnessRegistry {
  register(driver: HarnessDriver): void
  get(harnessId: string): HarnessDriver | undefined
  /** Drivers + capability flags — the `GET /api/harnesses` body. */
  list(): HarnessDescriptor[]
  /**
   * Resolve any inbound id (canonical, superseded, or a legacy shape) to the
   * canonical id and its owning driver.
   *
   * @throws HarnessError `invalid_session_id` when the id is malformed, names
   *         an unknown harness, or no registered driver claims a bare uuid.
   */
  resolve(raw: string): Promise<ResolvedSession>
  /** Record a rotation alias (`previous → canonical`). */
  alias(previous: SessionId, canonical: SessionId): void
  /** Is `id` anywhere in an alias chain? Backs the collision rule. */
  knows(id: SessionId): boolean
  /** Live registry stream across every driver (or one, when filtered). */
  subscribe(sink: (e: HarnessEvent) => void, harnessId?: HarnessId): () => void
  /** Detach from every driver stream (server shutdown). */
  close(): void
}

/** `true` when `value` is one of the four fixed product tokens. */
export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
}

export function createHarnessRegistry(opts: { aliases?: AliasStore } = {}): HarnessRegistry {
  const drivers = new Map<HarnessId, HarnessDriver>()
  const aliases = opts.aliases ?? createAliasStore()
  const sinks = new Set<{ harnessId?: HarnessId; sink: (e: HarnessEvent) => void }>()
  const detach = new Map<HarnessId, () => void>()
  /**
   * Probe CACHE for bare native uuids, not an alias-store entry: `<uuid>` →
   * `<harness>:<uuid>` is derivable at any time by asking the drivers, and it
   * never rotates, so it has no business in a chain that alias-hygiene rules
   * apply to. It exists only so a store scan is not paid per request.
   */
  const bareOwner = new Map<string, HarnessId>()

  const fanout = (harnessId: HarnessId, event: HarnessEvent): void => {
    for (const entry of [...sinks]) {
      if (entry.harnessId && entry.harnessId !== harnessId) continue
      try {
        entry.sink(event)
      } catch {
        /* one bad subscriber must never break the others */
      }
    }
  }

  return {
    register(driver): void {
      const harnessId: string = driver.harnessId
      if (!isHarnessId(harnessId)) {
        throw new HarnessError('invalid_session_id', `unknown harness id: ${harnessId}`, {
          harnessId,
        })
      }
      if (drivers.has(harnessId)) {
        throw new HarnessError('session_id_collision', `driver already registered: ${harnessId}`, {
          harnessId,
        })
      }
      drivers.set(harnessId, driver)
      // Tail the driver's registry stream: rotation aliases are recorded here
      // (never in the driver) and the event is then fanned to WS clients.
      detach.set(
        harnessId,
        driver.subscribeEvents((event) => {
          if (event.type === 'session-updated' && event.previousSessionId) {
            // ⚠️ PHASE 3 OBLIGATION: recording the alias is only half of
            // rotation. Live subscriptions registered under the superseded id
            // must be re-keyed onto the canonical one here (alias resolution is
            // control-plane-owned, so it belongs in this file, not in each
            // driver), and the superseded id's lifecycle must be marked ended.
            // Unobservable today — Claude never rotates. Blocking for hermes.
            // See docs/plans/harness-control-plane.md § Phase 3 obligations.
            try {
              aliases.record(event.previousSessionId, event.sessionId)
            } catch {
              // A cross-harness or cyclic rotation is a driver bug; drop the
              // alias but still deliver the event so clients see the status.
            }
          }
          fanout(harnessId, event)
        }),
      )
    },

    get: (harnessId) => (isHarnessId(harnessId) ? drivers.get(harnessId) : undefined),

    list: () =>
      [...drivers.values()].map((d) => ({
        harnessId: d.harnessId,
        capabilities: d.capabilities,
      })),

    async resolve(raw): Promise<ResolvedSession> {
      const normalized = normalizeSessionId(raw)
      let canonical: SessionId
      if (normalized.kind === 'canonical') {
        canonical = aliases.resolve(normalized.sessionId)
      } else {
        // Bare native uuid (den drawer / hub chat conversation id). No harness
        // in the string, so ask each registered driver whether it owns it and
        // memoize the answer in the probe cache above (deliberately NOT the
        // alias store — see `bareOwner`). Rotation aliases still apply on top:
        // the probe result is resolved through the chain before dispatch.
        const native = normalized.nativeSessionId
        const cached = bareOwner.get(native)
        const candidates: HarnessId[] = cached ? [cached] : [...drivers.keys()]
        let found: SessionId | undefined
        for (const harnessId of candidates) {
          const driver = drivers.get(harnessId)
          if (!driver) continue
          const probe = formatSessionId(harnessId, native)
          const summary = await driver.getSession(aliases.resolve(probe)).catch(() => null)
          if (summary) {
            bareOwner.set(native, harnessId)
            found = aliases.resolve(probe)
            break
          }
        }
        if (!found) {
          throw new HarnessError(
            'invalid_session_id',
            `no registered harness owns bare session id ${native}`,
            { sessionId: raw },
          )
        }
        canonical = found
      }
      const { harnessId } = parseSessionId(canonical)
      const driver = drivers.get(harnessId)
      if (!driver) {
        throw new HarnessError('invalid_session_id', `no driver registered for ${harnessId}`, {
          harnessId,
          sessionId: canonical,
        })
      }
      return raw === canonical
        ? { driver, sessionId: canonical }
        : { driver, sessionId: canonical, requestedId: raw }
    },

    alias: (previous, canonical) => aliases.record(previous, canonical),
    knows: (id) => aliases.knows(id),

    subscribe(sink, harnessId): () => void {
      const entry = { harnessId, sink }
      sinks.add(entry)
      return () => sinks.delete(entry)
    },

    close(): void {
      for (const off of detach.values()) {
        try {
          off()
        } catch {
          /* shutdown is best-effort */
        }
      }
      detach.clear()
      sinks.clear()
      drivers.clear()
    },
  }
}

/** Convenience re-export so route code has one import for the wire shape. */
export type { HarnessSessionSummary }
