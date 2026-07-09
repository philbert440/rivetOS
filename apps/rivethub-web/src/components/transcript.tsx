import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Clock3, Zap } from 'lucide-react'
import type { MessageUsage, SessionMessage } from '@rivetos/types'
import type { LiveTurn, LiveToolEntry } from '../lib/fold-stream.js'
import { DenBot } from './den-bot.js'
import { Markdown } from './markdown.js'

/** Time-only stamp; cold-backfilled messages carry ts:0 (timestamp lost on
 *  memory backfill) — show nothing rather than 1970. */
function stamp(ts: number): string | null {
  if (!ts) return null
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n)
}

/** The "nerd line" (android web-ui) — per-turn token stats under an assistant
 *  message: prompt (with cached), completion, tokens/sec, duration. Rendered
 *  only when the harness reported usage (Claude Code). */
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

function ReasoningBlock(props: { text: string; open?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(props.open ?? false)
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
          {props.text}
        </div>
      )}
    </div>
  )
}

/** Avatar + name + model + timestamp row above a message (android web-ui
 *  pattern). Assistant is the den bot ("Rivet"); user is right-aligned. */
function AvatarRow(props: { mine: boolean; ts?: number; model?: string }): JSX.Element {
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
      <DenBot decorative className="size-7 rounded-md bg-panel-2 p-0.5" />
      <span className="text-sm font-medium text-em">Rivet</span>
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
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`flex flex-col gap-1.5 ${props.mine ? 'items-end' : 'items-start'}`}>
      <AvatarRow mine={props.mine} ts={props.ts} model={props.model} />
      {props.children}
    </div>
  )
}

function Bubble(props: {
  msg: SessionMessage
  /** Outbound queue status for optimistic user turns. */
  outboundStatus?: 'queued' | 'sending'
}): JSX.Element {
  const mine = props.msg.role === 'user'
  return (
    <Row mine={mine} ts={props.msg.ts} model={mine ? undefined : props.msg.model}>
      {mine ? (
        // User text is plain — right-aligned bubble, no markdown.
        <div className="max-w-[85%]">
          <div
            className={`whitespace-pre-wrap rounded-lg border px-4 py-2.5 text-sm ${
              props.outboundStatus === 'queued'
                ? 'border-line bg-panel-2/50 text-ink-dim'
                : 'border-em-dim/40 bg-em-dim/10'
            }`}
          >
            {props.msg.text}
          </div>
          {props.outboundStatus && (
            <div className="mt-1 flex justify-end px-1 font-mono text-[10px] text-ink-dim">
              {props.outboundStatus === 'queued' ? 'queued' : 'sending…'}
            </div>
          )}
        </div>
      ) : (
        // Assistant is full-width, markdown-rendered (no bubble — android style).
        <div className="w-full px-1">
          <Markdown>{props.msg.text}</Markdown>
          {props.msg.usage && (
            <NerdLine usage={props.msg.usage} durationMs={props.msg.durationMs} />
          )}
        </div>
      )}
    </Row>
  )
}

function LiveBubble(props: { turn: LiveTurn }): JSX.Element {
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
    <Row mine={false}>
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

export function Transcript(props: {
  messages: SessionMessage[]
  live?: LiveTurn
  /** optim message id → outbound queue status */
  outbound?: Record<string, 'queued' | 'sending'>
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  const count = props.messages.length + (props.live ? 1 : 0)
  const liveLen = props.live?.text.length ?? 0
  const toolN = props.live?.tools.length ?? 0
  const reasonLen = props.live?.reasoningText.length ?? 0
  const outboundN = props.outbound ? Object.keys(props.outbound).length : 0

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [count, liveLen, toolN, reasonLen, outboundN])

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
      {props.messages.map((m) => (
        <Bubble key={m.id} msg={m} outboundStatus={props.outbound?.[m.id]} />
      ))}
      {props.live && <LiveBubble turn={props.live} />}
      <div ref={endRef} />
    </div>
  )
}
