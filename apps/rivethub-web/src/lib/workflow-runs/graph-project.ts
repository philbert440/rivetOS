/**
 * Pure graph projection of workflow outline + journal (slice H).
 *
 * LIST | GRAPH are two views of the same steps. Outline is display-only;
 * journal is the source of execution truth. Loop iterations (label#1..n)
 * fold into one node with an iteration badge. Parallel branch labels
 * (`…/b<i>:…`) become lane-tagged nodes under a parallel parent.
 *
 * No positions, no editing, no wire I/O — pure data → nodes/edges.
 */

import type { WorkflowJournalEntry, WorkflowOutlineStep } from '@rivetos/types'
import type { GraphNodeStatus } from './status.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GraphNode {
  /** Stable node key (outline id or journal base label; loop-folded). */
  id: string
  /** Display label. */
  label: string
  /** Step kind when known (agent | run | human | call | done | parallel | …). */
  kind?: string
  status: GraphNodeStatus
  /** Present when more than one journal seq folded into this node. */
  iterations?: number
  /**
   * Child run id for `call` steps when the journal carries it
   * (result.childRunId / result.runId / entry.childRunId). Optional.
   */
  childRunId?: string
  /** Outline description when available. */
  description?: string
  /** True if this id appears in the outline. */
  fromOutline: boolean
  /** True if any journal step event referenced this node. */
  fromJournal: boolean
  /**
   * Parallel branch index when the journal label matches `/b<i>:`.
   * Undefined for non-branch nodes.
   */
  branchIndex?: number
  /** Parent node id for parallel branch children (base label of the parallel step). */
  parallelParentId?: string
  /**
   * Optional layout hint — never required for logic; projection leaves it
   * undefined. Callers/layout may fill later.
   */
  position?: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  /**
   * `execution` — solid, derived from journal sequence (first-seen order).
   * `declared` — dashed, outline order for not-yet-run / outline-only edges.
   */
  kind: 'execution' | 'declared'
}

export interface GraphProjection {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ---------------------------------------------------------------------------
// Journal parsing helpers
// ---------------------------------------------------------------------------

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Parallel branch: `fan#1/b0:work` → parentLabel=fan, branch=0, inner=work */
const BRANCH_LABEL_RE = /^(?<parent>[^/]+?)#(?<pseq>\d+)\/b(?<bi>\d+):(?<inner>.+)$/

interface BranchParse {
  parentLabel: string
  parentSeq: number
  branchIndex: number
  innerLabel: string
  /** Fold key for the branch work node. */
  nodeId: string
}

function parseBranchLabel(label: string): BranchParse | undefined {
  const m = BRANCH_LABEL_RE.exec(label)
  if (!m?.groups) return undefined
  const parentLabel = m.groups.parent
  const parentSeq = Number(m.groups.pseq)
  const branchIndex = Number(m.groups.bi)
  const innerLabel = m.groups.inner
  // Fold across parent seq + branch work seq by keeping parent#seq in the id
  // so fan#1/b0:work and fan#2/b0:work stay distinct when the parallel step
  // itself loops; iterations of the *inner* work still fold via seq on label.
  const nodeId = `${parentLabel}#${String(parentSeq)}/b${String(branchIndex)}:${innerLabel}`
  return { parentLabel, parentSeq, branchIndex, innerLabel, nodeId }
}

/**
 * Base fold key for a journal label.
 * - Normal: `greet` (loop iterations fold by max seq)
 * - Branch: full `parent#seq/bN:inner` (see parseBranchLabel)
 */
function foldKey(label: string): string {
  const b = parseBranchLabel(label)
  return b ? b.nodeId : label
}

type StepEventType =
  'step_started' | 'step_finished' | 'step_failed' | 'gate_opened' | 'gate_resolved'

const STEP_EVENT_TYPES = new Set<string>([
  'step_started',
  'step_finished',
  'step_failed',
  'gate_opened',
  'gate_resolved',
])

interface SeqState {
  seq: number
  started: boolean
  finished: boolean
  failed: boolean
  gateOpen: boolean
  gateResolved: boolean
  kind?: string
  childRunId?: string
}

interface AccumNode {
  id: string
  label: string
  kind?: string
  description?: string
  fromOutline: boolean
  fromJournal: boolean
  branchIndex?: number
  parallelParentId?: string
  /** seq → state */
  seqs: Map<number, SeqState>
  /** First journal index where this node was seen (for execution order). */
  firstJournalIndex: number
  childRunId?: string
  /** Outline order index when from outline (−1 if not). */
  outlineIndex: number
}

function extractChildRunId(entry: WorkflowJournalEntry): string | undefined {
  const direct = str(entry.childRunId) ?? str(entry.runId)
  if (direct) return direct
  const result = entry.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>
    return str(r.childRunId) ?? str(r.runId)
  }
  return undefined
}

