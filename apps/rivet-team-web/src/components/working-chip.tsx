import type { JSX } from 'react'

/** Inline "working" chip — room for later tool/info cards in the stream. */
export function WorkingChip(props: { label?: string }): JSX.Element {
  return (
    <div className="flex justify-start">
      <div
        className="inline-flex items-center gap-2 rounded-full border border-line bg-panel-2 px-3 py-1 text-xs text-ink-dim"
        role="status"
        aria-live="polite"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-em" />
        {props.label ?? 'Working…'}
      </div>
    </div>
  )
}
