/**
 * Edge-swipe recognizer for the narrow drawers (Phil 2026-09-03: horizontal
 * swipes belong to the drawers — the chat↔terminal swipe is gone; the
 * Terminal|Chat segment is the only mode switch).
 *
 *   - LEFT  edge swipe (start within 24px of the left bezel, travel ≥ 40px
 *     inward) opens the left navigation drawer.
 *   - RIGHT edge swipe (mirror) opens the right history (conversations)
 *     drawer.
 *
 * Pure model + a tiny tracker the pointer-event wiring drives. Vertical-
 * dominant movement never fires — scrolling up a transcript that happens to
 * start at the bezel must not yank a drawer open.
 */

export const EDGE_ZONE_PX = 24
export const EDGE_TRAVEL_PX = 40

export type EdgeSide = 'left' | 'right'

/** Which bezel a gesture started on, if any. */
export function edgeAt(
  startX: number,
  viewportWidth: number,
  zone: number = EDGE_ZONE_PX,
): EdgeSide | null {
  if (startX <= zone) return 'left'
  if (startX >= viewportWidth - zone) return 'right'
  return null
}

/** Whether the gesture so far is an inward open swipe from `side`. */
export function isEdgeOpenSwipe(
  side: EdgeSide,
  startX: number,
  x: number,
  startY: number,
  y: number,
  travel: number = EDGE_TRAVEL_PX,
): boolean {
  const dx = x - startX
  const dy = y - startY
  // Horizontal must dominate, or a scroll starting at the bezel opens a drawer.
  if (Math.abs(dx) <= Math.abs(dy)) return false
  return side === 'left' ? dx >= travel : -dx >= travel
}

/** Stateful recognizer: feed pointer events, get the side to open (once per
 *  gesture). */
export class EdgeSwipeTracker {
  private start: { x: number; y: number; side: EdgeSide } | null = null
  private fired = false

  down(x: number, y: number, viewportWidth: number): void {
    const side = edgeAt(x, viewportWidth)
    this.start = side ? { x, y, side } : null
    this.fired = false
  }

  /** Returns the drawer side to open, or null while the gesture is
   *  unresolved / not an open swipe. */
  move(x: number, y: number): EdgeSide | null {
    if (!this.start || this.fired) return null
    if (!isEdgeOpenSwipe(this.start.side, this.start.x, x, this.start.y, y)) return null
    this.fired = true
    return this.start.side
  }

  up(): void {
    this.start = null
    this.fired = false
  }
}
