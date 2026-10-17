import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'

export const DRAWER_WIDTH_DEFAULT = 240
export const DRAWER_WIDTH_MIN = 180
export const DRAWER_WIDTH_MAX = 480

export function clampDrawerWidth(
  w: number,
  min = DRAWER_WIDTH_MIN,
  max = DRAWER_WIDTH_MAX,
  fallback = DRAWER_WIDTH_DEFAULT,
): number {
  if (!Number.isFinite(w)) return fallback
  return Math.min(max, Math.max(min, Math.round(w)))
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
  /** Which side of its pane the handle sits on. A right-hand pane (handle on
   *  its left edge) grows as the pointer moves left. Default 'right'. */
  edge?: 'left' | 'right'
  min?: number
  max?: number
  label?: string
  className?: string
}): JSX.Element {
  const drag = useRef<{ startX: number; base: number } | null>(null)
  const min = props.min ?? DRAWER_WIDTH_MIN
  const max = props.max ?? DRAWER_WIDTH_MAX
  const sign = props.edge === 'left' ? -1 : 1
  const clamp = (w: number): number => clampDrawerWidth(w, min, max, props.width)
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture already gone */
    }
    if (commit) props.onCommit(clamp(d.base + sign * (e.clientX - d.startX)))
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label ?? 'resize workspace pane'}
      aria-valuemin={min}
      aria-valuemax={max}
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
        props.onResize(clamp(d.base + sign * (e.clientX - d.startX)))
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
        const grow = (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP) * sign
        props.onCommit(clamp(props.width + grow))
      }}
      className={`w-1 shrink-0 cursor-col-resize bg-transparent transition-colors outline-none hover:bg-em/40 focus-visible:bg-em/40 active:bg-em/60 ${props.className ?? ''}`}
    />
  )
}
