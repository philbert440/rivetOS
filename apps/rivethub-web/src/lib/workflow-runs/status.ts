/**
 * Status chips / colors for workflow runs — mirrors tasks.tsx STATUS_COLORS.
 */

import type { WorkflowRunStatus } from '@rivetos/types'

export const RUN_STATUS_COLORS: Record<WorkflowRunStatus, string> = {
  running: 'text-em',
  paused_human: 'text-em',
  done: 'text-em-dim',
  failed: 'text-red',
  killed: 'text-red',
}

export const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: 'running',
  paused_human: 'paused (gate)',
  done: 'done',
  failed: 'failed',
  killed: 'killed',
}

/** Whether the run is still live and worth polling. */
export function isLiveRunStatus(status: string | undefined): boolean {
  return status === 'running' || status === 'paused_human'
}
