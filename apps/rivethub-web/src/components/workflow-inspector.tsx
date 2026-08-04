/**
 * Right-rail inspector: selected node contract, or workflow summary + issues.
 */

import type { JSX } from 'react'
import type {
  ValidationIssue,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowPort,
} from '../lib/workflows/index.js'
import { cn } from '../lib/utils.js'

function PortList(props: { title: string; ports: WorkflowPort[] }): JSX.Element {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
        {props.title}
      </div>
      {props.ports.length === 0 ? (
        <div className="text-xs text-ink-dim">none</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {props.ports.map((p) => (
            <li
              key={p.id}
              className="rounded border border-line bg-bg/60 px-2 py-1 font-mono text-[11px]"
            >
              <span className="text-em">{p.id}</span>
              <span className="text-ink-dim"> · {p.name}</span>
              <span className="block text-[10px] text-ink-dim">
                {p.kind}
                {p.direction === 'in' && p.required !== false ? ' · required' : ''}
                {p.direction === 'in' && p.required === false ? ' · optional' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function IssueList(props: { issues: ValidationIssue[] }): JSX.Element {
  if (props.issues.length === 0) {
    return <div className="font-mono text-[11px] text-em">structurally valid</div>
  }
  return (
    <ul className="flex flex-col gap-1">
      {props.issues.map((issue, i) => (
        <li
          key={`${issue.code}-${String(i)}`}
          className={cn(
            'rounded border px-2 py-1 font-mono text-[11px]',
            issue.severity === 'error' ? 'border-red/40 text-red' : 'border-line text-ink-dim',
          )}
        >
          <span className="opacity-70">{issue.code}</span>
          <span className="block">{issue.message}</span>
        </li>
      ))}
    </ul>
  )
}

function NodeContract(props: { node: WorkflowNode }): JSX.Element {
  const { node } = props
  const toolsLabel = node.tools && node.tools.length > 0 ? node.tools.join(', ') : null
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-semibold text-ink">{node.label}</div>
        <div className="mt-0.5 font-mono text-[11px] text-ink-dim">
          {node.kind} · <span className="text-em">{node.id}</span>
        </div>
        {node.description && (
          <p className="mt-2 text-xs leading-relaxed text-ink-dim">{node.description}</p>
        )}
      </div>

      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
          Capability
        </div>
        <span className="rounded border border-em/40 bg-em/10 px-2 py-0.5 font-mono text-[11px] text-em">
          {node.capability}
        </span>
      </div>

      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">Tools</div>
        {toolsLabel ? (
          <div className="font-mono text-[11px] text-ink">{toolsLabel}</div>
        ) : (
          <div className="text-xs text-ink-dim">none</div>
        )}
        {node.toolProfile && (
          <div className="mt-1 font-mono text-[11px] text-ink-dim">
            profile: <span className="text-em">{node.toolProfile}</span>
          </div>
        )}
      </div>

      <PortList title="Inputs" ports={node.inputs} />
      <PortList title="Outputs" ports={node.outputs} />
    </div>
  )
}

export function WorkflowInspector(props: {
  workflow: WorkflowDefinition
  selectedNode: WorkflowNode | null
  issues: ValidationIssue[]
}): JSX.Element {
  const { workflow, selectedNode, issues } = props
  const errors = issues.filter((i) => i.severity === 'error').length
  const nodeIssues = selectedNode
    ? issues.filter((i) => i.nodeId === selectedNode.id || (!i.nodeId && !i.edgeId))
    : issues

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel/90 px-3 py-4">
      {selectedNode ? (
        <>
          <NodeContract node={selectedNode} />
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
              Node issues
            </div>
            <IssueList issues={nodeIssues} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-sm font-semibold text-ink">{workflow.name}</div>
            <div className="mt-0.5 font-mono text-[11px] text-ink-dim">
              v{workflow.version} · {workflow.nodes.length} nodes · {workflow.edges.length} edges
            </div>
            {workflow.description && (
              <p className="mt-2 text-xs leading-relaxed text-ink-dim">{workflow.description}</p>
            )}
          </div>
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
              Validation {errors > 0 ? `(${String(errors)} errors)` : ''}
            </div>
            <IssueList issues={issues} />
          </div>
          <p className="text-[11px] text-ink-dim">
            Select a node on the canvas to inspect its inputs, outputs, tools, and capability.
          </p>
        </div>
      )}
    </aside>
  )
}
