import { describe, it, expect } from 'vitest'
import type { WorkflowJournalEntry, WorkflowOutlineStep } from '@rivetos/types'
import { projectGraph } from './graph-project.js'

const OUTLINE: WorkflowOutlineStep[] = [
  { id: 'load', label: 'Load PR', kind: 'run' },
  { id: 'review', label: 'Review', kind: 'agent' },
  { id: 'approve', label: 'Approve', kind: 'human' },
  { id: 'done', label: 'Done', kind: 'done' },
]

function je(partial: Record<string, unknown>): WorkflowJournalEntry {
  return partial as WorkflowJournalEntry
}

describe('projectGraph', () => {
  it('outline-only (fresh run): all pending, declared edges', () => {
    const { nodes, edges } = projectGraph(OUTLINE, [])
    expect(nodes).toHaveLength(4)
    expect(nodes.every((n) => n.status === 'pending')).toBe(true)
    expect(nodes.every((n) => n.fromOutline && !n.fromJournal)).toBe(true)
    expect(edges.length).toBeGreaterThanOrEqual(3)
    expect(edges.every((e) => e.kind === 'declared')).toBe(true)
    expect(edges.map((e) => `${e.from}→${e.to}`)).toEqual([
      'load→review',
      'review→approve',
      'approve→done',
    ])
  })

  it('journal-only (no outline): nodes from journal, execution edges', () => {
    const journal: WorkflowJournalEntry[] = [
      je({ type: 'run_started', ts: 't0', workflowId: 'w' }),
      je({ type: 'step_started', ts: 't1', label: 'a', stepId: 'a#1', seq: 1, kind: 'run' }),
      je({
        type: 'step_finished',
        ts: 't2',
        label: 'a',
        stepId: 'a#1',
        seq: 1,
        kind: 'run',
        result: {},
      }),
      je({ type: 'step_started', ts: 't3', label: 'b', stepId: 'b#1', seq: 1, kind: 'agent' }),
      je({
        type: 'step_finished',
        ts: 't4',
        label: 'b',
        stepId: 'b#1',
        seq: 1,
        kind: 'agent',
        result: {},
      }),
    ]
    const { nodes, edges } = projectGraph(undefined, journal)
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(nodes.every((n) => n.status === 'done')).toBe(true)
    expect(nodes.every((n) => n.fromJournal && !n.fromOutline)).toBe(true)
    expect(edges).toEqual([
      expect.objectContaining({ from: 'a', to: 'b', kind: 'execution' }),
    ])
  })

  it('loop folding: label#1..n → one node with iteration badge', () => {
    const journal: WorkflowJournalEntry[] = [
      je({ type: 'step_started', ts: 't1', label: 'loop-body', stepId: 'loop-body#1', seq: 1, kind: 'run' }),
      je({
        type: 'step_finished',
        ts: 't2',
        label: 'loop-body',
        stepId: 'loop-body#1',
        seq: 1,
        kind: 'run',
        result: {},
      }),
      je({ type: 'step_started', ts: 't3', label: 'loop-body', stepId: 'loop-body#2', seq: 2, kind: 'run' }),
      je({
        type: 'step_finished',
        ts: 't4',
        label: 'loop-body',
        stepId: 'loop-body#2',
        seq: 2,
        kind: 'run',
        result: {},
      }),
      je({ type: 'step_started', ts: 't5', label: 'loop-body', stepId: 'loop-body#3', seq: 3, kind: 'run' }),
      je({
        type: 'step_finished',
        ts: 't6',
        label: 'loop-body',
        stepId: 'loop-body#3',
        seq: 3,
        kind: 'run',
        result: {},
      }),
    ]
    const { nodes } = projectGraph([{ id: 'loop-body', kind: 'run' }], journal)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe('loop-body')
    expect(nodes[0].iterations).toBe(3)
    expect(nodes[0].status).toBe('done')
    expect(nodes[0].fromOutline && nodes[0].fromJournal).toBe(true)
  })

  it('mixed declared + undeclared: outline seed + journal-only step', () => {
    const journal: WorkflowJournalEntry[] = [
      je({ type: 'step_started', ts: 't1', label: 'load', stepId: 'load#1', seq: 1, kind: 'run' }),
      je({
        type: 'step_finished',
        ts: 't2',
        label: 'load',
        stepId: 'load#1',
        seq: 1,
        kind: 'run',
        result: {},
      }),
      // undeclared dynamic step
      je({
        type: 'step_started',
        ts: 't3',
        label: 'extra-fixup',
        stepId: 'extra-fixup#1',
        seq: 1,
        kind: 'agent',
      }),
      je({
        type: 'step_finished',
        ts: 't4',
        label: 'extra-fixup',
        stepId: 'extra-fixup#1',
        seq: 1,
        kind: 'agent',
        result: {},
      }),
    ]
    const { nodes, edges } = projectGraph(OUTLINE, journal)
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
    expect(byId.load.status).toBe('done')
    expect(byId.load.fromOutline).toBe(true)
    expect(byId['extra-fixup'].fromOutline).toBe(false)
    expect(byId['extra-fixup'].fromJournal).toBe(true)
    expect(byId.review.status).toBe('pending')
    // execution edge load → extra-fixup
    expect(edges.some((e) => e.from === 'load' && e.to === 'extra-fixup' && e.kind === 'execution')).toBe(
      true,
    )
    // declared bridge / pending tail
    expect(edges.some((e) => e.kind === 'declared' && e.to === 'review')).toBe(true)
  })

  it('gate states: gate-open and gate-resolved', () => {
    const openJournal: WorkflowJournalEntry[] = [
      je({ type: 'step_started', ts: 't1', label: 'approve', stepId: 'approve#1', seq: 1, kind: 'human' }),
      je({
        type: 'gate_opened',
        ts: 't2',
        label: 'approve',
        stepId: 'approve#1',
        seq: 1,
        fields: ['ok'],
        prompt: '?',
      }),
    ]
    const open = projectGraph(OUTLINE, openJournal)
    expect(open.nodes.find((n) => n.id === 'approve')?.status).toBe('gate-open')
    expect(open.nodes.find((n) => n.id === 'approve')?.kind).toBe('human')

    const resolvedJournal: WorkflowJournalEntry[] = [
      ...openJournal,
      je({
        type: 'gate_resolved',
        ts: 't3',
        label: 'approve',
        stepId: 'approve#1',
        seq: 1,
        values: { ok: true },
      }),
    ]
    const resolved = projectGraph(OUTLINE, resolvedJournal)
    expect(resolved.nodes.find((n) => n.id === 'approve')?.status).toBe('gate-resolved')
  })

  it('running vs failed vs done', () => {
    const running = projectGraph(undefined, [
      je({ type: 'step_started', ts: 't', label: 'x', stepId: 'x#1', seq: 1, kind: 'agent' }),
    ])
    expect(running.nodes[0].status).toBe('running')

    const failed = projectGraph(undefined, [
      je({ type: 'step_started', ts: 't1', label: 'x', stepId: 'x#1', seq: 1, kind: 'agent' }),
      je({
        type: 'step_failed',
        ts: 't2',
        label: 'x',
        stepId: 'x#1',
        seq: 1,
        kind: 'agent',
        error: 'boom',
      }),
    ])
    expect(failed.nodes[0].status).toBe('failed')
  })

  it('call steps carry childRunId when journaled on result', () => {
    const journal: WorkflowJournalEntry[] = [
      je({ type: 'step_started', ts: 't1', label: 'pr-review', stepId: 'pr-review#1', seq: 1, kind: 'call' }),
      je({
        type: 'step_finished',
        ts: 't2',
        label: 'pr-review',
        stepId: 'pr-review#1',
        seq: 1,
        kind: 'call',
        result: { childRunId: 'child-abc', findings: [] },
      }),
    ]
    const { nodes } = projectGraph([{ id: 'pr-review', kind: 'call' }], journal)
    expect(nodes[0].childRunId).toBe('child-abc')
    expect(nodes[0].kind).toBe('call')
  })

  it('parallel branch labels /b<i>: fan out from parent', () => {
    const journal: WorkflowJournalEntry[] = [
      je({ type: 'step_started', ts: 't0', label: 'fan', stepId: 'fan#1', seq: 1, kind: 'parallel' }),
      je({
        type: 'step_started',
        ts: 't1',
        label: 'fan#1/b0:work',
        stepId: 'fan#1/b0:work#1',
        seq: 1,
        kind: 'run',
      }),
      je({
        type: 'step_finished',
        ts: 't2',
        label: 'fan#1/b0:work',
        stepId: 'fan#1/b0:work#1',
        seq: 1,
        kind: 'run',
        result: 1,
      }),
      je({
        type: 'step_started',
        ts: 't3',
        label: 'fan#1/b1:work',
        stepId: 'fan#1/b1:work#1',
        seq: 1,
        kind: 'run',
      }),
      je({
        type: 'step_finished',
        ts: 't4',
        label: 'fan#1/b1:work',
        stepId: 'fan#1/b1:work#1',
        seq: 1,
        kind: 'run',
        result: 2,
      }),
      je({
        type: 'step_finished',
        ts: 't5',
        label: 'fan',
        stepId: 'fan#1',
        seq: 1,
        kind: 'parallel',
        result: [1, 2],
      }),
    ]
    const { nodes, edges } = projectGraph(undefined, journal)
    const fan = nodes.find((n) => n.id === 'fan')
    expect(fan?.kind).toBe('parallel')
    const branches = nodes.filter((n) => n.branchIndex !== undefined)
    expect(branches).toHaveLength(2)
    expect(branches.map((b) => b.branchIndex).sort()).toEqual([0, 1])
    expect(branches.every((b) => b.parallelParentId === 'fan')).toBe(true)
    expect(
      edges.filter((e) => e.from === 'fan' && e.kind === 'execution').map((e) => e.to).sort(),
    ).toEqual(['fan#1/b0:work', 'fan#1/b1:work'].sort())
  })

  it('empty outline and empty journal → empty graph', () => {
    expect(projectGraph(undefined, [])).toEqual({ nodes: [], edges: [] })
    expect(projectGraph([], [])).toEqual({ nodes: [], edges: [] })
  })
})
