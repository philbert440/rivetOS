/**
 * Right-rail inspector: view or edit node/workflow contracts.
 */

import { useState, type JSX, type ReactNode } from 'react'
import type {
  CapabilityMode,
  NodeKind,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowPort,
} from '../lib/workflows/index.js'
import { CAPABILITY_MODES, NODE_KINDS, parseToolsField } from '../lib/workflows/index.js'
import { cn } from '../lib/utils.js'
import { Select } from './select.js'

function FieldLabel(props: { children: ReactNode }): JSX.Element {
  return (
    <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
      {props.children}
    </div>
  )
}

function textInputClass(): string {
  return 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink outline-none focus:border-em'
}

function PortList(props: { title: string; ports: WorkflowPort[] }): JSX.Element {
  return (
    <div>
      <FieldLabel>{props.title}</FieldLabel>
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

function EditablePorts(props: {
  ports: WorkflowPort[]
  onRemove: (portId: string) => void
  onChange: (ports: WorkflowPort[]) => void
}): JSX.Element {
  if (props.ports.length === 0) {
    return <div className="text-xs text-ink-dim">none</div>
  }
  return (
    <ul className="flex flex-col gap-2">
      {props.ports.map((p, i) => (
        <li
          key={`${p.direction}-${String(i)}-${p.id}`}
          className="rounded border border-line bg-bg/60 p-2"
        >
          <div className="flex gap-1">
            <input
              className={cn(textInputClass(), 'flex-1')}
              value={p.id}
              title="port id"
              onChange={(e) => {
                const ports = props.ports.map((x, j) =>
                  j === i ? { ...x, id: e.target.value } : x,
                )
                props.onChange(ports)
              }}
            />
            <button
              type="button"
              className="shrink-0 px-1 font-mono text-[11px] text-red hover:underline"
              onClick={() => props.onRemove(p.id)}
              title="remove port"
            >
              ×
            </button>
          </div>
          <input
            className={cn(textInputClass(), 'mt-1')}
            value={p.name}
            title="display name"
            onChange={(e) => {
              const ports = props.ports.map((x, j) =>
                j === i ? { ...x, name: e.target.value } : x,
              )
              props.onChange(ports)
            }}
          />
          <div className="mt-1 flex gap-2">
            <Select
              value={p.kind}
              options={[
                { value: 'data', label: 'data' },
                { value: 'control', label: 'control' },
              ]}
              onChange={(v) => {
                const ports = props.ports.map((x, j) =>
                  j === i ? { ...x, kind: v as 'data' | 'control' } : x,
                )
                props.onChange(ports)
              }}
              className="flex-1"
            />
            {p.direction === 'in' && (
              <label className="flex items-center gap-1 font-mono text-[10px] text-ink-dim">
                <input
                  type="checkbox"
                  checked={p.required !== false}
                  onChange={(e) => {
                    const ports = props.ports.map((x, j) =>
                      j === i ? { ...x, required: e.target.checked } : x,
                    )
                    props.onChange(ports)
                  }}
                />
                req
              </label>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

function NodeEditor(props: {
  node: WorkflowNode
  onChange: (patch: Partial<WorkflowNode>) => void
  onDelete: () => void
  onAddPort: (direction: 'in' | 'out') => void
  onRemovePort: (portId: string) => void
}): JSX.Element {
  const { node } = props
  return (
    <div className="flex flex-col gap-3">
      <div>
        <FieldLabel>Label</FieldLabel>
        <input
          className={textInputClass()}
          value={node.label}
          onChange={(e) => props.onChange({ label: e.target.value })}
        />
      </div>
      <div>
        <FieldLabel>Id</FieldLabel>
        <div className="font-mono text-[11px] text-ink-dim">{node.id}</div>
      </div>
      <div>
        <FieldLabel>Kind</FieldLabel>
        <Select
          value={node.kind}
          options={NODE_KINDS.map((k) => ({ value: k, label: k }))}
          onChange={(v) => props.onChange({ kind: v as NodeKind })}
          className="w-full"
        />
      </div>
      <div>
        <FieldLabel>Capability</FieldLabel>
        <Select
          value={node.capability}
          options={CAPABILITY_MODES.map((c) => ({ value: c, label: c }))}
          onChange={(v) => props.onChange({ capability: v as CapabilityMode })}
          className="w-full"
        />
      </div>
      <div>
        <FieldLabel>Description</FieldLabel>
        <textarea
          className={cn(textInputClass(), 'min-h-[64px] resize-y')}
          value={node.description ?? ''}
          onChange={(e) => props.onChange({ description: e.target.value })}
        />
      </div>
      <div>
        <FieldLabel>Tools (comma-separated)</FieldLabel>
        <input
          className={textInputClass()}
          value={(node.tools ?? []).join(', ')}
          placeholder="lint, typecheck"
          onChange={(e) => props.onChange({ tools: parseToolsField(e.target.value) })}
        />
      </div>
      <div>
        <FieldLabel>Tool profile</FieldLabel>
        <input
          className={textInputClass()}
          value={node.toolProfile ?? ''}
          placeholder="code-review"
          onChange={(e) => props.onChange({ toolProfile: e.target.value })}
        />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">Inputs</span>
          <button
            type="button"
            className="font-mono text-[10px] text-em hover:underline"
            onClick={() => props.onAddPort('in')}
          >
            + port
          </button>
        </div>
        <EditablePorts
          ports={node.inputs}
          onRemove={props.onRemovePort}
          onChange={(ports) => props.onChange({ inputs: ports })}
        />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
            Outputs
          </span>
          <button
            type="button"
            className="font-mono text-[10px] text-em hover:underline"
            onClick={() => props.onAddPort('out')}
          >
            + port
          </button>
        </div>
        <EditablePorts
          ports={node.outputs}
          onRemove={props.onRemovePort}
          onChange={(ports) => props.onChange({ outputs: ports })}
        />
      </div>
      <button
        type="button"
        onClick={props.onDelete}
        className="mt-2 rounded border border-red/40 px-2 py-1.5 font-mono text-[11px] text-red hover:bg-red/10"
      >
        Delete node
      </button>
    </div>
  )
}

function EdgeAdder(props: {
  outPorts: { value: string; label: string }[]
  inPorts: { value: string; label: string }[]
  onAdd: (from: string, to: string) => void
}): JSX.Element {
  const [from, setFrom] = useState(props.outPorts[0]?.value ?? '')
  const [to, setTo] = useState(props.inPorts[0]?.value ?? '')
  return (
    <div className="flex flex-col gap-1">
      <Select value={from} options={props.outPorts} onChange={setFrom} className="w-full" />
      <Select value={to} options={props.inPorts} onChange={setTo} className="w-full" />
      <button
        type="button"
        className="rounded bg-em-dim px-2 py-1 font-mono text-[11px] text-bg hover:bg-em"
        onClick={() => {
          if (from && to) props.onAdd(from, to)
        }}
      >
        Add edge
      </button>
    </div>
  )
}

function WorkflowMetaEditor(props: {
  workflow: WorkflowDefinition
  onChange: (patch: Partial<Pick<WorkflowDefinition, 'name' | 'description'>>) => void
  edges: WorkflowEdge[]
  onRemoveEdge: (edgeId: string) => void
  onAddEdge: (from: string, to: string) => void
}): JSX.Element {
  const outPorts = props.workflow.nodes.flatMap((n) =>
    n.outputs.map((p) => ({
      value: `${n.id}.${p.id}`,
      label: `${n.label} · ${p.id} (out)`,
    })),
  )
  const inPorts = props.workflow.nodes.flatMap((n) =>
    n.inputs.map((p) => ({
      value: `${n.id}.${p.id}`,
      label: `${n.label} · ${p.id} (in)`,
    })),
  )

  return (
    <div className="flex flex-col gap-3">
      <div>
        <FieldLabel>Name</FieldLabel>
        <input
          className={textInputClass()}
          value={props.workflow.name}
          onChange={(e) => props.onChange({ name: e.target.value })}
        />
      </div>
      <div>
        <FieldLabel>Id</FieldLabel>
        <div className="font-mono text-[11px] text-ink-dim">{props.workflow.id}</div>
      </div>
      <div>
        <FieldLabel>Description</FieldLabel>
        <textarea
          className={cn(textInputClass(), 'min-h-[72px] resize-y')}
          value={props.workflow.description ?? ''}
          onChange={(e) => props.onChange({ description: e.target.value })}
        />
      </div>
      <div>
        <FieldLabel>Edges ({String(props.edges.length)})</FieldLabel>
        <ul className="mb-2 flex max-h-32 flex-col gap-1 overflow-y-auto">
          {props.edges.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-1 rounded border border-line bg-bg/60 px-2 py-1 font-mono text-[10px]"
            >
              <span className="truncate text-ink-dim">
                {e.from.nodeId}.{e.from.portId} → {e.to.nodeId}.{e.to.portId}
              </span>
              <button
                type="button"
                className="text-red hover:underline"
                onClick={() => props.onRemoveEdge(e.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {outPorts.length > 0 && inPorts.length > 0 && (
          <EdgeAdder outPorts={outPorts} inPorts={inPorts} onAdd={props.onAddEdge} />
        )}
      </div>
    </div>
  )
}

function NodeContractView(props: { node: WorkflowNode }): JSX.Element {
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
        <FieldLabel>Capability</FieldLabel>
        <span className="rounded border border-em/40 bg-em/10 px-2 py-0.5 font-mono text-[11px] text-em">
          {node.capability}
        </span>
      </div>
      <div>
        <FieldLabel>Tools</FieldLabel>
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
  editable?: boolean
  onUpdateMeta?: (patch: Partial<Pick<WorkflowDefinition, 'name' | 'description'>>) => void
  onUpdateNode?: (nodeId: string, patch: Partial<WorkflowNode>) => void
  onDeleteNode?: (nodeId: string) => void
  onAddPort?: (nodeId: string, direction: 'in' | 'out') => void
  onRemovePort?: (nodeId: string, portId: string) => void
  onRemoveEdge?: (edgeId: string) => void
  onAddEdge?: (from: string, to: string) => void
}): JSX.Element {
  const {
    workflow,
    selectedNode,
    issues,
    editable = false,
    onUpdateMeta,
    onUpdateNode,
    onDeleteNode,
    onAddPort,
    onRemovePort,
    onRemoveEdge,
    onAddEdge,
  } = props
  const errors = issues.filter((i) => i.severity === 'error').length
  const nodeIssues = selectedNode
    ? issues.filter((i) => i.nodeId === selectedNode.id || (!i.nodeId && !i.edgeId))
    : issues

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel/90 px-3 py-4">
      {selectedNode ? (
        <>
          {editable && onUpdateNode && onDeleteNode && onAddPort && onRemovePort ? (
            <NodeEditor
              node={selectedNode}
              onChange={(patch) => onUpdateNode(selectedNode.id, patch)}
              onDelete={() => onDeleteNode(selectedNode.id)}
              onAddPort={(dir) => onAddPort(selectedNode.id, dir)}
              onRemovePort={(portId) => onRemovePort(selectedNode.id, portId)}
            />
          ) : (
            <NodeContractView node={selectedNode} />
          )}
          <div>
            <FieldLabel>Node issues</FieldLabel>
            <IssueList issues={nodeIssues} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {editable && onUpdateMeta && onRemoveEdge && onAddEdge ? (
            <WorkflowMetaEditor
              workflow={workflow}
              onChange={onUpdateMeta}
              edges={workflow.edges}
              onRemoveEdge={onRemoveEdge}
              onAddEdge={onAddEdge}
            />
          ) : (
            <div>
              <div className="text-sm font-semibold text-ink">{workflow.name}</div>
              <div className="mt-0.5 font-mono text-[11px] text-ink-dim">
                v{workflow.version} · {workflow.nodes.length} nodes · {workflow.edges.length} edges
              </div>
              {workflow.description && (
                <p className="mt-2 text-xs leading-relaxed text-ink-dim">{workflow.description}</p>
              )}
            </div>
          )}
          <div>
            <FieldLabel>Validation {errors > 0 ? `(${String(errors)} errors)` : ''}</FieldLabel>
            <IssueList issues={issues} />
          </div>
          <p className="text-[11px] text-ink-dim">
            {editable
              ? 'Drag nodes on the canvas. Select a node to edit its contract. Save stores this browser catalog.'
              : 'Select a node to inspect its contract, or enable Edit to change the definition.'}
          </p>
        </div>
      )}
    </aside>
  )
}
