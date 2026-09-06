import { memo, useMemo, type JSX } from 'react'
import { cn } from '../lib/utils.js'
import {
  compactAtFor,
  compactTokens,
  contextFill,
  contextWindowFor,
  estimatePromptTokens,
} from '../lib/context-window.js'

/**
 * Context-fill bar for the chat header — how full the model's context window
 * is, as progress toward forced compaction. Prefers harness-reported prompt
 * tokens (Claude Code) and wire `contextWindow`/`compactAt` when the den
 * stamped them; when usage is missing (grok / most local models), estimates
 * from the transcript so the bar still shows. Estimated values are labelled
 * "est.".
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
  /** Wire max context window; preferred over the model-id regex. */
  contextWindow?: number
  /** Wire forced-compaction threshold (the bar's 100%). */
  compactAt?: number
  /** Narrow session header: full-width 2px track on the header's bottom edge. */
  hairline?: boolean
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

  const windowTokens =
    props.contextWindow && props.contextWindow > 0
      ? props.contextWindow
      : contextWindowFor(props.model)
  const compactAt =
    props.compactAt && props.compactAt > 0 ? props.compactAt : compactAtFor(windowTokens)
  const { pct, hot, warn } = contextFill({ tokens, contextWindow: windowTokens, compactAt })
  const fillClass = hot ? 'bg-red' : warn ? 'bg-warn' : 'bg-em'
  const est = reported === undefined
  const title = `${compactTokens(tokens)} / ${compactTokens(windowTokens)} · compacts at ${compactTokens(compactAt)}${
    props.model ? ` · ${props.model}` : ''
  }${est ? ' (estimated from transcript — harness did not report usage)' : ''}`

  const label = (
    <span className="font-mono text-[10px] text-ink-dim">
      <span className={cn(props.hairline ? 'hidden' : 'hidden sm:inline')}>
        {est ? '~' : ''}
        {compactTokens(tokens)}/{compactTokens(windowTokens)} ·{' '}
      </span>
      {pct}%
      <span className={cn(props.hairline ? 'hidden' : 'hidden sm:inline')}>
        {est ? ' est.' : ''}
      </span>
    </span>
  )

  if (props.hairline) {
    return (
      <div className="contents">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          title={title}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-line"
        >
          <div
            className={cn('h-full transition-[width]', fillClass)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center gap-2" title={title}>
          {label}
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-2"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      title={title}
    >
      <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-panel-2 sm:block">
        <div
          className={cn('h-full rounded-full transition-[width]', fillClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {label}
    </div>
  )
})
