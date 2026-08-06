/**
 * Status chips / colors for workflow runs — mirrors tasks.tsx STATUS_COLORS.
 * Graph node statuses extend the same palette (do not fork).
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

// ---------------------------------------------------------------------------
// Graph node status (slice H projection) — reuses run color semantics
// ---------------------------------------------------------------------------

/**
 * Per-node status on the outline/journal graph projection.
 * Distinct from WorkflowRunStatus: nodes can be pending (outline-only)
 * or gate-open / gate-resolved while the run is paused_human / running.
 */
export type GraphNodeStatus =
  'pending' | 'running' | 'done' | 'failed' | 'gate-open' | 'gate-resolved'

/** Tailwind text color classes — same tokens as RUN_STATUS_COLORS. */
export const GRAPH_NODE_STATUS_COLORS: Record<GraphNodeStatus, string> = {
  pending: 'text-ink-dim',
  running: 'text-em',
  done: 'text-em-dim',
  failed: 'text-red',
  'gate-open': 'text-em',
  'gate-resolved': 'text-em-dim',
}

export const GRAPH_NODE_STATUS_LABELS: Record<GraphNodeStatus, string> = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  'gate-open': 'gate open',
  'gate-resolved': 'gate resolved',
}

/**
 * Stroke / fill tokens for inline SVG (no Tailwind on SVG attrs).
 * Values match theme.css --color-* so the graph stays theme-aware.
 */
export const GRAPH_NODE_STATUS_STROKE: Record<GraphNodeStatus, string> = {
  pending: 'var(--color-line)',
  running: 'var(--color-em)',
  done: 'var(--color-em-dim)',
  failed: 'var(--color-red)',
  'gate-open': 'var(--color-em)',
  'gate-resolved': 'var(--color-em-dim)',
}
