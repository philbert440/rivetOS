/**
 * Whether the connected node serves the workflows API at all. The RivetHub
 * runtime does not mount /api/workflows or /api/workflow-runs (workflows run
 * from a separate service), so those routes answer 404. The defs list is the
 * probe: a 404 there means "not on this node", which is a steady state — no
 * retry, no polling, and the dependent run/def queries never fire.
 */

import { GatewayError } from '@rivetos/gateway-client'

export type WorkflowsAvailability = 'checking' | 'available' | 'unavailable' | 'error'

export function isWorkflowsRouteMissing(error: unknown): boolean {
  return error instanceof GatewayError && error.status === 404
}

export function workflowsAvailability(query: {
  data?: unknown
  error: unknown
}): WorkflowsAvailability {
  if (isWorkflowsRouteMissing(query.error)) return 'unavailable'
  if (query.data !== undefined) return 'available'
  if (query.error) return 'error'
  return 'checking'
}

/** One retry for transient failures; a 404 is an answer, not a failure. */
export function retryUnlessNotFound(failureCount: number, error: Error): boolean {
  return !isWorkflowsRouteMissing(error) && failureCount < 1
}

/** Poll at `ms` until the node says it has no workflows API. */
export function pollUnlessMissing(
  ms: number,
): (query: { state: { error: unknown } }) => number | false {
  return (query) => (isWorkflowsRouteMissing(query.state.error) ? false : ms)
}
