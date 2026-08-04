/**
 * Product-Map-style workflow canvas: positioned node cards + SVG edges.
 * View/select only (no drag-edit in MVP).
 */

import type { JSX } from 'react'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgePaths,
  graphBounds,
  portAnchor,
  type CapabilityMode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../lib/workflows/index.js'
import { cn } from '../lib/utils.js'

const CAP_RING: Record<CapabilityMode, string> = {
  'read-only': 'border-line',
  'read-write': 'border-em/50',
  execute: 'border-em',
  all: 'border-em shadow-[0_0_0_1px_rgba(52,211,153,0.35)]',
}

const KIND_GLYPH: Record<string, string> = {
  source: '▸',
  agent: '◎',
  tool: '⚙',
  verify: '✓',
  gate: '◇',
  action: '⚡',
  sink: '■',
}

function toolsLabel(node: WorkflowNode): string {
  const parts: string[] = []
  if (node.tools && node.tools.length > 0) parts.push(node.tools.join(', '))
  if (node.toolProfile) parts.push(`profile:${node.toolProfile}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

function PortPips(props: { node: WorkflowNode; side: 'in' | 'out' }): JSX.Element | null {
  const ports = props.side === 'in' ? props.node.inputs : props.node.outputs
  if (ports.length === 0) return null
  return (
    <>
      {ports.map((p) => {
        const a = portAnchor(props.node, p.id)
        if (!a) return null
        // Position relative to the card (absolute within node button)
        const left = props.side === 'in' ? -4 : NODE_WIDTH - 4
        const top = a.y - props.node.position.y - 4
        return (
          <span
            key={p.id}
            title={`${p.id} (${p.kind})`}
            className={cn(
              'pointer-events-none absolute z-20 size-2 rounded-full border',
              p.kind === 'control' ? 'border-em bg-em' : 'border-line bg-panel-2',
            )}
            style={{ left, top }}
          />
        )
      })}
    </>
  )
}

function NodeCard(props: {
  node: WorkflowNode
  selected: boolean
  onSelect: (id: string) => void
}): JSX.Element {
  const { node, selected, onSelect } = props
  const tools = toolsLabel(node)
  const ioSummary = `in:${String(node.inputs.length)} · out:${String(node.outputs.length)}`

  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
      className={cn(
        'absolute z-10 flex flex-col items-start overflow-visible rounded-md border bg-panel px-2.5 py-2 text-left shadow-sm transition-colors',
        CAP_RING[node.capability],
        selected ? 'ring-2 ring-em bg-panel-2' : 'hover:border-em/70',
      )}
    >
      <PortPips node={node} side="in" />
      <PortPips node={node} side="out" />
      <span className="flex w-full items-center gap-1.5">
        <span className="font-mono text-[11px] text-em">{KIND_GLYPH[node.kind] ?? '•'}</span>
        <span className="truncate text-xs font-semibold text-ink">{node.label}</span>
      </span>
      <span className="mt-1 flex w-full items-center justify-between gap-1 font-mono text-[10px] text-ink-dim">
        <span className="truncate text-em/90">{node.capability}</span>
        <span className="shrink-0">{ioSummary}</span>
      </span>
      <span className="mt-0.5 w-full truncate font-mono text-[10px] text-ink-dim" title={tools}>
        {tools}
      </span>
    </button>
  )
}

export function WorkflowCanvas(props: {
  workflow: WorkflowDefinition
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
}): JSX.Element {
  const { workflow, selectedNodeId, onSelectNode } = props
  const bounds = graphBounds(workflow)
  const paths = edgePaths(workflow)
  const width = bounds.width + Math.max(0, bounds.minX)
  const height = bounds.height + Math.max(0, bounds.minY)

  return (
    <div
      className="relative min-h-[320px] flex-1 overflow-auto rounded-lg border border-line bg-bg/80"
      onClick={() => onSelectNode(null)}
      role="presentation"
    >
      <div
        className="relative"
        style={{
          width,
          height,
          minWidth: '100%',
          minHeight: 320,
        }}
      >
        <svg
          className="pointer-events-none absolute inset-0 z-0"
          width={width}
          height={height}
          aria-hidden
        >
          {paths.map((p) => (
            <path
              key={p.edgeId}
              d={p.d}
              fill="none"
              stroke={p.control ? '#34d399' : '#253041'}
              strokeWidth={p.control ? 1.75 : 1.5}
              strokeDasharray={p.control ? '5 3' : undefined}
              opacity={0.9}
            />
          ))}
        </svg>

        {workflow.nodes.map((node) => (
          <div key={node.id} onClick={(e) => e.stopPropagation()} role="presentation">
            <NodeCard node={node} selected={selectedNodeId === node.id} onSelect={onSelectNode} />
          </div>
        ))}
      </div>
    </div>
  )
}
