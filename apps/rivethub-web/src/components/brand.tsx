import type { JSX } from 'react'
import { cn } from '../lib/utils.js'

/**
 * RivetHub brand, set in type. The expanded rail shows the
 * `rivethub` wordmark; the collapsed rail, the narrow top bar and the empty
 * states show its `r` and `h` as the R-H monogram. Both take their color from the active theme
 * (accent `em`, dim `ink-dim`), so an Omarchy theme switch restyles them.
 */
export function Wordmark(props: { className?: string }): JSX.Element {
  return (
    <span
      className={cn('font-mono font-extrabold tracking-tight select-none', props.className)}
      aria-label="RivetHub"
    >
      <span className="text-em" aria-hidden>
        rivet
      </span>
      <span className="text-ink-dim" aria-hidden>
        hub
      </span>
    </span>
  )
}

/**
 * R-H monogram: the wordmark's own `r` and `h` — same face, weight and
 * colors — so the collapsed rail reads as `rivethub` folded down. Size it
 * with a text size (`text-xl` matches the expanded rail's wordmark).
 */
export function RhMark(props: { className?: string; title?: string }): JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 font-mono font-extrabold leading-none tracking-tight select-none',
        props.className,
      )}
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
    >
      <span className="text-em">r</span>
      <span className="text-ink-dim">h</span>
    </span>
  )
}
