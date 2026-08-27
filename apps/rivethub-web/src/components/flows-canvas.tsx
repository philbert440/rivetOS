/**
 * Flows canvas — pan, select, drag nodes, wire output→input ports.
 */

import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { FLOW_NODE_SIZE } from '../lib/workflow-runs/flow-layout.js'
import { flowNodeFamily, type FlowNodeFamily } from '../lib/workflow-runs/flow-kind.js'
import {
  canConnect,
  connectFlowNodes,
  updateFlowNode,
  type FlowAuthorGraph,
  type FlowAuthorKind,
  type FlowAuthorNode,
} from '../lib/workflow-runs/flow-graph.js'
import {
  CANVAS_STATUS_EDGE,
  CANVAS_STATUS_STROKE,
  isLiveNodeStatus,
  overlayEdgeKind,
} from '../lib/workflow-runs/flow-overlay.js'
import { GRAPH_NODE_STATUS_LABELS, type GraphNodeStatus } from '../lib/workflow-runs/status.js'

const FAMILY_FILL: Record<FlowNodeFamily, string> = {
  entry: '#253041',
  action: '#0f766e',
  operator: '#92400e',
}
const SCRIPT_FILL = '#1d4ed8'
const PORT_R = 5
const PORT_SLOP = 14

export interface FlowsCanvasProps {
  graph: FlowAuthorGraph
  selectedId?: string
  onSelect?: (id: string | null) => void
  onChange?: (graph: FlowAuthorGraph) => void
  editable?: boolean
  /** Journal status keyed by authoring node id — same canvas, live overlay. */
  statusById?: Record<string, GraphNodeStatus>
  className?: string
}

function fillFor(kind: FlowAuthorKind): string {
  if (kind === 'run') return SCRIPT_FILL
  return FAMILY_FILL[flowNodeFamily(kind)]
}

function nodeRadii(kind: FlowAuthorKind): [number, number, number, number] {
  const family = flowNodeFamily(kind)
  if (family === 'entry') return [6, FLOW_NODE_SIZE / 2, FLOW_NODE_SIZE / 2, 6]
  if (family === 'operator') return [24, 24, 24, 24]
  return [12, 12, 12, 12]
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): void {
  const [tl, tr, br, bl] = radii
  ctx.beginPath()
  ctx.moveTo(x + tl, y)
  ctx.lineTo(x + w - tr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr)
  ctx.lineTo(x + w, y + h - br)
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h)
  ctx.lineTo(x + bl, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl)
  ctx.lineTo(x, y + tl)
  ctx.quadraticCurveTo(x, y, x + tl, y)
  ctx.closePath()
}

function outPort(n: FlowAuthorNode): { x: number; y: number } {
  return { x: n.x + FLOW_NODE_SIZE, y: n.y + FLOW_NODE_SIZE / 2 }
}
function inPort(n: FlowAuthorNode): { x: number; y: number } {
  return { x: n.x, y: n.y + FLOW_NODE_SIZE / 2 }
}

function hitPort(
  nodes: FlowAuthorNode[],
  x: number,
  y: number,
): { id: string; side: 'in' | 'out' } | undefined {
  let best: { id: string; side: 'in' | 'out'; d: number } | undefined
  for (const n of nodes) {
    if (n.kind !== 'done') {
      const p = outPort(n)
      const d = Math.hypot(x - p.x, y - p.y)
      if (d <= PORT_SLOP && (!best || d < best.d)) best = { id: n.id, side: 'out', d }
    }
    if (n.kind !== 'start') {
      const p = inPort(n)
      const d = Math.hypot(x - p.x, y - p.y)
      if (d <= PORT_SLOP && (!best || d < best.d)) best = { id: n.id, side: 'in', d }
    }
  }
  return best ? { id: best.id, side: best.side } : undefined
}

function hitNode(nodes: FlowAuthorNode[], x: number, y: number): FlowAuthorNode | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (!n) continue
    if (x >= n.x && x <= n.x + FLOW_NODE_SIZE && y >= n.y && y <= n.y + FLOW_NODE_SIZE) return n
  }
  return undefined
}

