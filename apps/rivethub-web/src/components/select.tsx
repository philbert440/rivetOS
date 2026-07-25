import { useState, type JSX } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils.js'
import { Button } from './ui/button.js'
import { Popover, PopoverContent, PopoverHeader, PopoverTrigger } from './ui/popover.js'

export interface SelectOption {
  value: string
  label: string
  /** optional group heading — consecutive same-group options render under it */
  group?: string
}

/**
 * Themed dropdown matching the Rivet UI (emerald-on-dark).
 *
 * **Not** a native `<select>`: WebKitGTK (desktop shell) paints GTK option
 * menus that ignore our CSS and look like OS chrome. Portaled Popover list
 * matches Model/Effort/Node pickers and styles correctly everywhere.
 */
export function Select(props: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  title?: string
  /** Optional label shown above the list inside the popover. */
  label?: string
  disabled?: boolean
  /** Trigger width class — default min width for toolbar use. */
  className?: string
  /** Align popover to start (default) or end. */
  align?: 'start' | 'center' | 'end'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const current = props.options.find((o) => o.value === props.value)
  const triggerLabel = current?.label ?? props.title ?? 'Select…'

  // Preserve group order as first-seen
  const sections: { group: string; options: SelectOption[] }[] = []
  if (props.options.some((o) => o.group)) {
    const map = new Map<string, SelectOption[]>()
    for (const o of props.options) {
      const g = o.group ?? ''
      if (!map.has(g)) {
        const list: SelectOption[] = []
        map.set(g, list)
        sections.push({ group: g, options: list })
      }
      map.get(g)!.push(o)
    }
  } else {
    sections.push({ group: '', options: props.options })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o && props.disabled) return
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={props.disabled}
          title={props.title}
          className={cn(
            'h-8 min-w-[7rem] justify-between gap-2 font-mono text-xs font-normal',
            props.className,
          )}
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={props.align ?? 'start'} className="min-w-[12rem] p-0">
        {(props.label || props.title) && (
          <PopoverHeader className="border-b border-line px-3 py-2">
            <div className="font-mono text-xs text-ink-dim">{props.label ?? props.title}</div>
          </PopoverHeader>
        )}
        <div className="max-h-72 overflow-y-auto p-1.5">
          {sections.map((sec) => (
            <div key={sec.group || '__flat'}>
              {sec.group ? (
                <div className="px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                  {sec.group}
                </div>
              ) : null}
              {sec.options.map((o) => {
                const active = o.value === props.value
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      props.onChange(o.value)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                      active ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{o.label}</span>
                    {active && <Check className="size-3.5 shrink-0 text-em" />}
                  </button>
                )
              })}
            </div>
          ))}
          {props.options.length === 0 && (
            <div className="px-2.5 py-3 text-xs text-ink-dim">No options</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
