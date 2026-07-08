import { useState, type JSX } from 'react'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import type { SelectOption } from '../select.js'
import { Button } from '../ui/button.js'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover.js'

/** Model / harness picker — popover port of the android model-list. Options
 *  come from the catalog (local agents; '' = node default). Selection persists
 *  per-conversation via useChatSettings upstream. */
export function ModelPicker(props: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  unavailable?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const current = props.options.find((o) => o.value === props.value)

  return (
    <Popover open={open} onOpenChange={(o) => !props.disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          title="model / harness"
          className="h-8 rounded-full px-2.5 font-normal"
        >
          <Cpu className="size-3.5" />
          <span className="max-w-40 truncate">
            {props.unavailable ? 'catalog unavailable' : (current?.label ?? 'model')}
          </span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <PopoverHeader className="border-b border-line px-4 py-3">
          <PopoverTitle>Model</PopoverTitle>
        </PopoverHeader>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {props.options.map((o) => {
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
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {active && <Check className="size-3.5 shrink-0 text-em" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
