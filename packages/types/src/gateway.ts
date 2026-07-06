/**
 * Gateway contract — the per-node HTTP/WS surface (Appendix F, PR G0).
 *
 * The gateway is the den server embedded in the rivetos process, grown one
 * route family at a time (G1 /api/tasks, G2 /api/events aliases, …). Later
 * PRs mount routes through GatewayRoute rather than editing the den router,
 * so each API family stays an independently reviewable unit.
 *
 * Auth: bearer token per node (private-LAN posture — mesh mTLS stays on the
 * agent channel; per-device tokens layer on in phase 4). Routes mounted here
 * sit BEHIND the gateway's bearer gate; /healthz and the static viewer stay
 * open, matching the den server's existing rules.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface GatewayRoute {
  /**
   * Path prefix this route owns, e.g. '/api/tasks'. Longest prefix wins;
   * the handler sees every method under it and owns its own sub-routing.
   */
  prefix: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Handle returned by the embedded gateway — G1+ mount points + lifecycle. */
export interface GatewayHandle {
  /** Bound port (0 until listening). */
  port: number
  close(): Promise<void>
}
