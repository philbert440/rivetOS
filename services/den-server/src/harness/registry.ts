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
 *     keeps resolving. Recording the alias also (a) **re-keys every live
 *     per-session subscription** off the superseded id onto the canonical one
 *     and hands it the rotation event exactly once — the contract's
 *     "subscriptions survive rotation" — and (b) **ends the superseded id's
 *     lifecycle**: it is reported `ended` on the registry stream once and
 *     never appears in `listSessions` again.
 *
 * It also fans the per-driver registry streams out to WS subscribers
 * (`GET /api/harnesses/ws`).
 *
 * Rotation lives here rather than in each driver for the same reason alias
 * resolution does: a driver that had to re-key its own sinks would have to
 * consult the alias store, which the contract forbids. Drivers emit the
 * rotation and keep pinning sinks to the single native id they were handed.
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
import {
  MAX_ALIAS_CHAIN_DEPTH,
  createAliasStore,
  normalizeSessionId,
  type AliasStore,
} from './alias.js'

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
  /**
   * Has `id` been rotated away from? True for every chain member except the
   * head — the ids whose lifecycle rotation ended.
   */
  isSuperseded(id: SessionId): boolean
  /**
   * Guard a caller-pinned `startSession` id: alias chains occupy the
   * namespace, so a native id matching ANY chain member is a collision even if
   * the harness store itself has forgotten it (§ Collision rules, rule 3).
   *
   * @throws HarnessError `session_id_collision` | `invalid_session_id`
   */
  assertPinnable(harnessId: HarnessId, nativeSessionId: string): void
  /**
   * `listSessions` for one driver, canonical-only. Superseded ids never reach
   * a client: a row still keyed on a rotated-away id is reported under its
   * canonical id, and collapses into the canonical row when the driver returns
   * both (§ Contract semantics, "`listSessions` returns canonical ids only").
   *
   * @throws HarnessError `invalid_session_id` | `capability_unsupported`
   */
  listSessions(harnessId: HarnessId): Promise<HarnessSessionSummary[]>
  /** Live registry stream across every driver (or one, when filtered). */
  subscribe(sink: (e: HarnessEvent) => void, harnessId?: HarnessId): () => void
  /**
   * Per-session live tail that **follows the alias chain**. Attaches the sink
   * to the driver under the canonical id and moves it on every rotation, so a
   * client subscribed under an id that later rotates keeps its socket: it
   * receives the rotation `session-updated` on this same sink and every later
   * event simply carries the new `sessionId`
   * (§ Contract semantics, "Subscriptions survive rotation").
   *
   * This is the only per-session subscribe the gateway should call —
   * `driver.subscribe` pins one native id by design.
   *
   * @throws whatever the driver's `subscribe` throws (e.g.
   *         `capability_unsupported` when the node has no live stream), plus
   *         `invalid_session_id` for an id no registered driver owns.
   */
  subscribeSession(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void
  /** Detach from every driver stream (server shutdown). */
  close(): void
}

/** `true` when `value` is one of the four fixed product tokens. */
export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
}

/** One live per-session tail, as tracked across rotations. */
interface SessionSubscription {
  harnessId: HarnessId
  /** The id the sink is currently attached to the driver under. */
  current: SessionId
  /** The client's sink — never re-registered, that is the whole point. */
  sink: (e: HarnessEvent) => void
  /** Driver-facing wrapper: de-dupes the rotation event, then forwards. */
  deliver: (e: HarnessEvent) => void
  /** Detach from the driver at `current`. */
  off: () => void
  /**
   * Rotations already handed to the client — `previous→next` keys, newest
   * last. Bounded: only a rotation the client could still see a duplicate of
   * matters, and a chain is capped at `MAX_ALIAS_CHAIN_DEPTH` hops, so a tail
   * that lives through a thousand rotations remembers the last 32 and forgets
   * the rest rather than growing for the life of the socket.
   */
  delivered: Set<string>
  closed: boolean
}

const rotationKey = (previous: SessionId, next: SessionId): string => `${previous}→${next}`

/** See `SessionSubscription.delivered`. */
const ROTATION_MEMORY = MAX_ALIAS_CHAIN_DEPTH

/**
 * Read `closed` through a call, deliberately.
 *
 * A subscription can be torn down *during* a re-key — the client's sink calls
 * its own unsubscribe, or a nested rotation runs — and TypeScript's property
 * narrowing does not survive that: after one `sub.closed` check it treats the
 * field as permanently `false` for the rest of the block. A function call
 * returns a plain boolean, so each check is real.
 */
const isClosed = (sub: SessionSubscription): boolean => sub.closed

