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
    <select
      value={props.value}
      title={props.title}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      className="cursor-pointer rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-xs text-ink outline-none hover:border-em/60 focus:border-em disabled:opacity-40"
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
  )
}