function ensureSeq(node: AccumNode, seq: number): SeqState {
  let s = node.seqs.get(seq)
  if (!s) {
    s = {
      seq,
      started: false,
      finished: false,
      failed: false,
      gateOpen: false,
      gateResolved: false,
    }
    node.seqs.set(seq, s)
  }
  return s
}

function deriveStatus(node: AccumNode): GraphNodeStatus {
  if (node.seqs.size === 0) return 'pending'

  // Prefer the highest seq (latest iteration) for status, with severity
  // overrides: any open gate or any failure on the latest wins accordingly.
  const seqs = [...node.seqs.values()].sort((a, b) => a.seq - b.seq)
  const latest = seqs[seqs.length - 1]

  if (latest.failed) return 'failed'
  if (latest.gateOpen && !latest.gateResolved) return 'gate-open'
  if (latest.gateResolved) return 'gate-resolved'
  if (latest.finished) return 'done'
  if (latest.started) return 'running'

  // Fallback scan older seqs if latest is empty (shouldn't happen)
  for (let i = seqs.length - 1; i >= 0; i--) {
    const s = seqs[i]
    if (s.failed) return 'failed'
    if (s.gateOpen && !s.gateResolved) return 'gate-open'
    if (s.gateResolved) return 'gate-resolved'
    if (s.finished) return 'done'
    if (s.started) return 'running'
  }
  return 'pending'
}

function displayLabel(node: AccumNode): string {
  if (node.branchIndex !== undefined && node.parallelParentId) {
    // Prefer inner work name for branch nodes
    const b = parseBranchLabel(node.id)
    if (b) return b.innerLabel
  }
  return node.label
}

// ---------------------------------------------------------------------------
// projectGraph
// ---------------------------------------------------------------------------

/**
 * Project outline + journal into a graph of nodes and edges.
 *
 * @param outline — optional display outline (ids match journal labels)
 * @param journal — engine journal (opaque wire entries; we read by `type`)
 */
