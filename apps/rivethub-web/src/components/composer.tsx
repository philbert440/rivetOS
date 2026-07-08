import { useRef, useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp } from 'lucide-react'
import type { ThinkingLevel } from '@rivetos/types'
import type { WsStatus } from '../stores/chat.js'
import type { ChatSettings } from '../stores/chat-settings.js'
import { useConnection } from '../stores/connection.js'
import { modelOptions } from '../lib/model-options.js'
import { cn } from '../lib/utils.js'
import { Textarea } from './ui/textarea.js'
import { EffortPicker } from './pickers/effort-picker.js'
import { ModelPicker } from './pickers/model-picker.js'
import { NodePicker } from './pickers/node-picker.js'

export function Composer(props: {
  sessionId: string
  wsStatus: WsStatus
  settingsKey: string
  agent?: string
  effort: ThinkingLevel
  onSetting: (patch: Partial<ChatSettings>) => void
  /** Seamless modes: when set, a turn drives the session's live harness
   *  (inject into its PTY) instead of the chat-loop postMessage — so chat,
   *  terminal, and den are one conversation. The reply streams back via the
   *  den→sessions-WS bridge. */
  onSend?: (text: string) => Promise<void>
}): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const connected = props.wsStatus === 'open'
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)

  // Model dropdown (Claude Code / grok Build / local + mesh) from the catalog.
  const catalog = useQuery({
    queryKey: ['catalog-agents', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.catalogAgents(signal),
    staleTime: 300_000,
  })
  const models = modelOptions(catalog.data?.agents ?? [])

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || sending) return
    setError(undefined)
    setSending(true) // lock: double-Enter must not fire duplicate turns
    setText('')
    try {
      if (props.onSend) {
        // Seamless: drive the live harness (its den events stream the reply
        // back through the bridge). Model = the spawned harness; effort is a
        // per-harness default for now.
        await props.onSend(body)
      } else {
        // Fire-and-forget; the reply (and this message's echo) arrive on the
        // sessions WS. Model (agent) + effort (thinking) ride the request and
        // persist per-conversation.
        await useConnection.getState().gateway.postMessage(props.sessionId, {
          text: body,
          agent: props.agent,
          thinking: props.effort,
        })
      }
    } catch (err) {
      setError((err as Error).message)
      setText(body) // give the draft back
    } finally {
      setSending(false)
    }
  }

  const canSend = connected && !sending && text.trim().length > 0

  return (
    <div className="border-t border-line bg-panel/60 px-4 py-3">
      {error && <div className="mb-2 font-mono text-xs text-red">✗ {error}</div>}
      <div
        className={cn(
          'flex flex-col gap-2 rounded-xl border border-line bg-panel p-2 transition-shadow',
          'focus-within:border-em/60 focus-within:ring-1 focus-within:ring-em/30',
          !connected && 'opacity-70',
        )}
      >
        <Textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder={
            connected ? 'Message Rivet… (Enter to send, Shift+Enter for newline)' : 'reconnecting…'
          }
          disabled={!connected || sending}
          className="px-2 pt-1"
        />
        {/* Picker row (model · node · effort) + send — Claude-app style, in the
            input shell, persisted per-conversation. */}
        <div className="flex items-center gap-1">
          <ModelPicker
            value={props.agent ?? ''}
            options={models}
            onChange={(v) => props.onSetting({ agent: v })}
            disabled={catalog.isError}
            unavailable={catalog.isError}
          />
          <NodePicker />
          <EffortPicker value={props.effort} onChange={(v) => props.onSetting({ effort: v })} />
          <div className="flex-1" />
          <button
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="send"
            title="send"
            className={cn(
              'flex size-8 items-center justify-center rounded-full transition-colors',
              canSend ? 'bg-em-dim text-bg hover:bg-em' : 'bg-panel-2 text-ink-dim',
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
