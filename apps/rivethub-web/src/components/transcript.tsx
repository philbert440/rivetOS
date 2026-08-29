import { memo, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, Clock3, Copy, Zap } from 'lucide-react'
import type { HarnessTranscriptTool, MessageUsage, SessionMessage } from '@rivetos/types'
import type { LiveTurn, LiveToolEntry } from '../lib/fold-stream.js'
import { humanToolTitle, type ToolArgs } from '../lib/tool-titles.js'
import { formatSpinnerMeta, parseSpinnerMeta } from '../lib/spinner-meta.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { DenBot } from './den-bot.js'
import { Markdown } from './markdown.js'
import { SpeakMessage } from './speak-message.js'

/** Transcript-sourced tool → the live stack's entry shape (same renderer). */
function toLiveTool(t: HarnessTranscriptTool, id: string): LiveToolEntry {
  const args: ToolArgs = t.args
  return { id, name: t.name, title: humanToolTitle(t.name, args), status: t.status, args }
}

/** Time-only stamp; cold-backfilled messages carry ts:0 (timestamp lost on
 *  memory backfill) — show nothing rather than 1970. */
function stamp(ts: number): string | null {
  if (!ts) return null
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const NUM_FMT = new Intl.NumberFormat()

function fmt(n: number): string {
  return NUM_FMT.format(n)
}

/** The "nerd line" — per-turn token stats under an assistant message: prompt
 *  (with cached), completion, tokens/sec, duration. Rendered only when the
 *  harness reported usage. */
function NerdLine(props: { usage: MessageUsage; durationMs?: number }): JSX.Element {
  const { promptTokens, completionTokens, cachedTokens } = props.usage
  const secs = props.durationMs && props.durationMs > 0 ? props.durationMs / 1000 : 0
  const tps = secs > 0 && completionTokens > 0 ? completionTokens / secs : 0
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-[10px] text-ink-dim/70">
      <span className="inline-flex items-center gap-1" title="prompt tokens">
        <ArrowUp className="size-3" />
        {fmt(promptTokens)}
        {cachedTokens > 0 ? ` (${fmt(cachedTokens)} cached)` : ''}
      </span>
      <span className="inline-flex items-center gap-1" title="completion tokens">
        <ArrowDown className="size-3" />
        {fmt(completionTokens)}
      </span>
      {tps > 0 && (
        <span className="inline-flex items-center gap-1" title="tokens per second">
          <Zap className="size-3" />
          {tps.toFixed(1)} tok/s
        </span>
      )}
      {secs > 0 && (
        <span className="inline-flex items-center gap-1" title="turn duration">
          <Clock3 className="size-3" />
          {secs.toFixed(1)}s
        </span>
      )}
    </div>
  )
}

function ToolStack(props: { tools: LiveToolEntry[] }): JSX.Element | null {
  if (props.tools.length === 0) return null
  return (
    <div className="mb-2 space-y-1">
      {props.tools.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-2 rounded border border-line bg-bg/60 px-2 py-1 font-mono text-[11px] text-ink-dim"
        >
          <span
            className={
              t.status === 'running'
                ? 'inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-em'
                : t.status === 'error'
                  ? 'inline-block h-1.5 w-1.5 rounded-full bg-red'
                  : 'inline-block h-1.5 w-1.5 rounded-full bg-ink-dim'
            }
          />
          <span className="truncate text-ink">{t.title}</span>
          <span className="ml-auto shrink-0 text-[10px] opacity-70">{t.status}</span>
        </div>
      ))}
    </div>
  )
}

/** One shared 1s ticker for every spinner line on screen — N messages must
 *  not arm N intervals (N re-renders/sec each). */
const tickListeners = new Set<() => void>()
let tickTimer: ReturnType<typeof setInterval> | undefined
function subscribeTick(fn: () => void): () => void {
  tickListeners.add(fn)
  tickTimer ??= setInterval(() => {
    for (const f of tickListeners) f()
  }, 1_000)
  return () => {
    tickListeners.delete(fn)
    if (tickListeners.size === 0 && tickTimer !== undefined) {
      clearInterval(tickTimer)
      tickTimer = undefined
    }
  }
}