export function projectGraph(
  outline: WorkflowOutlineStep[] | undefined,
  journal: WorkflowJournalEntry[],
): GraphProjection {
  const nodes = new Map<string, AccumNode>()

  // 1) Seed from outline (declared shape, may include steps not yet run)
  const outlineList = outline ?? []
  for (let i = 0; i < outlineList.length; i++) {
    const step = outlineList[i]
    const id = step.id
    if (!id) continue
    nodes.set(id, {
      id,
      label: step.label ?? step.id,
      kind: step.kind,
      description: step.description,
      fromOutline: true,
      fromJournal: false,
      seqs: new Map(),
      firstJournalIndex: Number.POSITIVE_INFINITY,
      outlineIndex: i,
    })
  }

  // 2) Absorb journal step events
  for (let ji = 0; ji < journal.length; ji++) {
    const entry = journal[ji]
    const type = entry.type
    if (!STEP_EVENT_TYPES.has(type)) continue

    const label = str(entry.label)
    const stepId = str(entry.stepId)
    // Prefer explicit label; fall back to stepId with #seq stripped for folds
    let baseLabel = label
    if (!baseLabel && stepId) {
      const hash = stepId.lastIndexOf('#')
      baseLabel = hash > 0 ? stepId.slice(0, hash) : stepId
    }
    if (!baseLabel) continue

    const branch = parseBranchLabel(baseLabel)
    const id = foldKey(baseLabel)
    const seq = num(entry.seq) ?? 1
    const kind = str(entry.kind)

    let node = nodes.get(id)
    if (!node) {
      // Undeclared step (journal-only) or branch node
      node = {
        id,
        label: branch ? branch.innerLabel : baseLabel,
        kind,
        fromOutline: false,
        fromJournal: true,
        seqs: new Map(),
        firstJournalIndex: ji,
        outlineIndex: -1,
        branchIndex: branch?.branchIndex,
        parallelParentId: branch?.parentLabel,
      }
      nodes.set(id, node)
    } else {
      node.fromJournal = true
      if (ji < node.firstJournalIndex) node.firstJournalIndex = ji
      if (kind && !node.kind) node.kind = kind
      if (branch) {
        node.branchIndex = branch.branchIndex
        node.parallelParentId = branch.parentLabel
      }
    }

    // Ensure parallel parent node exists when we see a branch
    if (branch) {
      const existingParent = nodes.get(branch.parentLabel)
      if (!existingParent) {
        // Parent may appear as its own step_started with label=parent; if not yet,
        // synthesize a placeholder so edges/lanes have an anchor.
        nodes.set(branch.parentLabel, {
          id: branch.parentLabel,
          label: branch.parentLabel,
          kind: 'parallel',
          fromOutline: false,
          fromJournal: true,
          seqs: new Map(),
          firstJournalIndex: ji,
          outlineIndex: -1,
        })
      } else {
        existingParent.fromJournal = true
        if (existingParent.kind === undefined) existingParent.kind = 'parallel'
        if (ji < existingParent.firstJournalIndex) existingParent.firstJournalIndex = ji
      }
    }

    const st = ensureSeq(node, seq)
    if (kind) st.kind = kind

    switch (type as StepEventType) {
      case 'step_started':
        st.started = true
        if (kind) node.kind = kind
        break
      case 'step_finished': {
        st.finished = true
        st.started = true
        if (kind) node.kind = kind
        const cr = extractChildRunId(entry)
        if (cr) {
          st.childRunId = cr
          node.childRunId = cr
        }
        break
      }
      case 'step_failed':
        st.failed = true
        st.started = true
        if (kind) node.kind = kind
        break
      case 'gate_opened':
        st.gateOpen = true
        st.started = true
        if (!node.kind) node.kind = 'human'
        break
      case 'gate_resolved':
        st.gateResolved = true
        st.gateOpen = false
        st.started = true
        if (!node.kind) node.kind = 'human'
        break
    }
  }

  // 3) Materialize GraphNode[]
  const graphNodes: GraphNode[] = []
  for (const acc of nodes.values()) {
    const iterations = acc.seqs.size > 1 ? acc.seqs.size : undefined
    // Also count max seq if only one map entry isn't enough (e.g. missing gaps)
    let maxSeq = 0
    for (const s of acc.seqs.keys()) if (s > maxSeq) maxSeq = s
    const iterCount = Math.max(acc.seqs.size, maxSeq)
    const showIters = iterCount > 1 ? iterCount : iterations

    graphNodes.push({
      id: acc.id,
      label: displayLabel(acc),
      kind: acc.kind,
      status: deriveStatus(acc),
      iterations: showIters && showIters > 1 ? showIters : undefined,
      childRunId: acc.childRunId,
      description: acc.description,
      fromOutline: acc.fromOutline,
      fromJournal: acc.fromJournal,
      branchIndex: acc.branchIndex,
      parallelParentId: acc.parallelParentId,
    })
  }

  // 4) Edges
  const edges: GraphEdge[] = []
  const edgeKeys = new Set<string>()

  function addEdge(from: string, to: string, kind: 'execution' | 'declared'): void {
    if (from === to) return
    if (!nodes.has(from) || !nodes.has(to)) return
    const key = `${kind}:${from}→${to}`
    if (edgeKeys.has(key)) return
    // Prefer execution over declared for the same pair
    if (kind === 'declared' && edgeKeys.has(`execution:${from}→${to}`)) return
    edgeKeys.add(key)
    edges.push({ id: key, from, to, kind })
  }

  // Execution order: journal first-seen among non-branch nodes; branch nodes
  // attach after their parallel parent rather than in the linear spine when
  // possible. For simplicity: linear spine = all nodes ordered by
  // firstJournalIndex (finite only), excluding pure outline-pending.
  const executed = [...nodes.values()]
    .filter((n) => n.fromJournal && Number.isFinite(n.firstJournalIndex))
    .sort((a, b) => {
      if (a.firstJournalIndex !== b.firstJournalIndex) {
        return a.firstJournalIndex - b.firstJournalIndex
      }
      // Stable: outline index then id
      if (a.outlineIndex !== b.outlineIndex) return a.outlineIndex - b.outlineIndex
      return a.id.localeCompare(b.id)
    })

  // Linear spine: skip branch nodes in the main chain — they fan out from parent
  const spine = executed.filter((n) => n.branchIndex === undefined)
  for (let i = 0; i < spine.length - 1; i++) {
    addEdge(spine[i].id, spine[i + 1].id, 'execution')
  }

  // Branch fan-out: parallelParent → each branch node (execution)
  for (const n of executed) {
    if (n.branchIndex !== undefined && n.parallelParentId && nodes.has(n.parallelParentId)) {
      addEdge(n.parallelParentId, n.id, 'execution')
    }
  }

  // Declared (outline) edges for not-yet-run steps and outline-only graphs
  const outlineIds = outlineList.map((s) => s.id).filter(Boolean)
  for (let i = 0; i < outlineIds.length - 1; i++) {
    const from = outlineIds[i]
    const to = outlineIds[i + 1]
    const fromNode = nodes.get(from)
    const toNode = nodes.get(to)
    if (!fromNode || !toNode) continue

    // Always emit declared for pure outline-only pairs; for mixed, emit when
    // either endpoint is not yet in the journal (pending tail/prefix).
    const bothPending = !fromNode.fromJournal && !toNode.fromJournal
    const toPending = !toNode.fromJournal
    const fromPending = !fromNode.fromJournal
    if (bothPending || toPending || fromPending || executed.length === 0) {
      addEdge(from, to, 'declared')
    }
  }

  // When we have a partial run: connect last executed outline-matching node
  // to the next pending outline node with a declared edge (bridge).
  if (spine.length > 0 && outlineIds.length > 0) {
    const executedIds = new Set(spine.map((n) => n.id))
    let lastExecOutlineIdx = -1
    for (let i = 0; i < outlineIds.length; i++) {
      if (executedIds.has(outlineIds[i])) lastExecOutlineIdx = i
    }
    if (lastExecOutlineIdx >= 0 && lastExecOutlineIdx < outlineIds.length - 1) {
      const nextPending = outlineIds[lastExecOutlineIdx + 1]
      if (!executedIds.has(nextPending)) {
        addEdge(outlineIds[lastExecOutlineIdx], nextPending, 'declared')
      }
    }
  }

  // Stable node order: outline order first, then journal-only by first seen
  graphNodes.sort((a, b) => {
    const aa = nodes.get(a.id)!
    const bb = nodes.get(b.id)!
    const aOut = aa.outlineIndex >= 0
    const bOut = bb.outlineIndex >= 0
    if (aOut && bOut) return aa.outlineIndex - bb.outlineIndex
    if (aOut && !bOut) return -1
    if (!aOut && bOut) return 1
    if (aa.firstJournalIndex !== bb.firstJournalIndex) {
      return aa.firstJournalIndex - bb.firstJournalIndex
    }
    return a.id.localeCompare(b.id)
  })

  return { nodes: graphNodes, edges }
}
