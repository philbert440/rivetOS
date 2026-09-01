/**
 * HarnessDriver registry — the node's control plane (Phase 2).
 *
 * Drivers register at boot; the gateway resolves every request through here
 * and never touches a harness binary itself. The registry owns the three jobs
 * the contract calls "control-plane-owned":
 *
 *   - **Driver lookup + capability sheet** (`GET /api/harnesses`), including
 *     the runtime truthing that makes the sheet honest: `verifyCapabilities`
 *     probes each driver's machinery before the flags are advertised, and a
 *     flag that flips afterwards is fanned to registry-stream clients
 *     (`capabilities.ts`).
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
import { asCapabilitySource, type HarnessCapabilityEvent } from './capabilities.js'

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
  /**
   * Drivers + capability flags — the `GET /api/harnesses` body.
   *
   * Reports each driver's sheet **as of now**. Callers that are about to
   * ADVERTISE those flags should `await verifyCapabilities()` first, so what
   * they publish is what the node can do rather than what it was configured to
   * hope (`capabilities.ts`).
   */
  list(): HarnessDescriptor[]
  /**
   * Runtime-truth every driver's capability sheet: each driver that implements
   * the truthing surface probes its machinery once and latches the answer.
   * Cheap after the first call, never rejects — a driver that cannot answer
   * keeps the flags it has.
   */
  verifyCapabilities(harnessId?: HarnessId): Promise<void>
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
   * Append-only `supersedes` lineage recorded for a session (immutable
   * session ids, plan W1 stage 1): every supersedes edge the control plane
   * accepted for `sessionId`, oldest-first. A field on the session record,
   * not an alias chain — edges do NOT occupy the alias namespace, do not
   * re-key subscriptions, and retire nothing.
   */
  supersedesFor(sessionId: SessionId): SessionId[]
  /**
   * Mark `sessionId` as client-minted (plan W1 keystone: THE id never
   * changes). A legacy `previousSessionId` rotation naming a minted session —
   * or any session that already carries supersedes lineage — is refused:
   * dropped with one warning, the canonical id unchanged.
   */
  noteMinted(sessionId: SessionId): void
  /**
   * Guard a caller-pinned `startSession` id against every namespace the
   * control plane owns (§ Collision rules):
   *
   *   - **Alias chains** — a native id matching ANY chain member is a
   *     collision even if the harness store itself has forgotten it
   *     (rule 3);
   *   - **Supersedes lineage** — a past native incarnation of a live session
   *     is taken for as long as the lineage remembers it. "Not an alias" means
   *     an edge resolves nowhere and retires nothing; it does NOT mean the
   *     native is mintable again (plan W1);
   *   - **The live harness store** — an id that is already a live session
   *     (its canonical id, or the current native under one) can never be
   *     minted over: that is takeover, not creation.
   *
   * @throws HarnessError `session_id_collision` | `invalid_session_id`
   */
  assertPinnable(harnessId: HarnessId, nativeSessionId: string): Promise<void>
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
   * Capability flips across every driver (or one, when filtered) — a flag that
   * changes AFTER it was advertised. A den-level frame rather than a
   * `HarnessEvent`: the contract's union is session-scoped and a driver-level
   * flip has no session to name (see `capabilities.ts`).
   */
  subscribeCapabilities(
    sink: (e: HarnessCapabilityEvent) => void,
    harnessId?: HarnessId,
  ): () => void
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

