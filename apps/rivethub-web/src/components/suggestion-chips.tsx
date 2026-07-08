import type { JSX } from 'react'

export function SuggestionChips(props: {
  options: string[]
  disabled?: boolean
  onPick: (label: string) => void
}): JSX.Element | null {
  if (props.options.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Suggested replies">
      {props.options.map((label) => (
        <button
          key={label}
          type="button"
          disabled={props.disabled}
          onClick={() => props.onPick(label)}
          className="rounded-full border border-em-dim/50 bg-em-dim/10 px-3 py-1 text-xs text-em hover:bg-em-dim/25 disabled:opacity-40"
        >
          {label}
        </button>
      ))}
    </div>
  )
}
