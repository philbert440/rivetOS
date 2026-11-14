import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react'
import { cn } from '../lib/utils.js'
import { turnLabel, type TurnRailItem } from '../lib/turn-rail.js'

/**
 * Turn rail — the ladder of marks on the transcript's right edge, one per
 * user prompt (after the DeepSeek Harness chat's TurnNavigator). Hover or
 * focus a mark to preview the prompt and the reply; click to scroll the
 * transcript there. The active mark follows the reading position; while the
 * pointer is off the rail the ladder keeps that mark in view, scrolling
 * inside its own frame (fade-masked ends) once it outgrows the band.
 *
 * Sized and placed by the parent: absolute inside Transcript's `relative`
 * frame, hidden below the `@[900px]` container width — a transcript that
 * narrow has no gutter for it. The frame itself takes pointer events; the
 * slot around it does not, so the transcript stays clickable right up to
 * the marks.
 */

/** Fixed pitch between marks; overflow scrolls inside the frame. */
const PITCH_PX = 10
/** Fade band reserved at a scrollable end. */
const FADE_PX = 24
/** Preview card height budget (drives the clamp that keeps it in frame). */
const PREVIEW_H_PX = 100

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

const Mark = memo(function Mark(props: {
  item: TurnRailItem
  active: boolean
  preview: boolean
  previewId: string
  onJump: (item: TurnRailItem) => void
  onPreview: (index: number | null) => void
}): JSX.Element {
  const label = props.item.prompt || turnLabel(props.item.index)
  return (
    <button
      type="button"
      data-rail-index={props.item.index}
      className="group/mark relative block h-[10px] w-full cursor-pointer border-0 bg-transparent p-0 outline-none"
      aria-label={`jump to ${turnLabel(props.item.index)}: ${label}`}
      aria-current={props.active ? 'true' : undefined}
      aria-describedby={props.preview ? props.previewId : undefined}
      onPointerMove={() => props.onPreview(props.item.index)}
      onFocus={() => props.onPreview(props.item.index)}
      onBlur={() => props.onPreview(null)}
      onClick={() => props.onJump(props.item)}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 right-0 h-0.5 w-5 origin-right -translate-y-1/2 rounded-full transition-[transform,background-color] duration-150',
          props.active
            ? 'scale-x-100 bg-ink'
            : props.preview
              ? 'scale-x-90 bg-ink-dim'
              : 'scale-x-[0.6] bg-line',
          'group-focus-visible/mark:scale-x-100 group-focus-visible/mark:bg-em',
        )}
      />
    </button>
  )
})

export function TurnNavigator(props: {
  items: readonly TurnRailItem[]
  /** Index of the turn under the reading line, or null. */
  activeIndex: number | null
  onJump: (item: TurnRailItem) => void
  className?: string
}): JSX.Element | null {
  const { items, activeIndex, onJump } = props
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pointerInside = useRef(false)
  const previewId = useId()

  // Keep the active mark in view (centered) while the pointer is elsewhere.
  // Inside the frame the hand owns the scroll position.
  const followIndex = activeIndex
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || followIndex === null || pointerInside.current) return
    const height = el.clientHeight
    if (height <= 0) return
    const center = followIndex * PITCH_PX + PITCH_PX / 2
    const visibleFrom = el.scrollTop + FADE_PX
    const visibleTo = el.scrollTop + height - FADE_PX
    if (center >= visibleFrom && center <= visibleTo) return
    const max = Math.max(0, el.scrollHeight - height)
    const target = Math.max(0, Math.min(max, center - height / 2))
    el.scrollTo({ top: target, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [followIndex, items.length])

  const measureEdges = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.scrollTop > 1
    const bottom = el.scrollTop < el.scrollHeight - el.clientHeight - 1
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
  }, [])
  useEffect(measureEdges, [items.length, measureEdges])
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measureEdges)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measureEdges])

  if (items.length < 2) return null

  const preview = previewIndex === null ? undefined : items[previewIndex]
  const previewCenter =
    previewIndex === null
      ? 0
      : previewIndex * PITCH_PX + PITCH_PX / 2 - (scrollerRef.current?.scrollTop ?? 0)
  const mask =
    edges.top && edges.bottom
      ? 'linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)'
      : edges.top
        ? 'linear-gradient(to bottom, transparent 0, #000 24px, #000 100%)'
        : edges.bottom
          ? 'linear-gradient(to bottom, #000 0, #000 calc(100% - 24px), transparent 100%)'
          : undefined

  return (
    <nav
      aria-label="Turns"
      className={cn(
        // Centered in the transcript band; the ladder never compresses, it
        // scrolls inside this frame instead.
        'absolute top-1/2 right-3 z-10 w-7 -translate-y-1/2 cursor-pointer [contain:layout] [max-height:min(calc(100%-64px),420px)]',
        props.className,
      )}
      onPointerEnter={() => {
        pointerInside.current = true
      }}
      onPointerLeave={() => {
        pointerInside.current = false
        setPreviewIndex(null)
      }}
    >
      <div
        ref={scrollerRef}
        onScroll={measureEdges}
        className="relative max-h-[inherit] overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        <div className="py-[1px]">
          {items.map((item) => (
            <Mark
              key={item.messageId}
              item={item}
              active={item.index === activeIndex}
              preview={item.index === previewIndex}
              previewId={previewId}
              onJump={onJump}
              onPreview={setPreviewIndex}
            />
          ))}
        </div>
      </div>
      {preview && (
        <div
          id={previewId}
          role="tooltip"
          className="pointer-events-none absolute right-[calc(100%+10px)] w-[min(300px,60vw)] overflow-hidden rounded-xl border border-line bg-panel px-3 py-2.5 text-ink shadow-pop motion-safe:animate-[rail-preview-in_120ms_ease-out] motion-safe:transition-[top] motion-safe:duration-150 classic:bg-panel-2"
          style={
            {
              '--rail-preview-center': `${String(previewCenter)}px`,
              top: `clamp(0px, calc(var(--rail-preview-center) - ${String(PREVIEW_H_PX / 2)}px), calc(100% - ${String(PREVIEW_H_PX)}px))`,
              maxHeight: PREVIEW_H_PX,
            } as CSSProperties
          }
        >
          <div className="line-clamp-1 text-[13px] font-medium classic:text-xs">
            {preview.prompt || turnLabel(preview.index)}
          </div>
          {preview.response !== '' && (
            <div className="mt-1 line-clamp-3 text-xs text-ink-dim classic:text-[11px]">
              {preview.response}
            </div>
          )}
        </div>
      )}
    </nav>
  )
}
