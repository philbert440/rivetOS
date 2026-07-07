import { useEffect, useRef, type JSX } from 'react'
import type { SessionMessage } from '@rivetos/types'
import type { LiveTurn } from '../stores/chat.js'

function Bubble(props: { msg: SessionMessage }): JSX.Element {
  const mine = props.msg.role === 'user'
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-lg border px-4 py-2.5 text-sm whitespace-pre-wrap ${
          mine ? 'border-em-dim/40 bg-em-dim/10' : 'border-line bg-panel'
        }`}
      >
        {!mine && <div className="mb-1 font-mono text-[11px] text-em">🔩 rivet</div>}
        {props.msg.text}
        <div className="mt-1 text-right font-mono text-[10px] text-ink-dim">
          {new Date(props.msg.ts).toLocaleTimeString()}
        </div>
      </div>
    </div>
  )
}

function LiveBubble(props: { turn: LiveTurn }): JSX.Element {
  return (
    <div className="flex justify-start">
      <div className="max-w-[75%] rounded-lg border border-line bg-panel px-4 py-2.5 text-sm whitespace-pre-wrap">
        <div className="mb-1 font-mono text-[11px] text-em">🔩 rivet</div>
        {props.turn.text}
        <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-ink-dim">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-em" />
          {props.turn.activity ?? (props.turn.reasoning ? 'thinking…' : 'writing…')}
        </div>
      </div>
    </div>
  )
}

export function Transcript(props: { messages: SessionMessage[]; live?: LiveTurn }): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  const count = props.messages.length + (props.live ? 1 : 0)
  const liveLen = props.live?.text.length ?? 0

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [count, liveLen])

  return (
    <div className="flex flex-col gap-3 px-6 py-4">
      {props.messages.map((m) => (
        <Bubble key={m.id} msg={m} />
      ))}
      {props.live && <LiveBubble turn={props.live} />}
      <div ref={endRef} />
    </div>
  )
}
