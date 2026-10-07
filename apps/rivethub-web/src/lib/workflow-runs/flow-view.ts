/**
 * Canvas viewport math: screen = world * k + (x, y). Pure, so zoom-at-cursor
 * and fit-to-view are testable without a canvas.
 */

import { FLOW_NODE_SIZE } from './flow-layout.js'

export interface FlowView {
  /** Screen offset of world origin, CSS px. */
  x: number
  y: number
  /** Zoom factor. */
  k: number
}

export const FLOW_ZOOM_MIN = 0.25
export const FLOW_ZOOM_MAX = 2
export const DEFAULT_FLOW_VIEW: FlowView = { x: 0, y: 0, k: 1 }
const ZOOM_DELTA_CAP = 30

export function clampZoom(k: number): number {
  return Math.min(FLOW_ZOOM_MAX, Math.max(FLOW_ZOOM_MIN, k))
}

export function screenToWorld(view: FlowView, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k }
}

/** Zoom by `factor`, keeping the world point under (sx, sy) fixed on screen. */
export function zoomAt(view: FlowView, sx: number, sy: number, factor: number): FlowView {
  const k = clampZoom(view.k * factor)
  if (k === view.k) return view
  const w = screenToWorld(view, sx, sy)
  return { k, x: sx - w.x * k, y: sy - w.y * k }
}

/**
 * View that fits every node in a `width`×`height` viewport with `pad` px of
 * margin, never zooming in past 1 (small graphs stay life-size, top-left-ish).
 */
export function fitView(
  nodes: readonly { x: number; y: number }[],
  width: number,
  height: number,
  pad = 48,
): FlowView {
  if (nodes.length === 0 || width <= 0 || height <= 0) return DEFAULT_FLOW_VIEW
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + FLOW_NODE_SIZE)
    maxY = Math.max(maxY, n.y + FLOW_NODE_SIZE)
  }
  const w = maxX - minX
  const h = maxY - minY
  const k = clampZoom(Math.min(1, (width - pad * 2) / w, (height - pad * 2) / h))
  // Center the content in the viewport.
  return { k, x: (width - w * k) / 2 - minX * k, y: (height - h * k) / 2 - minY * k }
}

/**
 * Wheel → view change. Pinch (ctrlKey on trackpads) and ⌘/Ctrl+wheel zoom at
 * the cursor; plain wheel / two-finger scroll pans.
 */
export function wheelView(
  view: FlowView,
  ev: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean; deltaMode?: number },
  sx: number,
  sy: number,
): FlowView {
  // deltaMode 1 = lines (mouse wheels on some platforms); normalize to px.
  const scale = ev.deltaMode === 1 ? 16 : 1
  const dx = ev.deltaX * scale
  const dy = ev.deltaY * scale
  if (ev.ctrlKey || ev.metaKey) {
    // Pinch streams small deltas; a mouse-wheel notch is ~100px. Capping the
    // per-event delta keeps one notch to a ~35% step instead of a jump to max.
    const d = Math.max(-ZOOM_DELTA_CAP, Math.min(ZOOM_DELTA_CAP, dy))
    return zoomAt(view, sx, sy, Math.exp(-d * 0.01))
  }
  return { ...view, x: view.x - dx, y: view.y - dy }
}
