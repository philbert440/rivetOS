import { useState, type JSX } from 'react'
import {
  Brain,
  BrainCircuit,
  Check,
  ChevronDown,
  Lightbulb,
  LightbulbOff,
  type LucideIcon,
} from 'lucide-react'
import type { ThinkingLevel } from '@rivetos/types'
import { cn } from '../../lib/utils.js'
import { Button } from '../ui/button.js'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover.js'

interface Preset {
  value: ThinkingLevel
  label: string
  description: string
  icon: LucideIcon
}

/** Reasoning effort presets — ported from the android reasoning-picker, mapped
 *  to rivethub's ThinkingLevel set (no 'auto'). Order = ascending budget. */
const PRESETS: Preset[] = [
  {
    value: 'off',
    label: 'Off',
    description: 'No extended thinking — fastest replies.',
    icon: LightbulbOff,
  },
  {
    value: 'low',
    label: 'Low',
    description: 'A little reasoning before answering.',
    icon: Lightbulb,
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balanced reasoning for most tasks.',
    icon: Lightbulb,
  },
  {
    value: 'high',
    label: 'High',
    description: 'Deeper reasoning for hard problems.',
    icon: BrainCircuit,
  },
  { value: 'xhigh', label: 'X-High', description: 'Maximum reasoning budget.', icon: Brain },
]

export function EffortPicker(props: {
  value: ThinkingLevel
  onChange: (value: ThinkingLevel) => void
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const current = PRESETS.find((p) => p.value === props.value) ?? PRESETS[2]
  const CurrentIcon = current.icon

  return (
    <Popover open={open} onOpenChange={(o) => !props.disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          title="reasoning effort"
          className="h-8 rounded-full px-2.5 font-normal"
        >
          <CurrentIcon className="size-3.5" />
          <span>{current.label}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <PopoverHeader className="border-b border-line px-4 py-3">
          <PopoverTitle>Reasoning effort</PopoverTitle>
          <PopoverDescription>How much the model thinks before replying.</PopoverDescription>
        </PopoverHeader>
        <div className="p-1.5">
          {PRESETS.map((p) => {
            const Icon = p.icon
            const active = p.value === props.value
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  props.onChange(p.value)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                  active ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink',
                )}
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', active && 'text-em')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {p.label}
                    {active && <Check className="size-3.5 text-em" />}
                  </span>
                  <span className="block text-xs text-ink-dim">{p.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
