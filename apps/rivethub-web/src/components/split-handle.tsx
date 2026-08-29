import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'

export const DRAWER_WIDTH_DEFAULT = 240
export const DRAWER_WIDTH_MIN = 180
export const DRAWER_WIDTH_MAX = 480

export function clampDrawerWidth(w: number): number {
  if (!Number.isFinite(w)) return DRAWER_WIDTH_DEFAULT
  return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(w)))
}

const KEY_STEP = 16

/**
 * Drag handle between the conversations drawer and the transcript. Pointer
 * capture keeps the drag alive over the iframe/xterm to the right; the parent
 * owns the width state (and persistence) — this only reports clamped widths.
 * Drag state must die with the capture: pointercancel / lostpointercapture /
 * a move with no buttons all end the drag (uncommitted), or a stuck ref keeps
 * resizing with nothing held down.
 */
export function SplitHandle(props: {
  /** Live width during a drag: base width at pointer-down + delta. */
  onResize: (width: number) => void
  /** Drag finished — persist the final width. */
  onCommit: (width: number) => void
  onReset: () => void
  width: number
}): JSX.Element {
  const drag = useRef<{ startX: number; base: number } | null>(null)
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture already gone */
    }
    if (commit) props.onCommit(clampDrawerWidth(d.base + e.clientX - d.startX))
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="resize conversations pane"
      aria-valuemin={DRAWER_WIDTH_MIN}
      aria-valuemax={DRAWER_WIDTH_MAX}
      aria-valuenow={props.width}
      tabIndex={0}
      title="drag to resize · double-click to reset"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, base: props.width }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        if (e.buttons === 0) {
          // button already released — some UAs emit this move before the
          // pointerup. The user finished a drag, so COMMIT it; only
          // pointercancel/lostpointercapture abandon uncommitted.
          endDrag(e, true)
          return
        }
        props.onResize(clampDrawerWidth(d.base + e.clientX - d.startX))
      }}
      // detail === 2: second click of a double-click — let onDoubleClick's
      // reset stand instead of committing a 0px "drag" over it
      onPointerUp={(e) => endDrag(e, e.detail < 2)}
      onPointerCancel={(e) => endDrag(e, false)}
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onDoubleClick={props.onReset}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        props.onCommit(
          clampDrawerWidth(props.width + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP)),
        )
      }}
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors outline-none hover:bg-em/40 focus-visible:bg-em/40 active:bg-em/60"
    />
  )
}
