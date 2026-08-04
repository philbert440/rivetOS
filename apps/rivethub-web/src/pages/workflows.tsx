/**
 * Workflows — Product-Map-style definitions (fixture IR for MVP).
 * List + detail graph with per-node contracts (inputs/outputs/tools/capability).
 */

import { useEffect, useMemo, useState, type JSX } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { WorkflowCanvas } from '../components/workflow-canvas.js'
import { WorkflowInspector } from '../components/workflow-inspector.js'
import {
  getWorkflow,
  listWorkflows,
  normalizeWorkflow,
  validateWorkflow,
} from '../lib/workflows/index.js'

export function WorkflowsPage(): JSX.Element {
  const navigate = useNavigate()
  const workflows = listWorkflows()

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-lg font-semibold text-em">Workflows</h1>
        <span className="font-mono text-[11px] text-ink-dim">
          {workflows.length} definition{workflows.length === 1 ? '' : 's'} · fixture catalog
        </span>
      </div>

      <p className="mb-6 max-w-2xl text-sm text-ink-dim">
        Defined multi-step agent work as a graph of nodes. Each node carries a work contract —
        inputs, outputs, tools, and capability. Runtime execution is not wired yet; this is the
        authoring surface.
      </p>

      <ul className="flex flex-col gap-2">
        {workflows.map((w) => {
          const issues = validateWorkflow(normalizeWorkflow(w))
          const errors = issues.filter((i) => i.severity === 'error').length
          return (
            <li key={w.id}>
              <button
                type="button"
                onClick={() =>
                  void navigate({
                    to: '/workflows/$workflowId',
                    params: { workflowId: w.id },
                  })
                }
                className="flex w-full items-center justify-between gap-4 rounded border border-line bg-panel px-4 py-3 text-left hover:border-em"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{w.name}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-ink-dim">
                    {w.id} · v{w.version} · {w.nodes.length} nodes · {w.edges.length} edges
                  </span>
                  {w.description && (
                    <span className="mt-1 block truncate text-xs text-ink-dim">
                      {w.description}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-mono text-[11px] text-em">open graph</span>
                  {errors > 0 ? (
                    <span className="font-mono text-[11px] text-red">
                      {errors} error{errors === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-ink-dim">valid</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
        {workflows.length === 0 && (
          <li className="text-sm text-ink-dim">no workflow definitions</li>
        )}
      </ul>
    </div>
  )
}

export function WorkflowDetailPage(): JSX.Element {
  const { workflowId } = useParams({ from: '/workflows/$workflowId' })
  const raw = getWorkflow(workflowId)
  const workflow = useMemo(() => (raw ? normalizeWorkflow(raw) : undefined), [raw])
  const issues = useMemo(() => (workflow ? validateWorkflow(workflow) : []), [workflow])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedNodeId(null)
  }, [workflowId])

  if (!workflow) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link to="/workflows" className="font-mono text-xs text-em hover:underline">
          ← Workflows
        </Link>
        <h1 className="mt-4 font-mono text-lg font-semibold text-em">Not found</h1>
        <p className="mt-2 text-sm text-ink-dim">
          No workflow with id <span className="font-mono text-ink">{workflowId}</span>.
        </p>
      </div>
    )
  }

  const selectedNode = workflow.nodes.find((n) => n.id === selectedNodeId) ?? null
  const errorCount = issues.filter((i) => i.severity === 'error').length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Link to="/workflows" className="font-mono text-xs text-em hover:underline">
          ← Workflows
        </Link>
        <h1 className="font-mono text-base font-semibold text-em">{workflow.name}</h1>
        <span className="font-mono text-[11px] text-ink-dim">
          {workflow.id} · v{workflow.version}
        </span>
        <span
          className={
            errorCount > 0
              ? 'ml-auto font-mono text-[11px] text-red'
              : 'ml-auto font-mono text-[11px] text-ink-dim'
          }
        >
          {errorCount > 0
            ? `${String(errorCount)} validation error${errorCount === 1 ? '' : 's'}`
            : `${String(workflow.nodes.length)} nodes · valid`}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col p-3">
          <WorkflowCanvas
            workflow={workflow}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </div>
        <WorkflowInspector workflow={workflow} selectedNode={selectedNode} issues={issues} />
      </div>
    </div>
  )
}
