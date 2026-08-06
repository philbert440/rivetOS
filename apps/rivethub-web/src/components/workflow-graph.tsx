/**
 * Inline-SVG workflow graph (slice H). No chart libs (strict CSP).
 * Thin render of projectGraph() output — layout is vertical layered;
 * parallel branch nodes share a row as lanes.
 */

import { useMemo, type JSX } from 'react'
import type { GraphEdge, GraphNode } from '../lib/workflow-runs/graph-project.js'
import { GRAPH_NODE_STATUS_LABELS, GRAPH_NODE_STATUS_STROKE } from '../lib/workflow-runs/status.js'

const NODE_W = 200
const NODE_H = 44
const ROW_GAP = 28
const COL_GAP = 16
const PAD_X = 24
const PAD_Y = 20
const LANE_W = NODE_W + COL_GAP

export interface WorkflowGraphProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Navigate to a child run when a call node with childRunId is clicked. */
  onNodeClick?: (node: GraphNode) => void
  className?: string
}

interface LaidOut extends GraphNode {
  x: number
  y: number
  row: number
  col: number
}

/**
 * Assign rows: spine nodes (no branchIndex) one per row in display order.
 * Branch nodes share the row immediately after their parallel parent,
 * laid out as horizontal lanes (col = branchIndex).
 */
function layoutNodes(nodes: GraphNode[]): LaidOut[] {
  if (nodes.length === 0) return []

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const spine = nodes.filter((n) => n.branchIndex === undefined)
  const branches = nodes.filter((n) => n.branchIndex !== undefined)

  // Group branches by parallel parent
  const branchesByParent = new Map<string, GraphNode[]>()
  for (const b of branches) {
    const p = b.parallelParentId ?? '_'
    const list = branchesByParent.get(p) ?? []
    list.push(b)
    branchesByParent.set(p, list)
  }
  for (const list of branchesByParent.values()) {
    list.sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0))
  }

  const laid: LaidOut[] = []
  let row = 0
  const placed = new Set<string>()

  for (const n of spine) {
    laid.push({
      ...n,
      x: PAD_X,
      y: PAD_Y + row * (NODE_H + ROW_GAP),
      row,
      col: 0,
    })
    placed.add(n.id)
    row++

    const kids = branchesByParent.get(n.id)
    if (kids && kids.length > 0) {
      for (const k of kids) {
        const col = k.branchIndex ?? 0
        laid.push({
          ...k,
          x: PAD_X + col * LANE_W,
          y: PAD_Y + row * (NODE_H + ROW_GAP),
          row,
          col,
        })
        placed.add(k.id)
      }
      row++
    }
  }

  // Orphan branches / any remaining nodes
  for (const n of nodes) {
    if (placed.has(n.id)) continue
    const col = n.branchIndex ?? 0
    laid.push({
      ...n,
      x: PAD_X + col * LANE_W,
      y: PAD_Y + row * (NODE_H + ROW_GAP),
      row,
      col,
    })
    placed.add(n.id)
    // advance row only when not packing more branches of same parent
    if (n.branchIndex === undefined) row++
  }

  // Ensure we didn't drop anyone referenced only via byId
  void byId
  return laid
}

function bounds(laid: LaidOut[]): { w: number; h: number } {
  if (laid.length === 0) return { w: 320, h: 80 }
  let maxX = 0
  let maxY = 0
  for (const n of laid) {
    maxX = Math.max(maxX, n.x + NODE_W)
    maxY = Math.max(maxY, n.y + NODE_H)
  }
  return { w: maxX + PAD_X, h: maxY + PAD_Y }
}

function edgePath(from: LaidOut, to: LaidOut): string {
  const x1 = from.x + NODE_W / 2
  const y1 = from.y + NODE_H
  const x2 = to.x + NODE_W / 2
  const y2 = to.y
  // Straight vertical when same column; mild elbow otherwise
  if (Math.abs(x1 - x2) < 2) {
    return `M ${String(x1)} ${String(y1)} L ${String(x2)} ${String(y2)}`
  }
  const midY = (y1 + y2) / 2
  return `M ${String(x1)} ${String(y1)} L ${String(x1)} ${String(midY)} L ${String(x2)} ${String(midY)} L ${String(x2)} ${String(y2)}`
}

