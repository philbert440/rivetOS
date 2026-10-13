import type { JSX } from 'react'

/** Boolean switch as an aria-checked pill — the same visual language as the
 *  Appearance theme buttons (no native controls: WebKitGTK paints them as OS
 *  chrome). */
export function Toggle(props: {
  value: boolean
  onChange: (v: boolean) => void
  id?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      aria-checked={props.value}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.value)}
      className={
        props.value
          ? 'rounded-pill bg-em px-3.5 py-1 text-xs font-medium text-on-em hover:bg-em-dim disabled:cursor-not-allowed disabled:opacity-40 classic:bg-em-dim classic:px-3 classic:text-bg'
          : 'rounded-pill border border-line px-3.5 py-1 text-xs font-medium text-ink-dim hover:bg-ink/6 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 classic:bg-panel-2 classic:font-normal classic:hover:border-em classic:px-3'
      }
    >
      {props.value ? 'On' : 'Off'}
    </button>
  )
}
