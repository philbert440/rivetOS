/**
 * Where a canvas drag lands. All rects are in the same coordinate space as
 * `point` (world space: the caller converts the History panel's DOM rect).
 * The panel wins when the point is inside it, because the panel is painted
 * above the regions. A miss snaps back: unplace only when the hit is History.
 */

import type { Rect } from './camera.js'

export const DRAG_START_PX = 8

export interface DropRegion {
  id: string
  rect: Rect
}

export type DropHit = { kind: 'region'; id: string } | { kind: 'history' } | { kind: 'none' }

export function rectContains(rect: Rect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.w &&
    point.y <= rect.y + rect.h
  )
}

export function dropTarget(
  point: { x: number; y: number },
  regions: readonly DropRegion[],
  panelRect: Rect | null,
): DropHit {
  if (panelRect && rectContains(panelRect, point)) return { kind: 'history' }
  for (const region of regions) {
    if (rectContains(region.rect, point)) return { kind: 'region', id: region.id }
  }
  return { kind: 'none' }
}

/**
 * What a finished drag does. Dropping on empty space snaps back (the tile
 * never left). Unplace happens only when a tile is dropped on History.
 * The same region is a snap, not a rewrite.
 */
export function resolveDrop(opts: {
  source: 'tile' | 'history'
  originSpace: string | undefined
  hit: DropHit
}): 'place' | 'unplace' | 'snap' {
  if (opts.hit.kind === 'region') {
    if (opts.source === 'tile' && opts.hit.id === opts.originSpace) return 'snap'
    return 'place'
  }
  if (opts.hit.kind === 'history' && opts.source === 'tile') return 'unplace'
  return 'snap'
}

/** Stage-local pointer → world, using the camera's screen translate and zoom. */
export function clientToWorld(
  client: { x: number; y: number },
  stage: { left: number; top: number },
  cam: { tx: number; ty: number; z: number },
): { x: number; y: number } {
  const z = cam.z > 0 ? cam.z : 0.04
  return {
    x: (client.x - stage.left - cam.tx) / z,
    y: (client.y - stage.top - cam.ty) / z,
  }
}

export function clientRectToWorld(
  rect: { left: number; top: number; right: number; bottom: number },
  stage: { left: number; top: number },
  cam: { tx: number; ty: number; z: number },
): Rect {
  const origin = clientToWorld({ x: rect.left, y: rect.top }, stage, cam)
  const far = clientToWorld({ x: rect.right, y: rect.bottom }, stage, cam)
  return { x: origin.x, y: origin.y, w: far.x - origin.x, h: far.y - origin.y }
}