function drawBezier(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  color: string,
): void {
  const c = Math.max(24, Math.min(80, (tx - sx) / 2))
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.bezierCurveTo(sx + c, sy, tx - c, ty, tx, ty)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  graph: FlowAuthorGraph,
  pan: { x: number; y: number },
  selectedId: string | undefined,
  hover: { id: string; side?: 'in' | 'out' } | undefined,
  connecting: { fromId: string; x: number; y: number } | undefined,
  statusById: Record<string, GraphNodeStatus> | undefined,
  pulse: number,
  cssW: number,
  cssH: number,
): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const dpr = ctx.canvas.width / cssW || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.fillStyle = '#0d1117'
  ctx.fillRect(0, 0, cssW, cssH)
  ctx.fillStyle = 'rgba(52, 211, 153, 0.22)'
  const grid = 25
  const ox = pan.x % grid
  const oy = pan.y % grid
  for (let x = ox; x < cssW; x += grid) {
    for (let y = oy; y < cssH; y += grid) {
      ctx.beginPath()
      ctx.arc(x, y, 1, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.translate(pan.x, pan.y)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  for (const e of graph.edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) continue
    const s = outPort(from)
    const t = inPort(to)
    const kind = statusById ? overlayEdgeKind(statusById[from.id], statusById[to.id]) : 'done'
    drawBezier(ctx, s.x, s.y, t.x, t.y, CANVAS_STATUS_EDGE[kind])
  }

  if (connecting) {
    const from = byId.get(connecting.fromId)
    if (from) {
      const s = outPort(from)
      drawBezier(ctx, s.x, s.y, connecting.x, connecting.y, '#34d399')
    }
  }

  for (const n of graph.nodes) {
    const fill = fillFor(n.kind)
    const status = statusById ? (statusById[n.id] ?? 'pending') : undefined
    ctx.save()
    if (status === 'pending') ctx.globalAlpha = 0.48
    ctx.fillStyle = fill
    roundRect(ctx, n.x, n.y, FLOW_NODE_SIZE, FLOW_NODE_SIZE, nodeRadii(n.kind))
    ctx.fill()
    if (status === 'failed') {
      ctx.globalAlpha = 0.35
      ctx.fillStyle = '#f87171'
      roundRect(ctx, n.x, n.y, FLOW_NODE_SIZE, FLOW_NODE_SIZE, nodeRadii(n.kind))
      ctx.fill()
    }
    ctx.restore()

    if (status && isLiveNodeStatus(status)) {
      ctx.save()
      ctx.globalAlpha = 0.25 + pulse * 0.45
      ctx.lineWidth = 8
      ctx.strokeStyle = CANVAS_STATUS_STROKE[status]
      roundRect(ctx, n.x - 3, n.y - 3, FLOW_NODE_SIZE + 6, FLOW_NODE_SIZE + 6, nodeRadii(n.kind))
      ctx.stroke()
      ctx.restore()
    }

    ctx.lineWidth = n.id === selectedId ? 3 : 2
    ctx.strokeStyle =
      n.id === selectedId
        ? '#e6edf3'
        : status
          ? CANVAS_STATUS_STROKE[status]
          : 'rgba(255,255,255,0.35)'
    roundRect(ctx, n.x, n.y, FLOW_NODE_SIZE, FLOW_NODE_SIZE, nodeRadii(n.kind))
    ctx.stroke()

    const portY = n.y + FLOW_NODE_SIZE / 2
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    if (n.kind !== 'start') {
      ctx.fillStyle = hover?.id === n.id && hover.side === 'in' ? '#ffffff' : fill
      ctx.beginPath()
      ctx.arc(n.x, portY, hover?.id === n.id && hover.side === 'in' ? 8 : PORT_R, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    if (n.kind !== 'done') {
      ctx.fillStyle = hover?.id === n.id && hover.side === 'out' ? '#ffffff' : fill
      ctx.beginPath()
      ctx.arc(
        n.x + FLOW_NODE_SIZE,
        portY,
        hover?.id === n.id && hover.side === 'out' ? 8 : PORT_R,
        0,
        Math.PI * 2,
      )
      ctx.fill()
      ctx.stroke()
    }

    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '13px "DM Sans", system-ui, sans-serif'
    const maxW = FLOW_NODE_SIZE - 16
    let label = n.label
    if (ctx.measureText(label).width > maxW) {
      while (label.length > 1 && ctx.measureText(`${label}…`).width > maxW)
        label = label.slice(0, -1)
      label = `${label}…`
    }
    ctx.fillText(label, n.x + FLOW_NODE_SIZE / 2, n.y + FLOW_NODE_SIZE / 2)
    ctx.font = '11px "JetBrains Mono", ui-monospace, monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    const sub = status ? GRAPH_NODE_STATUS_LABELS[status] : n.kind === 'run' ? 'script' : n.kind
    ctx.fillText(sub, n.x + FLOW_NODE_SIZE / 2, n.y + FLOW_NODE_SIZE / 2 + 16)
  }
  ctx.restore()
}

export function FlowsCanvas(props: FlowsCanvasProps): JSX.Element {
  const { graph, selectedId, onSelect, onChange, editable = false, statusById, className } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hover, setHover] = useState<{ id: string; side?: 'in' | 'out' } | undefined>()
  const [panning, setPanning] = useState(false)
  const [connecting, setConnecting] = useState<
    { fromId: string; x: number; y: number } | undefined
  >()
  const drag = useRef<{
    pointerId: number
    lastX: number
    lastY: number
    mode: 'pan' | 'node' | 'connect'
    nodeId?: string
  } | null>(null)
  const [pulse, setPulse] = useState(0)
  const liveOverlay = Boolean(
    statusById && Object.values(statusById).some((s) => isLiveNodeStatus(s)),
  )

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cssW = wrap.clientWidth
    const cssH = wrap.clientHeight
    const dpr = window.devicePixelRatio || 1
    const pw = Math.max(1, Math.floor(cssW * dpr))
    const ph = Math.max(1, Math.floor(cssH * dpr))
    if (canvas.width !== pw) canvas.width = pw
    if (canvas.height !== ph) canvas.height = ph
    canvas.style.width = `${String(cssW)}px`
    canvas.style.height = `${String(cssH)}px`
    drawScene(ctx, graph, pan, selectedId, hover, connecting, statusById, pulse, cssW, cssH)
  }, [graph, pan, selectedId, hover, connecting, statusById, pulse])

  useEffect(() => {
    paint()
  }, [paint])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => paint())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [paint])

  useEffect(() => {
    if (!liveOverlay) {
      setPulse(0)
      return
    }
    let raf = 0
    const tick = (t: number): void => {
      setPulse((Math.sin(t / 280) + 1) / 2)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [liveOverlay])

  const toWorld = (ev: PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: ev.clientX - rect.left - pan.x, y: ev.clientY - rect.top - pan.y }
  }

  const onPointerDown = (ev: PointerEvent<HTMLCanvasElement>): void => {
    const world = toWorld(ev)
    ev.currentTarget.setPointerCapture(ev.pointerId)
    const port = hitPort(graph.nodes, world.x, world.y)
    if (editable && port?.side === 'out') {
      drag.current = {
        pointerId: ev.pointerId,
        lastX: ev.clientX,
        lastY: ev.clientY,
        mode: 'connect',
      }
      setConnecting({ fromId: port.id, x: world.x, y: world.y })
      onSelect?.(port.id)
      return
    }
    const node = hitNode(graph.nodes, world.x, world.y)
    if (node) {
      onSelect?.(node.id)
      drag.current = {
        pointerId: ev.pointerId,
        lastX: ev.clientX,
        lastY: ev.clientY,
        mode: editable ? 'node' : 'pan',
        nodeId: node.id,
      }
      return
    }
    onSelect?.(null)
    drag.current = { pointerId: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY, mode: 'pan' }
    setPanning(true)
  }

  const onPointerMove = (ev: PointerEvent<HTMLCanvasElement>): void => {
    const world = toWorld(ev)
    const port = hitPort(graph.nodes, world.x, world.y)
    if (port) setHover(port)
    else {
      const n = hitNode(graph.nodes, world.x, world.y)
      setHover(n ? { id: n.id } : undefined)
    }
    const d = drag.current
    if (!d || d.pointerId !== ev.pointerId) return
    if (d.mode === 'connect') {
      setConnecting((c) => (c ? { ...c, x: world.x, y: world.y } : c))
      return
    }
    const dx = ev.clientX - d.lastX
    const dy = ev.clientY - d.lastY
    d.lastX = ev.clientX
    d.lastY = ev.clientY
    if (d.mode === 'pan') setPan((p) => ({ x: p.x + dx, y: p.y + dy }))
    if (d.mode === 'node' && d.nodeId) {
      const n = graph.nodes.find((x) => x.id === d.nodeId)
      if (n) onChange?.(updateFlowNode(graph, n.id, { x: n.x + dx, y: n.y + dy }))
    }
  }

  const onPointerUp = (ev: PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== ev.pointerId) return
    if (d.mode === 'connect' && connecting) {
      const world = toWorld(ev)
      const port = hitPort(graph.nodes, world.x, world.y)
      const target = port?.side === 'in' ? port.id : hitNode(graph.nodes, world.x, world.y)?.id
      if (target && canConnect(graph, connecting.fromId, target).ok) {
        onChange?.(connectFlowNodes(graph, connecting.fromId, target))
      }
    }
    drag.current = null
    setPanning(false)
    setConnecting(undefined)
  }

  let cursor = 'grab'
  if (panning) cursor = 'grabbing'
  else if (connecting) cursor = 'crosshair'
  else if (hover?.side === 'out') cursor = 'crosshair'
  else if (hover?.id) cursor = 'pointer'

  return (
    <div ref={wrapRef} className={`relative min-h-0 min-w-0 flex-1 ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Workflow flows canvas"
        className="block size-full"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
}
