import type { JSX } from 'react'

export interface SelectOption {
  value: string
  label: string
  /** optional group heading — consecutive same-group options render under it */
  group?: string
}

/**
 * Themed dropdown matching the Rivet UI (emerald-on-dark, mono) — a styled
 * native <select> so it stays accessible and keyboard-friendly while looking
 * like the rest of the app (the old plain selects were the odd ones out).
 */
export function Select(props: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  title?: string
  disabled?: boolean
}): JSX.Element {
  // group options under optgroups when any option carries a group
  const grouped = props.options.some((o) => o.group)
  const groups = new Map<string, SelectOption[]>()
  if (grouped) {
    for (const o of props.options) {
      const g = o.group ?? ''
      const list = groups.get(g) ?? []
      list.push(o)
      groups.set(g, list)
    }
  }

  return (
    <span className="relative inline-flex items-center">
      <select
        value={props.value}
        title={props.title}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        // appearance-none is REQUIRED: WebKitGTK (the desktop shell) draws a
        // native GTK <select> and ignores bg/text CSS without it — that's why
        // the dropdowns looked light-grey against the dark app. The chevron is
        // a sibling SVG since appearance-none drops the native arrow.
        className="cursor-pointer appearance-none rounded-md border border-line bg-panel-2 py-1.5 pl-2.5 pr-7 font-mono text-xs text-ink outline-none hover:border-em/60 focus:border-em disabled:opacity-40"
      >
        {grouped
          ? [...groups.entries()].map(([g, opts]) =>
              g ? (
                <optgroup key={g} label={g}>
                  {opts.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : (
                opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))
              ),
            )
          : props.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2 h-3 w-3 text-ink-dim"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" />
      </svg>
    </span>
  )
}
