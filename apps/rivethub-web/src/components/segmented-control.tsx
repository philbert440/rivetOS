import type { JSX, ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

/**
 * The one segment toggle: bordered group, `aria-pressed`, accent active
 * segment — square and mono in classic, an outlined pill group with a
 * tonal-filled active segment in material. Replaces the four copy-pasted
 * implementations (chat mode toggle, run view toggle, workflow Run/Edit,
 * memory topic view).
 */
export function SegmentedControl<T extends string>(props: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
}): JSX.Element {
  return (
    <div
      className="inline-flex gap-0.5 rounded-pill border border-line p-0.5"
      role="group"
      aria-label={props.ariaLabel}
    >
      {props.options.map((o) => {
        const active = o.value === props.value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => props.onChange(o.value)}
            className={`rounded-pill px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 classic:px-2.5 classic:text-[11px] classic:font-normal ${
              active
                ? 'bg-em-container text-on-em-container classic:bg-panel-2 classic:text-em'
                : 'text-ink-dim hover:bg-ink/6 hover:text-ink classic:hover:bg-transparent'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
