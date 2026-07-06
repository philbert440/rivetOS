/**
 * Delegation runs recorder interface — best-effort observability for
 * DelegationEngine. Since g2a the production implementation is the
 * task-backed recorder (task/delegation-task-recorder.ts) writing terminal
 * ros_tasks rows; ros_delegation_runs is archived (0003). The noop stands in
 * for tests / pgUrl-less dev.
 */

import type { DelegationRequest, DelegationResult } from '@rivetos/types'

export interface DelegationRunsRecorder {
  record(
    request: DelegationRequest,
    result: DelegationResult,
    opts: { chainDepth: number; cached: boolean; startedAt: number },
  ): Promise<void>
}

/** No-op recorder for tests / pgUrl-less dev. */
export const noopDelegationRecorder: DelegationRunsRecorder = {
  record(): Promise<void> {
    return Promise.resolve()
  },
}
