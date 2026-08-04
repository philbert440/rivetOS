/**
 * Seed workflow definitions for the Workflows UI (no gateway).
 */

import type { WorkflowDefinition } from './types.js'

/** Multi-step PR review → verify → human gate → merge/escalate. */
export const PR_REVIEW_GATE: WorkflowDefinition = {
  id: 'pr-review-gate',
  name: 'PR review + gate',
  description:
    'Ingest a PR, agent review, static checks, human gate, then merge or escalate. Fixture for the Workflows canvas MVP.',
  version: 1,
  nodes: [
    {
      id: 'ingest',
      kind: 'source',
      label: 'Ingest PR',
      description: 'Fetch PR metadata and diff from GitHub.',
      position: { x: 40, y: 160 },
      capability: 'read-only',
      tools: ['github_pr_get'],
      inputs: [],
      outputs: [
        { id: 'doc', name: 'PR bundle', direction: 'out', kind: 'data' },
      ],
    },
    {
      id: 'review',
      kind: 'agent',
      label: 'Agent review',
      description: 'Multi-dimension code review with structured findings.',
      position: { x: 280, y: 160 },
      // Fixture deliberately uses read-write so the UI shows more than one capability.
      capability: 'read-write',
      toolProfile: 'code-review',
      inputs: [
        { id: 'doc', name: 'PR bundle', direction: 'in', kind: 'data', required: true },
      ],
      outputs: [
        { id: 'findings', name: 'Findings', direction: 'out', kind: 'data' },
      ],
    },
    {
      id: 'verify',
      kind: 'verify',
      label: 'Static checks',
      description: 'Lint + typecheck as fail-closed evidence gate.',
      position: { x: 520, y: 80 },
      capability: 'execute',
      tools: ['lint', 'typecheck'],
      inputs: [
        { id: 'findings', name: 'Findings', direction: 'in', kind: 'data', required: true },
      ],
      outputs: [
        { id: 'report', name: 'Verify report', direction: 'out', kind: 'data' },
      ],
    },
    {
      id: 'gate',
      kind: 'gate',
      label: 'Human gate',
      description: 'Pause for approval when severity warrants human judgment.',
      position: { x: 760, y: 160 },
      capability: 'read-only',
      inputs: [
        { id: 'report', name: 'Verify report', direction: 'in', kind: 'data', required: true },
      ],
      outputs: [
        { id: 'pass', name: 'Approved', direction: 'out', kind: 'control' },
        { id: 'fail', name: 'Rejected', direction: 'out', kind: 'control' },
      ],
    },
    {
      id: 'merge',
      kind: 'action',
      label: 'Merge',
      description: 'Merge the PR after approval.',
      position: { x: 1000, y: 80 },
      capability: 'all',
      tools: ['github_pr_merge'],
      inputs: [
        { id: 'ok', name: 'Approval', direction: 'in', kind: 'control', required: true },
      ],
      outputs: [
        { id: 'result', name: 'Merge result', direction: 'out', kind: 'data' },
      ],
    },
    {
      id: 'escalate',
      kind: 'sink',
      label: 'Escalate',
      description: 'Open a follow-up task / notification when rejected.',
      position: { x: 1000, y: 240 },
      capability: 'read-only',
      tools: ['create_task'],
      inputs: [
        { id: 'ok', name: 'Rejection', direction: 'in', kind: 'control', required: true },
      ],
      outputs: [],
    },
  ],
  edges: [
    {
      id: 'e-ingest-review',
      from: { nodeId: 'ingest', portId: 'doc' },
      to: { nodeId: 'review', portId: 'doc' },
    },
    {
      id: 'e-review-verify',
      from: { nodeId: 'review', portId: 'findings' },
      to: { nodeId: 'verify', portId: 'findings' },
    },
    {
      id: 'e-verify-gate',
      from: { nodeId: 'verify', portId: 'report' },
      to: { nodeId: 'gate', portId: 'report' },
    },
    {
      id: 'e-gate-merge',
      from: { nodeId: 'gate', portId: 'pass' },
      to: { nodeId: 'merge', portId: 'ok' },
    },
    {
      id: 'e-gate-escalate',
      from: { nodeId: 'gate', portId: 'fail' },
      to: { nodeId: 'escalate', portId: 'ok' },
    },
  ],
}

/** Memory wiki recompile path — second fixture so the library is not a singleton. */
export const WIKI_RECOMPILE: WorkflowDefinition = {
  id: 'wiki-recompile-hot',
  name: 'Wiki recompile (hot topics)',
  description:
    'Pull stale wiki gaps, recompile article bodies, write-back via PR culture. Graph-aware Memory I/O sketch.',
  version: 1,
  nodes: [
    {
      id: 'gaps',
      kind: 'source',
      label: 'List gaps',
      position: { x: 48, y: 120 },
      capability: 'read-only',
      tools: ['wiki_gaps'],
      inputs: [],
      outputs: [{ id: 'topics', name: 'Topic slugs', direction: 'out', kind: 'data' }],
    },
    {
      id: 'recompile',
      kind: 'agent',
      label: 'Recompile articles',
      position: { x: 320, y: 120 },
      capability: 'read-only',
      // Prefer explicit tools over a parallel profile (one source of truth on the card).
      tools: ['wiki_read', 'memory_search'],
      inputs: [
        { id: 'topics', name: 'Topic slugs', direction: 'in', kind: 'data', required: true },
      ],
      outputs: [
        { id: 'patches', name: 'Article patches', direction: 'out', kind: 'data' },
      ],
    },
    {
      id: 'write',
      kind: 'action',
      label: 'Apply patches',
      position: { x: 600, y: 120 },
      capability: 'read-write',
      tools: ['wiki_apply_patch'],
      inputs: [
        { id: 'patches', name: 'Article patches', direction: 'in', kind: 'data', required: true },
      ],
      outputs: [
        { id: 'result', name: 'Write result', direction: 'out', kind: 'data' },
      ],
    },
  ],
  edges: [
    {
      id: 'e-gaps-recompile',
      from: { nodeId: 'gaps', portId: 'topics' },
      to: { nodeId: 'recompile', portId: 'topics' },
    },
    {
      id: 'e-recompile-write',
      from: { nodeId: 'recompile', portId: 'patches' },
      to: { nodeId: 'write', portId: 'patches' },
    },
  ],
}

const CATALOG: readonly WorkflowDefinition[] = [PR_REVIEW_GATE, WIKI_RECOMPILE]

/** All fixture workflow definitions (immutable catalog). */
export function listWorkflows(): readonly WorkflowDefinition[] {
  return CATALOG
}

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return CATALOG.find((w) => w.id === id)
}
