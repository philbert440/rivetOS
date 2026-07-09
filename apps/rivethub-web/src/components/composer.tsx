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
import { SuggestionChips } from './suggestion-chips.js'

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
  /** Ask-user suggestion chips (labels). Empty/undefined hides the row. */
  suggestions?: string[]
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

  const sendBody = async (body: string): Promise<void> => {
    const trimmed = body.trim()
    // Seamless queue path: allow stacking while a prior turn is in flight
    // (onSend enqueues and returns). Chat-loop path still serializes via sending.
    if (!trimmed || (sending && !props.onSend)) return
    setError(undefined)
    setSending(true)
    setText('')
    try {
      if (props.onSend) {
        // Enqueue + pump (returns immediately). Messages show as queued/sending
        // in the transcript until the harness injects them.
        await props.onSend(trimmed)
      } else {
        // Fire-and-forget; the reply (and this message's echo) arrive on the
        // sessions WS. Model (agent) + effort (thinking) ride the request and
        // persist per-conversation.
        await useConnection.getState().gateway.postMessage(props.sessionId, {
          text: trimmed,
          agent: props.agent,
          thinking: props.effort,
        })
      }
    } catch (err) {
      setError((err as Error).message)
      setText(trimmed) // give the draft back
    } finally {
      setSending(false)
    }
  }

  const send = async (): Promise<void> => {
    await sendBody(text)
  }

  // Seamless: never lock out Enter for a second queued message.
  const canSend = connected && text.trim().length > 0 && (props.onSend ? true : !sending)

  return (
    <div className="border-t border-line bg-panel/60 px-4 py-3">
      {error && <div className="mb-2 font-mono text-xs text-red">✗ {error}</div>}
      <SuggestionChips
        options={props.suggestions ?? []}
        disabled={!connected || sending}
        onPick={(label) => void sendBody(label)}
      />
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
        {/* Picker row (node · model · effort) + send — Claude-app style, in the
            input shell, persisted per-conversation. Node sits leftmost. */}
        <div className="flex items-center gap-1">
          <NodePicker />
          <ModelPicker
            value={props.agent ?? ''}
            options={models}
            onChange={(v) => props.onSetting({ agent: v })}
            disabled={catalog.isError}
            unavailable={catalog.isError}
          />
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
