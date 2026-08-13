import type { JSX, ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

/**
 * The one chip-style segment toggle — hub mono idiom: bordered group,
 * `aria-pressed`, emerald active segment. Replaces the four copy-pasted
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
      className="inline-flex gap-0.5 rounded border border-line p-0.5"
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
            className={`rounded px-2.5 py-1 font-mono text-[11px] disabled:opacity-40 ${
              active ? 'bg-panel-2 text-em' : 'text-ink-dim hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
