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
          ? 'rounded bg-em-dim px-3 py-1 text-xs font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40'
          : 'rounded border border-line bg-panel-2 px-3 py-1 text-xs hover:border-em disabled:cursor-not-allowed disabled:opacity-40'
      }
    >
      {props.value ? 'On' : 'Off'}
    </button>
  )
}
