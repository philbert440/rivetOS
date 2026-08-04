/**
 * Workflows — Product-Map-style definitions with local edit + catalog persistence.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { WorkflowCanvas } from '../components/workflow-canvas.js'
import { WorkflowInspector } from '../components/workflow-inspector.js'
import {
  addEdge,
  addNode,
  addPort,
  createEmptyWorkflow,
  deleteWorkflow,
  getFromCatalog,
  loadCatalog,
  moveNode,
  normalizeWorkflow,
  removeEdge,
  removeNode,
  removePort,
  replaceNodePorts,
  resetCatalogToFixtures,
  saveCatalog,
  updateNode,
  updateWorkflowMeta,
  upsertWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowPort,
} from '../lib/workflows/index.js'

function useCatalog(): {
  catalog: WorkflowDefinition[]
  refresh: () => void
  setAndSave: (next: WorkflowDefinition[]) => void
} {
  const [catalog, setCatalog] = useState<WorkflowDefinition[]>(() => loadCatalog())
  const refresh = useCallback(() => setCatalog(loadCatalog()), [])
  const setAndSave = useCallback((next: WorkflowDefinition[]) => {
    saveCatalog(next)
    setCatalog(next)
  }, [])
  return { catalog, refresh, setAndSave }
}

export function WorkflowsPage(): JSX.Element {
  const navigate = useNavigate()
  const { catalog, setAndSave } = useCatalog()

  const onNew = () => {
    const created = createEmptyWorkflow({ name: 'New workflow' })
    setAndSave(upsertWorkflow(catalog, created))
    void navigate({ to: '/workflows/$workflowId', params: { workflowId: created.id } })
  }

  const onDelete = (id: string) => {
    if (!confirm(`Delete workflow “${id}”?`)) return
    setAndSave(deleteWorkflow(catalog, id))
  }

  const onResetFixtures = () => {
    if (!confirm('Reset catalog to built-in fixtures? Local edits will be lost.')) return
    setAndSave(resetCatalogToFixtures())
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-lg font-semibold text-em">Workflows</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-ink-dim">
            {catalog.length} definition{catalog.length === 1 ? '' : 's'} · local catalog
          </span>
          <button
            type="button"
            onClick={onNew}
            className="rounded bg-em-dim px-3 py-1.5 text-sm font-medium text-bg hover:bg-em"
          >
            New workflow
          </button>
        </div>
      </div>

      <p className="mb-6 max-w-2xl text-sm text-ink-dim">
        Defined multi-step agent work as a graph of nodes. Edit labels, contracts, edges, and
        layout; the catalog is stored in this browser. Runtime execution is not wired yet.
      </p>

      <ul className="flex flex-col gap-2">
        {catalog.map((w) => {
          const issues = validateWorkflow(normalizeWorkflow(w))
          const errors = issues.filter((i) => i.severity === 'error').length
          return (
            <li key={w.id} className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void navigate({
                    to: '/workflows/$workflowId',
                    params: { workflowId: w.id },
                  })
                }
                className="flex min-w-0 flex-1 items-center justify-between gap-4 rounded border border-line bg-panel px-4 py-3 text-left hover:border-em"
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
                  <span className="font-mono text-[11px] text-em">open</span>
                  {errors > 0 ? (
                    <span className="font-mono text-[11px] text-red">
                      {errors} error{errors === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-ink-dim">valid</span>
                  )}
                </span>
              </button>
              <button
                type="button"
                title="Delete"
                onClick={() => onDelete(w.id)}
                className="shrink-0 rounded border border-line px-2 text-sm text-ink-dim hover:border-red hover:text-red"
              >
                ×
              </button>
            </li>
          )
        })}
        {catalog.length === 0 && <li className="text-sm text-ink-dim">no workflow definitions</li>}
      </ul>

      <div className="mt-6">
        <button
          type="button"
          onClick={onResetFixtures}
          className="font-mono text-[11px] text-ink-dim hover:text-em hover:underline"
        >
          Reset to fixtures
        </button>
      </div>
    </div>
  )
}

export function WorkflowDetailPage(): JSX.Element {
  const { workflowId } = useParams({ from: '/workflows/$workflowId' })
  const { catalog, setAndSave } = useCatalog()
  const stored = getFromCatalog(catalog, workflowId)

  const [draft, setDraft] = useState<WorkflowDefinition | undefined>(() =>
    stored ? normalizeWorkflow(structuredClone(stored)) : undefined,
  )
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  // Reload draft when route id / catalog entry changes and not dirty
  useEffect(() => {
    const next = getFromCatalog(loadCatalog(), workflowId)
    if (!next) {
      setDraft(undefined)
      setDirty(false)
      return
    }
    setDraft(normalizeWorkflow(structuredClone(next)))
    setDirty(false)
    setSelectedNodeId(null)
  }, [workflowId])

  const issues = useMemo(() => (draft ? validateWorkflow(draft) : []), [draft])

  const patchDraft = useCallback((fn: (d: WorkflowDefinition) => WorkflowDefinition) => {
    setDraft((prev) => {
      if (!prev) return prev
      return fn(prev)
    })
    setDirty(true)
  }, [])

  const onSave = () => {
    if (!draft) return
    const normalized = normalizeWorkflow(draft)
    const next = upsertWorkflow(loadCatalog(), normalized)
    setAndSave(next)
    setDraft(normalized)
    setDirty(false)
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 1500)
  }

  const onRevert = () => {
    const next = getFromCatalog(loadCatalog(), workflowId)
    if (!next) return
    setDraft(normalizeWorkflow(structuredClone(next)))
    setDirty(false)
  }

  if (!draft) {
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

  const selectedNode = draft.nodes.find((n) => n.id === selectedNodeId) ?? null
  const errorCount = issues.filter((i) => i.severity === 'error').length

  const onAddPort = (nodeId: string, direction: 'in' | 'out') => {
    patchDraft((d) => {
      const node = d.nodes.find((n) => n.id === nodeId)
      if (!node) return d
      const base = direction === 'in' ? 'in' : 'out'
      let n = 1
      let id = `${base}${String(n)}`
      const existing = new Set([...node.inputs, ...node.outputs].map((p) => p.id))
      while (existing.has(id)) {
        n += 1
        id = `${base}${String(n)}`
      }
      const port: WorkflowPort = {
        id,
        name: direction === 'in' ? 'Input' : 'Output',
        direction,
        kind: 'data',
        required: direction === 'in' ? true : undefined,
      }
      return addPort(d, nodeId, port)
    })
  }

  const onAddEdge = (from: string, to: string) => {
    const [fromNode, fromPort] = from.split('.')
    const [toNode, toPort] = to.split('.')
    if (!fromNode || !fromPort || !toNode || !toPort) return
    patchDraft((d) =>
      addEdge(d, {
        from: { nodeId: fromNode, portId: fromPort },
        to: { nodeId: toNode, portId: toPort },
      }),
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Link to="/workflows" className="font-mono text-xs text-em hover:underline">
          ← Workflows
        </Link>
        <h1 className="font-mono text-base font-semibold text-em">{draft.name}</h1>
        <span className="font-mono text-[11px] text-ink-dim">
          {draft.id} · v{draft.version}
          {dirty ? ' · unsaved' : ''}
          {savedFlash ? ' · saved' : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className={
              errorCount > 0
                ? 'font-mono text-[11px] text-red'
                : 'font-mono text-[11px] text-ink-dim'
            }
          >
            {errorCount > 0
              ? `${String(errorCount)} error${errorCount === 1 ? '' : 's'}`
              : `${String(draft.nodes.length)} nodes · valid`}
          </span>
          <button
            type="button"
            onClick={() =>
              patchDraft((d) =>
                addNode(d, {
                  position: { x: 80 + d.nodes.length * 24, y: 80 + (d.nodes.length % 3) * 40 },
                }),
              )
            }
            className="rounded border border-line px-2 py-1 font-mono text-[11px] text-ink hover:border-em"
          >
            + Node
          </button>
          <button
            type="button"
            disabled={!dirty}
            onClick={onRevert}
            className="rounded border border-line px-2 py-1 font-mono text-[11px] text-ink-dim enabled:hover:border-em enabled:hover:text-ink disabled:opacity-40"
          >
            Revert
          </button>
          <button
            type="button"
            disabled={!dirty}
            onClick={onSave}
            className="rounded bg-em-dim px-3 py-1 font-mono text-[11px] font-medium text-bg enabled:hover:bg-em disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col p-3">
          <WorkflowCanvas
            workflow={draft}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            editable
            onMoveNode={(id, pos) => patchDraft((d) => moveNode(d, id, pos))}
          />
        </div>
        <WorkflowInspector
          workflow={draft}
          selectedNode={selectedNode}
          issues={issues}
          editable
          onUpdateMeta={(patch) => patchDraft((d) => updateWorkflowMeta(d, patch))}
          onUpdateNode={(nodeId, patch) =>
            patchDraft((d) => {
              // Port list edits go through replaceNodePorts so renames remap edges.
              let next = d
              if (patch.inputs) {
                next = replaceNodePorts(next, nodeId, 'inputs', patch.inputs)
              }
              if (patch.outputs) {
                next = replaceNodePorts(next, nodeId, 'outputs', patch.outputs)
              }
              const { inputs: _i, outputs: _o, ...rest } = patch
              if (Object.keys(rest).length > 0) {
                next = updateNode(next, nodeId, rest)
              }
              return next
            })
          }
          onDeleteNode={(nodeId) => {
            patchDraft((d) => removeNode(d, nodeId))
            setSelectedNodeId((cur) => (cur === nodeId ? null : cur))
          }}
          onAddPort={onAddPort}
          onRemovePort={(nodeId, portId) => patchDraft((d) => removePort(d, nodeId, portId))}
          onRemoveEdge={(edgeId) => patchDraft((d) => removeEdge(d, edgeId))}
          onAddEdge={onAddEdge}
        />
      </div>
    </div>
  )
}
