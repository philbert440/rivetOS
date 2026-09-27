import { memo, useMemo, type JSX, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '../lib/utils.js'
import { useNotifications } from '../stores/notifications.js'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js'
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
  /** Desktop: the meter opens a session-details panel. Primitive props
   *  (not an object) so the memo still holds across streaming renders. */
  withDetails?: boolean
  harness?: string
  node?: string
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

  const meter = (
    <div
      className="flex items-center gap-2"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      title={props.withDetails ? undefined : title}
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

  if (!props.withDetails) return meter

  // The meter doubles as the toggle for session details — what used to be
  // a permanent right-hand column is one click away instead.
  return (
    <Popover>
      <PopoverTrigger
        className="shrink-0 border border-line px-2 py-1 hover:border-em data-[state=open]:border-em"
        aria-label={`Context ${String(pct)}% — session details`}
        title={title}
      >
        {meter}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0 font-mono text-xs">
        <ContextDetailsPanel
          tokens={tokens}
          windowTokens={windowTokens}
          compactAt={compactAt}
          pct={pct}
          fillClass={fillClass}
          estimated={est}
          details={{ harness: props.harness, model: props.model, node: props.node }}
        />
      </PopoverContent>
    </Popover>
  )
})

/** Session facts shown beside the context numbers. Each is optional. */
export interface ContextDetails {
  harness?: string
  model?: string
  node?: string
}

function Fact(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-ink-dim">{props.label}</div>
      <div className="truncate text-ink">{props.children}</div>
    </div>
  )
}

function ContextDetailsPanel(props: {
  tokens: number
  windowTokens: number
  compactAt: number
  pct: number
  fillClass: string
  estimated: boolean
  details: ContextDetails
}): JSX.Element {
  const unread = useNotifications((s) => s.unread)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const navigate = useNavigate()
  const d = props.details
  return (
    <div className="flex flex-col">
      <div className="border-b border-line px-3 py-2 text-[10px] uppercase tracking-widest text-ink-dim">
        details
      </div>
      <section className="flex flex-col gap-2 px-3 py-3">
        <div className="flex justify-between text-ink">
          <span>context</span>
          <span>
            {props.estimated ? '~' : ''}
            {compactTokens(props.tokens)} / {compactTokens(props.windowTokens)}
          </span>
        </div>
        <div className="h-1.5 bg-bg">
          <div
            className={cn('h-full', props.fillClass)}
            style={{ width: `${String(props.pct)}%` }}
          />
        </div>
        <div className="text-ink-dim">
          compacts at {compactTokens(props.compactAt)} · amber at 70%, red at 90%
          {props.estimated ? ' · estimated from the transcript' : ''}
        </div>
        {(d.harness || d.model || d.node) && (
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-2">
            {d.harness && <Fact label="harness">{d.harness}</Fact>}
            {d.model && <Fact label="model">{d.model}</Fact>}
            {d.node && <Fact label="node">{d.node}</Fact>}
          </div>
        )}
      </section>
      {unread > 0 && (
        <button
          type="button"
          onClick={() => {
            markAllRead()
            void navigate({ to: '/tasks' })
          }}
          className="border-t border-line px-3 py-2 text-left text-red hover:bg-panel"
        >
          ! {unread > 99 ? '99+' : unread} need you → tasks
        </button>
      )}
    </div>
  )
}
