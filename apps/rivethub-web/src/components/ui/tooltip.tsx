import type { JSX, ReactNode } from 'react'
import { cn } from '../../lib/utils.js'

/**
 * Hover/focus label. Portaled-free so it styles like the rest of the shell
 * (no native `title` tooltip — those paint GTK chrome in the desktop app).
 * `disabled` is for expanded rail rows that already show the name.
 * Accessible names live on the controls; the overlay is visual-only.
 */
export function Tooltip(props: {
  label: string
  children: ReactNode
  side?: 'right' | 'left' | 'top' | 'bottom'
  disabled?: boolean
  /** Stretch to parent width (nav rows). Default is shrink-to-fit. */
  block?: boolean
}): JSX.Element {
  if (props.disabled) {
    return <span className="contents">{props.children}</span>
  }
  const side = props.side ?? 'right'
  const pos =
    side === 'right'
      ? 'left-full top-1/2 ml-2 -translate-y-1/2'
      : side === 'left'
        ? 'right-full top-1/2 mr-2 -translate-y-1/2'
        : side === 'top'
          ? 'bottom-full left-1/2 mb-2 -translate-x-1/2'
          : 'top-full left-1/2 mt-2 -translate-x-1/2'
  return (
    <span
      className={cn('group/tip', props.block ? 'relative block w-full' : 'relative inline-flex')}
    >
      {props.children}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1 text-xs font-medium text-surface opacity-0 shadow-pop transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 classic:bg-panel-2 classic:border classic:border-line classic:font-normal classic:px-2 classic:text-[11px] classic:text-ink',
          pos,
        )}
      >
        {props.label}
      </span>
    </span>
  )
}
