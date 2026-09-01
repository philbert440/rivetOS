/**
 * Capability **runtime truthing** — the den-side half of the honest-flags rule
 * (docs/ARCHITECTURE.md § Capability flags (as wired)).
 *
 * The gap this closes: a driver computes its flags once, at construction. The
 * PTY drivers read `interrupt`/`resume` off whether den terminals are
 * **enabled**, which is a config question, not a runtime one — if `node-pty`
 * then fails to load, `GET /api/harnesses` keeps advertising `true` while the
 * methods answer 501. The rejection was always honest; the advertisement was
 * optimistic.
 *
 * Truthing is two moves, and a driver opts into them by implementing this
 * interface — **feature-detected, exactly like `transcript`**, so nothing is
 * added to the `HarnessDriver` contract in `@rivetos/types`:
 *
 *   1. **`verifyCapabilities()`** — ask the machinery, latch the answer. The
 *      control plane calls it before it advertises (`GET /api/harnesses`,
 *      `GET /api/harnesses/:id`, and on a registry-stream attach), so the sheet
 *      a client reads is what the node can do at the moment it is read.
 *   2. **`subscribeCapabilities()`** — a flag that flips AFTER it was
 *      advertised surfaces on the registry stream, so a UI that gated a button
 *      on `interrupt: true` learns the button is now dead without polling.
 *
 * **Why a den-level frame and not a `HarnessEvent`.** Every member of the
 * contract's event union carries a `sessionId`: the union is session-scoped by
 * construction, and a driver-level capability flip has no session to name.
 * Minting one would be a lie, and `session-updated` on a fabricated id is
 * worse than silence. Adding a `capabilities-changed` member is a contract
 * addition, deliberately NOT made here — the registry socket already carries
 * non-union frames (the `attach` error frame in `routes.ts`), so the flip rides
 * that same socket as a den-level frame. Clients discriminate on `type` and
 * ignore what they do not know (the Android parser maps unknown types to
 * `Unknown`; the web fold has a default case). If another transport ever needs
 * this driver-level, promoting it to the union is the follow-up — and a real
 * contract change, with the version bump that implies.
 */

import type { HarnessCapabilities, HarnessDriver, HarnessId } from '@rivetos/types'

/**
 * Registry-stream frame announcing that a driver's capability sheet changed.
 *
 * Deliberately NOT a `HarnessEvent` — see the module header. `capabilities` is
 * the full sheet (a client replaces its copy rather than patching), `changed`
 * names only the flags whose value moved, and `reason` is the node's own
 * explanation, meant for a log line or a tooltip.
 */
export interface HarnessCapabilityEvent {
  type: 'harness-capabilities'
  harnessId: HarnessId
  capabilities: HarnessCapabilities
  changed: Partial<HarnessCapabilities>
  reason: string
}

/** The truthing surface a driver may implement. Feature-detected, never required. */
export interface HarnessCapabilitySource {
  /**
   * Probe the machinery behind the flags and return the sheet as it is NOW.
   * Cheap after the first call (drivers latch the verdict) and must never
   * throw: a probe that cannot answer reports the pessimistic flag rather than
   * failing the request that asked.
   */
  verifyCapabilities(): Promise<HarnessCapabilities>
  /** Flip notices for this driver. Returns unsubscribe. */
  subscribeCapabilities(sink: (e: HarnessCapabilityEvent) => void): () => void
}

/** Narrow a driver to its truthing surface, or `undefined` if it has none. */
export function asCapabilitySource(driver: HarnessDriver): HarnessCapabilitySource | undefined {
  const candidate = driver as unknown as Partial<HarnessCapabilitySource>
  return typeof candidate.verifyCapabilities === 'function' &&
    typeof candidate.subscribeCapabilities === 'function'
    ? (candidate as HarnessCapabilitySource)
    : undefined
}

/** Which flags differ, as a patch of `next` over `previous`. Empty = no flip. */
export function capabilityDiff(
  previous: HarnessCapabilities,
  next: HarnessCapabilities,
): Partial<HarnessCapabilities> {
  const changed: Partial<HarnessCapabilities> = {}
  for (const key of Object.keys(next) as (keyof HarnessCapabilities)[]) {
    if (previous[key] !== next[key]) changed[key] = next[key]
  }
  return changed
}
