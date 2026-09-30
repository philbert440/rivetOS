/**
 * How often the task detail page refetches. A parked approval denies on a
 * short timer (default 60s), so that case polls at 2s. Every other live
 * task stays on 10s. A 400 or 404 means the row is gone — stop.
 */

import { GatewayError } from '@rivetos/gateway-client'

const FAST_MS = 2_000
const SLOW_MS = 10_000

const TERMINAL = new Set(['completed', 'failed', 'killed', 'timeout'])

export function taskDetailRefetchInterval(input: {
  error: unknown
  task?: { status?: string; pendingApprovals?: readonly unknown[] }
}): number | false {
  const gone =
    input.error instanceof GatewayError &&
    (input.error.status === 400 || input.error.status === 404)
  if (gone) return false
  const pending = input.task?.pendingApprovals?.length ?? 0
  const terminal = input.task?.status !== undefined && TERMINAL.has(input.task.status)
  if (input.task && pending > 0 && !terminal) return FAST_MS
  return SLOW_MS
}