export function WorkflowGraph(props: WorkflowGraphProps): JSX.Element {
  const { nodes, edges, onNodeClick, className } = props

  const laid = useMemo(() => layoutNodes(nodes), [nodes])
  const laidById = useMemo(() => new Map(laid.map((n) => [n.id, n])), [laid])
  const { w, h } = useMemo(() => bounds(laid), [laid])

  if (nodes.length === 0) {
    return <p className={`font-mono text-xs text-ink-dim ${className ?? ''}`}>no steps to graph</p>
  }

  return (
    <div className={`overflow-x-auto rounded border border-line bg-panel ${className ?? ''}`}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${String(w)} ${String(h)}`}
        role="img"
        aria-label="Workflow step graph"
        className="block max-w-full"
      >
        <defs>
          <marker
            id="wf-graph-arrow-exec"
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-em-dim)" />
          </marker>
          <marker
            id="wf-graph-arrow-decl"
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-line)" />
          </marker>
        </defs>

        {/* Edges under nodes */}
        <g aria-hidden="true">
          {edges.map((e) => {
            const from = laidById.get(e.from)
            const to = laidById.get(e.to)
            if (!from || !to) return null
            const dashed = e.kind === 'declared'
            return (
              <path
                key={e.id}
                d={edgePath(from, to)}
                fill="none"
                stroke={dashed ? 'var(--color-line)' : 'var(--color-em-dim)'}
                strokeWidth={1.5}
                strokeDasharray={dashed ? '5 4' : undefined}
                opacity={dashed ? 0.7 : 0.9}
                markerEnd={dashed ? 'url(#wf-graph-arrow-decl)' : 'url(#wf-graph-arrow-exec)'}
              />
            )
          })}
        </g>

        {/* Nodes */}
        {laid.map((n) => {
          const stroke = GRAPH_NODE_STATUS_STROKE[n.status]
          // Clickable when handler is provided; call nodes with childRunId show a link affordance.
          const clickable = Boolean(onNodeClick)
          const isLink = Boolean(n.childRunId) && (n.kind === 'call' || !n.kind)
          const title = [
            n.label,
            n.kind ? `kind=${n.kind}` : undefined,
            GRAPH_NODE_STATUS_LABELS[n.status],
            n.iterations && n.iterations > 1 ? `×${String(n.iterations)}` : undefined,
            n.childRunId ? `child=${n.childRunId}` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')

          return (
            <g
              key={n.id}
              transform={`translate(${String(n.x)}, ${String(n.y)})`}
              role={clickable ? 'button' : 'group'}
              tabIndex={clickable ? 0 : undefined}
              aria-label={title}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onClick={() => onNodeClick?.(n)}
              onKeyDown={(ev) => {
                if (!onNodeClick) return
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  onNodeClick(n)
                }
              }}
            >
              <title>{title}</title>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                ry={6}
                fill="var(--color-panel-2)"
                stroke={stroke}
                strokeWidth={n.status === 'running' || n.status === 'gate-open' ? 2 : 1.25}
              />
              {/* Status pip */}
              <circle cx={14} cy={NODE_H / 2} r={4} fill={stroke} />
              {/* Label */}
              <text
                x={26}
                y={NODE_H / 2 - (n.kind ? 4 : 0)}
                dominantBaseline="middle"
                fill="var(--color-ink)"
                fontFamily="var(--font-mono)"
                fontSize={12}
              >
                {truncate(n.label, isLink ? 16 : 20)}
                {isLink ? ' →' : ''}
              </text>
              {n.kind && (
                <text
                  x={26}
                  y={NODE_H / 2 + 12}
                  dominantBaseline="middle"
                  fill="var(--color-ink-dim)"
                  fontFamily="var(--font-mono)"
                  fontSize={10}
                >
                  {n.kind}
                  {n.branchIndex !== undefined ? ` · b${String(n.branchIndex)}` : ''}
                </text>
              )}
              {/* Iteration badge */}
              {n.iterations !== undefined && n.iterations > 1 && (
                <g transform={`translate(${String(NODE_W - 36)}, 8)`}>
                  <rect
                    width={28}
                    height={16}
                    rx={8}
                    fill="var(--color-bg)"
                    stroke="var(--color-line)"
                  />
                  <text
                    x={14}
                    y={9}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="var(--color-ink-dim)"
                    fontFamily="var(--font-mono)"
                    fontSize={10}
                  >
                    ×{String(n.iterations)}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
      <div className="flex flex-wrap gap-3 border-t border-line px-3 py-1.5 font-mono text-[10px] text-ink-dim">
        <span>
          <span
            className="mr-1 inline-block h-px w-3 align-middle"
            style={{ background: 'var(--color-em-dim)' }}
          />
          execution
        </span>
        <span>
          <span
            className="mr-1 inline-block h-px w-3 align-middle"
            style={{
              background:
                'repeating-linear-gradient(90deg, var(--color-line) 0 3px, transparent 3px 5px)',
            }}
          />
          declared
        </span>
      </div>
    </div>
  )
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// Re-export edge type usage for callers that only import the component
export type { GraphEdge, GraphNode }