/** Record a rotation as delivered, evicting the oldest beyond the window. */
function remember(sub: SessionSubscription, key: string): void {
  sub.delivered.add(key)
  if (sub.delivered.size <= ROTATION_MEMORY) return
  const oldest = sub.delivered.values().next()
  if (!oldest.done) sub.delivered.delete(oldest.value)
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
  /** Live per-session tails, in attach order. See `subscribeSession`. */
  const sessionSubs = new Set<SessionSubscription>()
  /** Ids already reported `ended` by a rotation — retirement happens once. */
  const retired = new Set<SessionId>()

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

  /** Hand the client one event, never letting its exception escape. */
  const push = (sub: SessionSubscription, event: HarnessEvent): void => {
    try {
      sub.sink(event)
    } catch {
      /* one bad subscriber must never break the others */
    }
  }

  /**
   * Move every live tail off a superseded id and hand it the rotation event.
   *
   * Delivery is exactly-once regardless of driver ordering. A driver may emit
   * the rotation to its per-session sinks before the registry stream (the sink
   * has already seen it — the `delivered` set makes this call a no-op), after
   * it (the sink has moved, so only this call delivers), under the NEW id
   * (dropped by the same set once re-keyed), or not on the session sinks at
   * all (only this call delivers). All four are contract-conformant drivers.
   *
   * Three invariants the code below is otherwise silent about:
   *
   *   - **Deliver, then move.** The client sees the rotation before its sink
   *     changes id, so a driver that emits its NEXT rotation synchronously
   *     from inside `subscribe` cannot overtake this one on the wire.
   *   - **Attach before detach** leaves the sink briefly on both ids. That is
   *     deliberate and unobservable: JS runs this to completion, so no event
   *     can interleave, and the opposite order would open a real gap for a
   *     driver that emits during `subscribe`.
   *   - **Re-entrancy.** That same driver re-enters this function through the
   *     registry stream, and the inner frame legitimately advances the tail
   *     further down the chain. Every frame therefore re-checks the tail after
   *     `subscribe` returns and yields to whoever moved it (see below) — the
   *     alternative, an outer frame assigning stale locals, strands the client
   *     on an abandoned id.
   */
  const rekey = (
    harnessId: HarnessId,
    previous: SessionId,
    event: HarnessEvent & { type: 'session-updated' },
  ): void => {
    const canonical = aliases.resolve(event.sessionId)
    const key = rotationKey(previous, event.sessionId)
    const driver = drivers.get(harnessId)
    for (const sub of [...sessionSubs]) {
      if (sub.closed || sub.harnessId !== harnessId || sub.current === canonical) continue
      let follows: boolean
      try {
        follows = aliases.resolve(sub.current) === canonical
      } catch {
        follows = false // broken chain — leave the tail where it is
      }
      if (!follows) continue

      if (!sub.delivered.has(key)) {
        remember(sub, key)
        push(sub, event)
      }
      // The sink may have unsubscribed from inside that delivery; its own
      // teardown already detached the driver, so there is nothing to move.
      if (isClosed(sub) || !driver) continue

      const attachedAt = sub.current
      let nextOff: (() => void) | undefined
      let attachFailed = false
      try {
        nextOff = driver.subscribe(canonical, sub.deliver)
      } catch {
        attachFailed = true
      }
      if (isClosed(sub) || sub.current !== attachedAt) {
        // A nested rotation emitted from inside `subscribe` already moved this
        // tail (or the client left). That frame owns `current`/`off` and has
        // gone further down the chain than we have, so our attachment is the
        // stale one: undo it and leave everything else alone.
        try {
          nextOff?.()
        } catch {
          /* undoing a stale attachment is best-effort */
        }
        continue
      }
      try {
        sub.off()
      } catch {
        /* detaching a stale sink is best-effort */
      }
      sub.current = canonical
      sub.off = nextOff ?? ((): void => undefined)
      if (attachFailed) {
        // The tail is now silent. Saying so beats a socket that looks alive:
        // `error` is retryable, and the client's reconnect path already
        // re-subscribes and hard-resyncs from the transcript.
        push(sub, {
          type: 'error',
          sessionId: canonical,
          code: 'subscribe_failed',
          message: `${harnessId} refused a live tail for ${canonical} after rotation — re-subscribe and resync`,
          retryable: true,
        })
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
          let rotated: SessionId | undefined
          if (
            event.type === 'session-updated' &&
            event.previousSessionId &&
            // A driver restating its own id is a status update, not a
            // rotation: the store no-ops it, and treating it as one would
            // retire a live session on the stream.
            event.previousSessionId !== event.sessionId
          ) {
            try {
              aliases.record(event.previousSessionId, event.sessionId)
              rotated = event.previousSessionId
            } catch {
              // Cross-harness, cyclic, or a second successor for an id that
              // already rotated — all driver bugs. Drop the alias but still
              // deliver the event so clients see the status.
            }
          }
          // Re-key live tails BEFORE the fanout: the rotation event reaches
          // per-session subscribers through their own (now moved) sink, and a
          // registry subscriber that reacts synchronously to the fanout must
          // already see the post-rotation world.
          if (rotated && event.type === 'session-updated') rekey(harnessId, rotated, event)
          fanout(harnessId, event)
          // The superseded id's lifecycle ends here. Reported once — a driver
          // that re-emits the same rotation records an idempotent alias, and
          // must not produce a second retirement — and AFTER the rotation
          // event, so a registry client has already moved its row to the
          // canonical id and reads this as "the old key is retired" rather
          // than "the session died".
          if (rotated && !retired.has(rotated)) {
            retired.add(rotated)
            fanout(harnessId, {
              type: 'session-updated',
              sessionId: rotated,
              status: 'ended',
            })
          }
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

    isSuperseded(id): boolean {
      if (!aliases.knows(id)) return false
      try {
        return aliases.resolve(id) !== id
      } catch {
        return false
      }
    },

    assertPinnable(harnessId, nativeSessionId): void {
      const pinned = formatSessionId(harnessId, nativeSessionId)
      if (aliases.knows(pinned)) {
        throw new HarnessError(
          'session_id_collision',
          `${pinned} is already part of an alias chain`,
          { harnessId, sessionId: pinned },
        )
      }
    },

    async listSessions(harnessId): Promise<HarnessSessionSummary[]> {
      const driver = drivers.get(harnessId)
      if (!driver) {
        throw new HarnessError('invalid_session_id', `no driver registered for ${harnessId}`, {
          harnessId,
        })
      }
      if (!driver.capabilities.listSessions) {
        throw new HarnessError('capability_unsupported', `${harnessId} cannot list sessions`, {
          harnessId,
        })
      }
      // Keyed by canonical id, insertion-ordered. A row the driver still keys
      // on a rotated-away id is rewritten, and loses to the canonical row when
      // the driver returns both — one session must not list twice.
      const byCanonical = new Map<SessionId, HarnessSessionSummary>()
      for (const row of await driver.listSessions()) {
        let canonical: SessionId
        try {
          canonical = aliases.resolve(row.sessionId)
        } catch {
          canonical = row.sessionId // broken chain: report it as the driver sees it
        }
        const rewritten = canonical === row.sessionId ? row : { ...row, sessionId: canonical }
        if (byCanonical.has(canonical) && canonical !== row.sessionId) continue
        byCanonical.set(canonical, rewritten)
      }
      return [...byCanonical.values()]
    },

    subscribe(sink, harnessId): () => void {
      const entry = { harnessId, sink }
      sinks.add(entry)
      return () => sinks.delete(entry)
    },

    subscribeSession(sessionId, sink): () => void {
      const canonical = aliases.resolve(sessionId)
      const { harnessId } = parseSessionId(canonical)
      const driver = drivers.get(harnessId)
      if (!driver) {
        throw new HarnessError('invalid_session_id', `no driver registered for ${harnessId}`, {
          harnessId,
          sessionId: canonical,
        })
      }
      const sub: SessionSubscription = {
        harnessId,
        current: canonical,
        sink,
        deliver: (event) => {
          // The driver's own copy of a rotation event: forward it only if the
          // re-key above has not already handed the client this rotation.
          if (event.type === 'session-updated' && event.previousSessionId) {
            const key = rotationKey(event.previousSessionId, event.sessionId)
            if (sub.delivered.has(key)) return
            remember(sub, key)
          }
          push(sub, event)
        },
        off: (): void => undefined,
        delivered: new Set<string>(),
        closed: false,
      }
      // Deliberately outside a try: a driver that cannot serve a live tail
      // rejects here (`capability_unsupported`) and the caller answers on the
      // wire, exactly as a direct `driver.subscribe` did.
      sub.off = driver.subscribe(canonical, sub.deliver)
      sessionSubs.add(sub)
      return () => {
        if (sub.closed) return
        sub.closed = true
        sessionSubs.delete(sub)
        try {
          sub.off()
        } catch {
          /* unsubscribing twice must never throw at the caller */
        }
      }
    },

    close(): void {
      for (const sub of [...sessionSubs]) {
        sub.closed = true
        try {
          sub.off()
        } catch {
          /* shutdown is best-effort */
        }
      }
      sessionSubs.clear()
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
