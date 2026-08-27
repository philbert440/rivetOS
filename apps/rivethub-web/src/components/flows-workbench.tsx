/**
 * Flows workbench: palette, canvas, properties. Authoring when `editable`.
 */

import { type JSX, type ReactNode } from 'react'
import { Select } from './select.js'
import { FlowsCanvas } from './flows-canvas.js'
import {
  addFlowNode,
  deleteFlowNode,
  FLOW_PALETTE,
  FLOW_START_ID,
  nodeById,
  updateFlowNode,
  type FlowAuthorGraph,
  type FlowAuthorKind,
} from '../lib/workflow-runs/flow-graph.js'
import { GRAPH_NODE_STATUS_LABELS, type GraphNodeStatus } from '../lib/workflow-runs/status.js'

export interface FlowsWorkbenchProps {
  graph: FlowAuthorGraph
  onChange?: (graph: FlowAuthorGraph) => void
  editable?: boolean
  workflowOptions: { value: string; label: string }[]
  workflowId: string
  onWorkflowChange?: (id: string) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  inspectorExtra?: ReactNode
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  /** Live journal status on the same node ids. */
  statusById?: Record<string, GraphNodeStatus>
}

function Field(props: {
  label: string
  value: string
  onChange: (v: string) => void
  multiline?: boolean
  placeholder?: string
}): JSX.Element {
  const cls =
    'mt-0.5 w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-xs text-ink'
  return (
    <label className="mb-2 block">
      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
        {props.label}
      </span>
      {props.multiline ? (
        <textarea
          className={`${cls} min-h-[8rem]`}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
        />
      ) : (
        <input
          className={cls}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </label>
  )
}

function NodeInspector(props: {
  graph: FlowAuthorGraph
  selectedId: string | null
  editable: boolean
  onChange?: (graph: FlowAuthorGraph) => void
  status?: GraphNodeStatus
}): JSX.Element {
  const node = props.selectedId ? nodeById(props.graph, props.selectedId) : undefined
  if (!node) {
    return <p className="mb-4 text-sm text-ink-dim">Select a node or drag from an output port.</p>
  }
  const patch = (p: Parameters<typeof updateFlowNode>[2]): void => {
    if (!props.editable) return
    props.onChange?.(updateFlowNode(props.graph, node.id, p))
  }
  return (
    <div className="mb-4">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">{node.kind}</p>
      {node.kind !== 'start' && (
        <Field label="Name" value={node.label} onChange={(label) => patch({ label })} />
      )}
      {props.status && (
        <p
          className={`mb-2 font-mono text-xs ${props.status === 'failed' ? 'text-red' : 'text-em'}`}
        >
          {GRAPH_NODE_STATUS_LABELS[props.status]}
        </p>
      )}
      {node.kind === 'start' && (
        <p className="mb-3 text-sm text-ink-dim">
          Start is the input contract. Wire it to a script when the first step is deterministic.
        </p>
      )}
      {node.kind === 'agent' && (
        <>
          <Field
            label="Agent file"
            value={node.agentName ?? ''}
            onChange={(agentName) => patch({ agentName })}
            placeholder="reviewer"
          />
          <Field
            label="Instructions"
            value={node.prompt ?? ''}
            onChange={(prompt) => patch({ prompt })}
            multiline
          />
          <Field
            label="Tools (comma)"
            value={(node.tools ?? []).join(', ')}
            onChange={(v) =>
              patch({
                tools: v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <Field label="Model" value={node.model ?? ''} onChange={(model) => patch({ model })} />
          <Field
            label="Max turns"
            value={node.maxTurns !== undefined ? String(node.maxTurns) : ''}
            onChange={(v) => patch({ maxTurns: v === '' ? undefined : Number(v) })}
          />
        </>
      )}
      {node.kind === 'run' && (
        <>
          <p className="mb-2 text-xs text-ink-dim">
            Script steps call `step.run` — no model, no tokens. Use them for deterministic work.
          </p>
          <Field
            label="Script path"
            value={node.scriptPath ?? ''}
            onChange={(scriptPath) => patch({ scriptPath })}
            placeholder="scripts/load.sh"
          />
        </>
      )}
      {node.kind === 'human' && (
        <>
          <Field
            label="Gate prompt"
            value={node.gatePrompt ?? ''}
            onChange={(gatePrompt) => patch({ gatePrompt })}
            multiline
          />
          <Field
            label="Fields (comma)"
            value={(node.gateFields ?? []).join(', ')}
            onChange={(v) =>
              patch({
                gateFields: v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </>
      )}
      {node.kind === 'call' && (
        <Field
          label="Workflow id"
          value={node.callRef ?? ''}
          onChange={(callRef) => patch({ callRef })}
        />
      )}
      {props.editable && node.id !== FLOW_START_ID && (
        <button
          type="button"
          onClick={() => props.onChange?.(deleteFlowNode(props.graph, node.id))}
          className="mt-2 font-mono text-[11px] text-red hover:underline"
        >
          Delete node
        </button>
      )}
    </div>
  )
}

export function FlowsWorkbench(props: FlowsWorkbenchProps): JSX.Element {
  const add = (kind: Exclude<FlowAuthorKind, 'start'>): void => {
    if (!props.editable || !props.onChange) return
    const next = addFlowNode(props.graph, kind)
    const created = next.nodes[next.nodes.length - 1]
    props.onChange(next)
    if (created) props.onSelect(created.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        {props.toolbarLeft}
        {props.workflowOptions.length > 0 && (
          <Select
            title="Workflow"
            label="Workflow"
            value={props.workflowId}
            options={props.workflowOptions}
            onChange={(id) => props.onWorkflowChange?.(id)}
            className="min-w-[12rem]"
          />
        )}
        <span className="ml-auto" />
        {props.toolbarRight}
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className="flex w-48 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel/80"
          aria-label="Flow palette"
        >
          {props.editable && (
            <>
              <p className="px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                Add
              </p>
              {FLOW_PALETTE.map((p) => (
                <button
                  key={p.kind}
                  type="button"
                  onClick={() => add(p.kind)}
                  className="px-3 py-1.5 text-left font-mono text-xs text-ink-dim hover:bg-panel-2 hover:text-em"
                >
                  {p.label}
                  {p.kind === 'run' ? (
                    <span className="mt-0.5 block text-[10px] opacity-70">deterministic</span>
                  ) : null}
                </button>
              ))}
            </>
          )}
          <p className="px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
            Nodes
          </p>
          {props.graph.nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => props.onSelect(n.id)}
              className={`px-3 py-1.5 text-left font-mono text-xs ${
                props.selectedId === n.id ? 'bg-panel-2 text-em' : 'text-ink-dim hover:text-ink'
              }`}
            >
              <span className="block truncate">{n.label}</span>
              <span className="block truncate text-[10px] opacity-70">
                {props.statusById?.[n.id]
                  ? GRAPH_NODE_STATUS_LABELS[props.statusById[n.id]]
                  : n.kind === 'run'
                    ? 'script'
                    : n.kind}
              </span>
            </button>
          ))}
        </nav>

        <FlowsCanvas
          graph={props.graph}
          selectedId={props.selectedId ?? FLOW_START_ID}
          onSelect={props.onSelect}
          onChange={props.onChange}
          editable={props.editable}
          statusById={props.statusById}
        />

        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel p-3">
          <h2 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
            Properties
          </h2>
          {props.statusById && (
            <p className="mb-3 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
              Live run overlay
            </p>
          )}
          <NodeInspector
            graph={props.graph}
            selectedId={props.selectedId}
            editable={Boolean(props.editable)}
            onChange={props.onChange}
            status={props.selectedId ? props.statusById?.[props.selectedId] : undefined}
          />
          {props.inspectorExtra}
        </aside>
      </div>
    </div>
  )
}