export function createHarnessRegistry(
  opts: { aliases?: AliasStore; log?: (msg: string) => void } = {},
): HarnessRegistry {
  const drivers = new Map<HarnessId, HarnessDriver>()
  const aliases = opts.aliases ?? createAliasStore()
  const log = opts.log ?? ((): void => undefined)
  const sinks = new Set<{ harnessId?: HarnessId; sink: (e: HarnessEvent) => void }>()
  const capabilitySinks = new Set<{
    harnessId?: HarnessId
    sink: (e: HarnessCapabilityEvent) => void
  }>()
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
  /**
   * Supersedes lineage (plan W1 stage 1): canonical id → accepted edges,
   * oldest-first. Deliberately NOT the alias store — a supersedes edge leaves
   * the session's id unchanged, so nothing here may resolve, re-key, or
   * retire. Append-only for the life of the process.
   *
   * PROCESS-LOCAL BY DESIGN: like the alias store, this Map dies with the
   * process and is not rebuilt at boot. Durable lineage (a supersedes
   * breadcrumb analog to `alias-restore.ts`) is stage 3's problem, not stage
   * 1's — until then a restarted node simply starts a fresh log.
   */
  const lineage = new Map<SessionId, SessionId[]>()
  /**
   * Ids that entered via the client-minted path (plan W1 keystone: immutable
   * session ids). A legacy `previousSessionId` rotation naming one — or one
   * naming a session that already has supersedes lineage — is refused.
   */
  const minted = new Set<SessionId>()

  /**
   * Record one supersedes edge. Same-harness only, exactly like rotation
   * aliases (§ Rotation, rule 8) — a cross-harness edge is a driver bug and is
   * dropped, never forced in. A self-edge is legal: the first rotation off a
   * client-minted id supersedes the canonical id itself.
   *
   * Lineage is a LOG, not a chain: append-only, and only the tail dedupes
   * (re-emitting the current tail edge is an idempotent no-op, mirroring the
   * alias store). Re-emitting a non-tail edge — or a cycle A → B → A —
   * appends another entry, deliberately: the log records what the driver
   * SAID, in order, and since nothing here resolves, re-keys, or retires, a
   * repeated edge is history, not corruption.
   *
   * Returns `false` when the edge was DROPPED (cross-harness or malformed),
   * so the caller can strip the field from the fanned-out event — the control
   * plane already decided the edge is junk, and a consumer that trusts the
   * field without repeating the same-harness check would record it.
   */
  const recordSupersedes = (sessionId: SessionId, supersedes: SessionId): boolean => {
    try {
      if (parseSessionId(sessionId).harnessId !== parseSessionId(supersedes).harnessId) {
        return false
      }
    } catch {
      return false // malformed edge — dropped; the caller strips it from the wire copy
    }
    const edges = lineage.get(sessionId) ?? []
    if (edges[edges.length - 1] === supersedes) return true
    edges.push(supersedes)
    lineage.set(sessionId, edges)
    return true
  }

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

  const fanoutCapabilities = (event: HarnessCapabilityEvent): void => {
    for (const entry of [...capabilitySinks]) {
      if (entry.harnessId && entry.harnessId !== event.harnessId) continue
      try {
        entry.sink(event)
      } catch {
        /* as above */
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
      // Capability flips, for drivers that runtime-truth their flags. Tailed
      // exactly like the registry stream and fanned to the same WS clients —
      // feature-detected, so a driver without the surface simply never flips
      // (`capabilities.ts`).
      const capabilities = asCapabilitySource(driver)
      const offCapabilities = capabilities?.subscribeCapabilities((event) =>
        fanoutCapabilities(event),
      )
      // Tail the driver's registry stream: rotation aliases are recorded here
      // (never in the driver) and the event is then fanned to WS clients.
      const offEvents = driver.subscribeEvents((event) => {
        let rotated: SessionId | undefined
        if (
          event.type === 'session-updated' &&
          event.previousSessionId &&
          // A driver restating its own id is a status update, not a
          // rotation: the store no-ops it, and treating it as one would
          // retire a live session on the stream.
          event.previousSessionId !== event.sessionId
        ) {
          if (minted.has(event.previousSessionId) || lineage.has(event.previousSessionId)) {
            // REFUSE (plan W1 keystone): this session's canonical id is
            // immutable — it entered via the client-minted path or already
            // carries supersedes lineage — so a legacy `previousSessionId`
            // rotation for it is dropped with one warning. The id does NOT
            // change: no alias, no re-key, no retirement. A mid-stream event
            // cannot 4xx, so the event itself still fans out below; a
            // consumer that only watches ids reads it as a status tick.
            log(
              `[den-server] ${harnessId}: dropped legacy rotation of immutable session ` +
                `${event.previousSessionId} → ${event.sessionId}; canonical id unchanged`,
            )
          } else {
            try {
              aliases.record(event.previousSessionId, event.sessionId)
              rotated = event.previousSessionId
            } catch {
              // Cross-harness, cyclic, or a second successor for an id that
              // already rotated — all driver bugs. Drop the alias but still
              // deliver the event so clients see the status.
            }
          }
        }
        // The event as fanned out: verbatim what the driver emitted, EXCEPT
        // that a supersedes edge the control plane rejected is stripped —
        // the plane already decided the edge is junk, and a consumer that
        // trusts the field without repeating the same-harness check would
        // record a bad edge.
        let wire: HarnessEvent = event
        if (
          (event.type === 'session-updated' || event.type === 'session-created') &&
          event.supersedes !== undefined
        ) {
          // Supersedes lineage (plan W1): the canonical id does not change,
          // so there is nothing to alias, re-key, or retire — record the edge
          // and let the event fan out. Independent of the legacy rotation
          // path above: an event carrying both gets both treatments.
          if (!recordSupersedes(event.sessionId, event.supersedes)) {
            wire = { ...event }
            delete (wire as { supersedes?: SessionId }).supersedes
          }
        }
        // Re-key live tails BEFORE the fanout: the rotation event reaches
        // per-session subscribers through their own (now moved) sink, and a
        // registry subscriber that reacts synchronously to the fanout must
        // already see the post-rotation world.
        if (rotated && wire.type === 'session-updated') rekey(harnessId, rotated, wire)
        fanout(harnessId, wire)
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
      })
      detach.set(harnessId, () => {
        offEvents()
        offCapabilities?.()
      })
    },

    get: (harnessId) => (isHarnessId(harnessId) ? drivers.get(harnessId) : undefined),

    list: () =>
      [...drivers.values()].map((d) => ({
        harnessId: d.harnessId,
        capabilities: d.capabilities,
      })),

    async verifyCapabilities(harnessId): Promise<void> {
      const targets = harnessId
        ? [drivers.get(harnessId)].filter((d) => d !== undefined)
        : [...drivers.values()]
      await Promise.all(
        targets.map(async (driver) => {
          // A driver's probe is its own contract to keep quiet about failure;
          // the catch is for a driver that breaks that promise. Advertising a
          // stale flag beats failing the request that asked for the sheet.
          await asCapabilitySource(driver)
            ?.verifyCapabilities()
            .catch(() => undefined)
        }),
      )
    },

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

    supersedesFor: (sessionId) => [...(lineage.get(sessionId) ?? [])],

    noteMinted: (sessionId) => {
      minted.add(sessionId)
    },

    async assertPinnable(harnessId, nativeSessionId): Promise<void> {
      const pinned = formatSessionId(harnessId, nativeSessionId)
      if (aliases.knows(pinned)) {
        throw new HarnessError(
          'session_id_collision',
          `${pinned} is already part of an alias chain`,
          { harnessId, sessionId: pinned },
        )
      }
      // Supersedes lineage occupies the namespace too (plan W1): "not an
      // alias" means an edge resolves nowhere and retires nothing — it does
      // NOT mean the native is mintable. Every native a lineage names is a
      // past incarnation of a session, so minting over it would graft a new
      // session onto that history.
      for (const edges of lineage.values()) {
        if (edges.includes(pinned)) {
          throw new HarnessError(
            'session_id_collision',
            `${pinned} is already part of a supersedes lineage`,
            { harnessId, sessionId: pinned },
          )
        }
      }
      // The live harness store itself: a session that never rotated sits in
      // no alias chain and no lineage, yet its id — the canonical id, or the
      // current native under one — is taken. Minting over it would ATTACH to
      // (take over) the existing session, so check the store before dispatch.
      // A probe failure reads as "not live", the same tradeoff as resolve()'s
      // bare-uuid probe: a driver that cannot answer must not 500 every
      // pinned create.
      const driver = drivers.get(harnessId)
      const existing = driver ? await driver.getSession(pinned).catch(() => null) : null
      if (existing) {
        throw new HarnessError('session_id_collision', `${pinned} is already a live session`, {
          harnessId,
          sessionId: pinned,
        })
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
      //
      // The lineage field is CONTROL-PLANE-OWNED here: the latest recorded
      // supersedes edge is stamped onto every row, so a driver that emits
      // `session-updated` without updating its own list row cannot make the
      // record and the list disagree (the row the driver keeps is its own;
      // this list is ours).
      const byCanonical = new Map<SessionId, HarnessSessionSummary>()
      for (const row of await driver.listSessions()) {
        let canonical: SessionId
        try {
          canonical = aliases.resolve(row.sessionId)
        } catch {
          canonical = row.sessionId // broken chain: report it as the driver sees it
        }
        const rewritten = canonical === row.sessionId ? row : { ...row, sessionId: canonical }
        const edges = lineage.get(canonical)
        const latest = edges?.[edges.length - 1]
        const merged = latest !== undefined ? { ...rewritten, supersedes: latest } : rewritten
        if (byCanonical.has(canonical) && canonical !== row.sessionId) continue
        byCanonical.set(canonical, merged)
      }
      return [...byCanonical.values()]
    },

    subscribe(sink, harnessId): () => void {
      const entry = { harnessId, sink }
      sinks.add(entry)
      return () => sinks.delete(entry)
    },

    subscribeCapabilities(sink, harnessId): () => void {
      const entry = { harnessId, sink }
      capabilitySinks.add(entry)
      return () => capabilitySinks.delete(entry)
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
      lineage.clear()
      minted.clear()
      for (const off of detach.values()) {
        try {
          off()
        } catch {
          /* shutdown is best-effort */
        }
      }
      detach.clear()
      sinks.clear()
      capabilitySinks.clear()
      drivers.clear()
    },
  }
}

/** Convenience re-export so route code has one import for the wire shape. */
export type { HarnessSessionSummary }
