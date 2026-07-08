import type { JSX } from 'react'
import { cn } from '../lib/utils.js'
import { compactTokens, contextWindowFor } from '../lib/context-window.js'

/**
 * Context-fill bar for the chat header — how full the model's context window
 * is, from the latest turn's prompt tokens (which IS the context sent that
 * turn). Claude-only in practice: it needs per-turn usage, which only Claude
 * Code reports. Renders nothing without usage.
 */
export function ContextBar(props: { tokens?: number; model?: string }): JSX.Element | null {
  if (!props.tokens || props.tokens <= 0) return null
  const max = contextWindowFor(props.model)
  const pct = Math.min(100, Math.round((props.tokens / max) * 100))
  const hot = pct >= 85
  return (
    <div
      className="flex items-center gap-2"
      title={`${props.tokens.toLocaleString()} / ${max.toLocaleString()} context tokens${
        props.model ? ` · ${props.model}` : ''
      }`}
    >
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-panel-2">
        <div
          className={cn('h-full rounded-full transition-all', hot ? 'bg-red' : 'bg-em')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-ink-dim">
        {compactTokens(props.tokens)}/{compactTokens(max)} · {pct}%
      </span>
    </div>
  )
}
