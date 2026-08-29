import { useRef, type JSX } from 'react'

export const DRAWER_WIDTH_DEFAULT = 240
export const DRAWER_WIDTH_MIN = 180
export const DRAWER_WIDTH_MAX = 480

export function clampDrawerWidth(w: number): number {
  if (!Number.isFinite(w)) return DRAWER_WIDTH_DEFAULT
  return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(w)))
}

/**
 * Drag handle between the conversations drawer and the transcript. Pointer
 * capture keeps the drag alive over the iframe/xterm to the right; the parent
 * owns the width state (and persistence) — this only reports deltas.
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
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="resize conversations pane"
      title="drag to resize · double-click to reset"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, base: props.width }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        props.onResize(clampDrawerWidth(drag.current.base + e.clientX - drag.current.startX))
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        const w = clampDrawerWidth(drag.current.base + e.clientX - drag.current.startX)
        drag.current = null
        props.onCommit(w)
      }}
      onDoubleClick={props.onReset}
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-em/40 active:bg-em/60"
    />
  )
}