/** Claude spinner lines freeze between hook events — tick their elapsed time
 *  locally so "(0s · ↓ 0 tokens)" doesn't sit dead while a long thinking
 *  stretch fires no hooks. Non-spinner text passes through untouched. */
function useSpinnerTick(text: string): string {
  const meta = parseSpinnerMeta(text)
  const receivedAt = useRef({ key: '', at: 0 })
  if (receivedAt.current.key !== text) receivedAt.current = { key: text, at: Date.now() }
  const [, setTick] = useState(0)
  const ticking = meta !== null
  useEffect(() => {
    if (!ticking) return
    return subscribeTick(() => setTick((n) => n + 1))
  }, [ticking])
  if (!meta) return text
  return formatSpinnerMeta(meta, Math.floor((Date.now() - receivedAt.current.at) / 1000))
}

function ReasoningBlock(props: { text: string; open?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(props.open ?? false)
  const display = useSpinnerTick(props.text)
  if (!props.text.trim()) return null
  return (
    <div className="mb-2 rounded border border-line/80 bg-bg/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1 font-mono text-[11px] text-ink-dim hover:text-ink"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>thinking</span>
      </button>
      {open && (
        <div className="border-t border-line/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-dim whitespace-pre-wrap">
          {display}
        </div>
      )}
    </div>
  )
}

/** Avatar + name + model + timestamp row above a message. Assistant is the
 *  den bot ("Rivet"); user is right-aligned. `accent` colors the bot per
 *  harness (claude clay / grok grey / emerald). */
function AvatarRow(props: {
  mine: boolean
  ts?: number
  model?: string
  accent?: string
}): JSX.Element {
  const time = props.ts !== undefined ? stamp(props.ts) : null
  if (props.mine) {
    return (
      <div className="flex items-center justify-end gap-2 px-1">
        <span className="text-sm font-medium text-ink/90">You</span>
        {time && <span className="font-mono text-[10px] text-ink-dim">{time}</span>}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-1">
      <DenBot
        decorative
        className="size-7 rounded-md bg-panel-2 p-0.5"
        style={props.accent ? { boxShadow: `inset 0 0 0 1px ${props.accent}` } : undefined}
      />
      <span
        className="text-sm font-medium"
        style={{ color: props.accent ?? 'var(--color-em, #34d399)' }}
      >
        Rivet
      </span>
      {props.model && (
        <span className="truncate font-mono text-[10px] text-ink-dim" title={props.model}>
          {props.model}
        </span>
      )}
      {time && <span className="font-mono text-[10px] text-ink-dim">{time}</span>}
    </div>
  )
}

function Row(props: {
  mine: boolean
  ts?: number
  model?: string
  accent?: string
  /** Solid messages skip offscreen layout/paint; the live bubble never does. */
  offscreenSkip?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={`group/msg flex flex-col gap-1.5 ${props.mine ? 'items-end' : 'items-start'} ${
        props.offscreenSkip ? '[content-visibility:auto] [contain-intrinsic-size:auto_96px]' : ''
      }`}
    >
      <AvatarRow mine={props.mine} ts={props.ts} model={props.model} accent={props.accent} />
      {props.children}
    </div>
  )
}

/** Hover/focus copy for a whole message (fenced code blocks keep their own). */
function CopyMessage(props: { text: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mountedRef = useRef(true)
  useEffect(() => {
    // Strict Mode runs mount → cleanup → remount on ONE instance: setup must
    // re-arm the flag or the flash guard stays false for the component's life.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    }
  }, [])
  const flash = (next: 'copied' | 'failed'): void => {
    if (!mountedRef.current) return
    setState(next)
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setState('idle'), 1500)
  }
  return (
    <button
      type="button"
      aria-label="copy message"
      title="copy message"
      onClick={() => {
        void copyTextToClipboard(props.text)
          .then(() => flash('copied'))
          .catch(() => flash('failed'))
      }}
      // opacity, not visibility: a visibility-hidden control drops out of the
      // tab order, so keyboard users could never reach copy at all
      className="absolute top-0 right-1 rounded border border-line bg-panel/90 p-1 text-ink-dim opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 hover:text-em"
    >
      {state === 'copied' ? (
        <Check className="size-3 text-em" />
      ) : (
        <Copy className={`size-3 ${state === 'failed' ? 'text-red' : ''}`} />
      )}
    </button>
  )
}

const Bubble = memo(function Bubble(props: {
  msg: SessionMessage
  accent?: string
  /** Deep-history row: allowed to skip offscreen layout/paint. */
  offscreenSkip?: boolean
  /** Outbound queue status for optimistic user turns. */
  outboundStatus?: 'queued' | 'sending'
  onInject?: (id: string) => void
  onCancel?: (id: string) => void
}): JSX.Element {
  const mine = props.msg.role === 'user'
  const tools = useMemo(
    () =>
      props.msg.tools && props.msg.tools.length > 0
        ? props.msg.tools.map((t, i) => toLiveTool(t, `${props.msg.id}:${String(i)}`))
        : undefined,
    [props.msg],
  )
  return (
    <Row
      mine={mine}
      ts={props.msg.ts}
      model={mine ? undefined : props.msg.model}
      accent={mine ? undefined : props.accent}
      offscreenSkip={props.offscreenSkip}
    >
      {mine ? (
        // User text is plain — right-aligned bubble, no markdown.
        <div className="relative max-w-[85%]">
          <div
            className={`whitespace-pre-wrap rounded-lg border px-4 py-2.5 text-sm ${
              props.outboundStatus === 'queued'
                ? 'border-line bg-panel-2/50 text-ink-dim'
                : 'border-em-dim/40 bg-em-dim/10'
            }`}
          >
            {props.msg.text}
          </div>
          {props.msg.text && <CopyMessage text={props.msg.text} />}
          {props.outboundStatus && (
            <div className="mt-1 flex items-center justify-end gap-2 px-1 font-mono text-[10px] text-ink-dim">
              <span>{props.outboundStatus === 'queued' ? 'queued' : 'sending…'}</span>
              {props.outboundStatus === 'queued' && props.onInject && (
                <button
                  type="button"
                  onClick={() => props.onInject?.(props.msg.id)}
                  className="text-em hover:underline"
                  title="Inject this message into the harness now"
                >
                  inject
                </button>
              )}
              {props.onCancel && (
                <button
                  type="button"
                  onClick={() => props.onCancel?.(props.msg.id)}
                  className="text-ink-dim hover:text-red hover:underline"
                  title="Remove from the send queue"
                >
                  cancel
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        // Assistant is full-width, markdown-rendered (no bubble). Harness
        // messages carry the turn's thinking trace and tool stack so a synced
        // chat looks like the live one did.
        <div className="relative w-full px-1">
          {props.msg.thinking && <ReasoningBlock text={props.msg.thinking} />}
          {tools && <ToolStack tools={tools} />}
          {props.msg.text && <Markdown>{props.msg.text}</Markdown>}
          {props.msg.text && <CopyMessage text={props.msg.text} />}
          {props.msg.text && <SpeakMessage id={props.msg.id} text={props.msg.text} />}
          {props.msg.usage && (
            <NerdLine usage={props.msg.usage} durationMs={props.msg.durationMs} />
          )}
        </div>
      )}
    </Row>
  )
})

function LiveBubble(props: { turn: LiveTurn; accent?: string }): JSX.Element {
  const hasTools = props.turn.tools.some((t) => t.status === 'running')
  const status =
    props.turn.activity ??
    (props.turn.reasoning
      ? 'thinking…'
      : hasTools
        ? 'working…'
        : props.turn.text
          ? 'writing…'
          : 'processing…')
  // Cursor only while tokens are still arriving (or waiting for first bytes).
  const showCursor = !props.turn.text || props.turn.reasoning || hasTools || !!props.turn.activity
  return (
    <Row mine={false} accent={props.accent}>
      <div className="w-full px-1">
        <ReasoningBlock
          text={props.turn.reasoningText}
          open={props.turn.reasoning && !props.turn.text}
        />
        <ToolStack tools={props.turn.tools} />
        {props.turn.text ? (
          <div className="relative">
            <Markdown>{props.turn.text}</Markdown>
            {showCursor && (
              <span
                className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-em align-text-bottom"
                aria-hidden
              />
            )}
          </div>
        ) : null}
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px] text-ink-dim">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-em opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-em" />
          </span>
          <span>{status}</span>
        </div>
      </div>
    </Row>
  )
}

/** How close to the bottom (px) still counts as "at the bottom" — generous
 *  enough that a stray wheel tick doesn't unpin, small enough that reading
 *  one message up stays put. */
const NEAR_BOTTOM_PX = 120

/** Rows this close to the live edge always paint for real: the 96px
 *  intrinsic-size guess on unpainted rows skews scrollHeight, and lying
 *  about heights right where stick-to-bottom measures is how follow-scroll
 *  breaks. Deep history can afford the estimate. */
const CV_EDGE_ROWS = 12

export function Transcript(props: {
  messages: SessionMessage[]
  live?: LiveTurn
  /** optim message id → outbound queue status */
  outbound?: Record<string, 'queued' | 'sending'>
  /** Force-inject a queued bubble now (bypass busy wait). */
  onInjectOutbound?: (id: string) => void
  /** Drop a queued/sending bubble without sending. */
  onCancelOutbound?: (id: string) => void
  /** per-harness bot accent (claude clay / grok grey / local emerald) */
  accent?: string
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // Stick-to-bottom: auto-scroll ONLY while the user is already at (or near)
  // the bottom. Scrolling up to reread during a streaming reply must not be
  // yanked back down on every frame. The ref mirrors the state so the content
  // effect reads the current value without re-arming on every pin flip.
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  // Streaming deltas can land several per frame — coalesce the follow scroll
  // to one rAF (cancel-and-requeue) so layout isn't forced per token.
  const rafRef = useRef<number | undefined>(undefined)
  const count = props.messages.length + (props.live ? 1 : 0)
  const liveLen = props.live?.text.length ?? 0
  const toolN = props.live?.tools.length ?? 0
  const reasonLen = props.live?.reasoningText.length ?? 0
  const outboundN = props.outbound ? Object.keys(props.outbound).length : 0

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    pinnedRef.current = nearBottom
    setPinned(nearBottom)
  }

  const jumpToLatest = (): void => {
    pinnedRef.current = true
    setPinned(true)
    endRef.current?.scrollIntoView({ block: 'end' })
  }

  useEffect(() => {
    if (!pinnedRef.current) return
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined
      if (pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' })
    })
  }, [count, liveLen, toolN, reasonLen, outboundN])
  useEffect(
    () => () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
          {props.messages.map((m, i) => (
            <Bubble
              accent={props.accent}
              key={m.id}
              msg={m}
              offscreenSkip={i < props.messages.length - CV_EDGE_ROWS}
              outboundStatus={props.outbound?.[m.id]}
              onInject={props.outbound?.[m.id] ? props.onInjectOutbound : undefined}
              onCancel={props.outbound?.[m.id] ? props.onCancelOutbound : undefined}
            />
          ))}
          {props.live && <LiveBubble turn={props.live} accent={props.accent} />}
          <div ref={endRef} />
        </div>
      </div>
      {!pinned && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-em-dim/50 bg-panel px-3 py-1.5 font-mono text-[11px] text-em shadow-lg shadow-bg/50 hover:bg-em-dim/20"
        >
          <ArrowDown className="size-3.5" />
          latest
        </button>
      )}
    </div>
  )
}
