import { memo, useMemo, type JSX } from 'react'
import { cn } from '../lib/utils.js'
import { compactTokens, contextWindowFor, estimatePromptTokens } from '../lib/context-window.js'

/**
 * Context-fill bar for the chat header — how full the model's context window
 * is. Prefers harness-reported prompt tokens (Claude Code); when missing
 * (grok / most local models), estimates from the transcript so the bar still
 * shows. Estimated values are labelled "est.".
 *
 * Memoized, and the estimate is computed per transcript-array identity — the
 * fallback scan walks every message text, which must not run on every
 * streaming tick of the page around it.
 */
export const ContextBar = memo(function ContextBar(props: {
  /** Provider-reported prompt tokens for the latest assistant turn. */
  tokens?: number
  /** Model id for window lookup (message model, or selected agent). */
  model?: string
  /** Full transcript texts for fallback estimate when tokens are absent. */
  transcriptTexts?: string[]
}): JSX.Element | null {
  const reported = props.tokens && props.tokens > 0 ? props.tokens : undefined
  const texts = props.transcriptTexts
  const estimated = useMemo(
    () =>
      reported === undefined && texts && texts.length > 0 ? estimatePromptTokens(texts) : undefined,
    [reported, texts],
  )
  const tokens = reported ?? estimated
  if (!tokens || tokens <= 0) return null

  const max = contextWindowFor(props.model)
  const pct = Math.min(100, Math.round((tokens / max) * 100))
  const hot = pct >= 85
  const est = reported === undefined
  return (
    <div
      className="flex items-center gap-2"
      title={`${tokens.toLocaleString()} / ${max.toLocaleString()} context tokens${
        props.model ? ` · ${props.model}` : ''
      }${est ? ' (estimated from transcript — harness did not report usage)' : ''}`}
    >
      <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-panel-2 sm:block">
        <div
          className={cn('h-full rounded-full transition-all', hot ? 'bg-red' : 'bg-em')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-ink-dim">
        <span className="hidden sm:inline">
          {est ? '~' : ''}
          {compactTokens(tokens)}/{compactTokens(max)} ·{' '}
        </span>
        {pct}%<span className="hidden sm:inline">{est ? ' est.' : ''}</span>
      </span>
    </div>
  )
})
