import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ThinkingLevel } from '@rivetos/types'
import type { WsStatus } from '../stores/chat.js'
import type { ChatSettings } from '../stores/chat-settings.js'
import { EFFORTS } from '../stores/chat-settings.js'
import { useConnection } from '../stores/connection.js'
import { Select } from './select.js'
import { modelOptions } from '../lib/model-options.js'

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

  return (
    <div className="border-t border-line bg-panel/60 px-6 py-3">
      {error && <div className="mb-2 font-mono text-xs text-red">✗ {error}</div>}
      <div className="flex items-end gap-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder={connected ? 'Message Rivet… (Enter to send)' : 'reconnecting…'}
          disabled={!connected || sending}
          className="flex-1 resize-none rounded border border-line bg-panel px-3 py-2.5 text-sm outline-none focus:border-em disabled:opacity-50"
        />
        <button
          onClick={() => void send()}
          disabled={!connected || sending || !text.trim()}
          className="rounded bg-em-dim px-4 py-2.5 text-sm font-medium text-bg hover:bg-em disabled:opacity-40"
        >
          Send
        </button>
      </div>
      {/* Model + effort — Claude-app-style, in the messages area, persisted */}
      <div className="mt-2 flex items-center gap-2">
        <Select
          value={props.agent ?? ''}
          options={models}
          onChange={(v) => props.onSetting({ agent: v })}
          title="model / harness"
          disabled={catalog.isError}
        />
        <Select
          value={props.effort}
          options={EFFORTS.map((e) => ({ value: e.value, label: e.label }))}
          onChange={(v) => props.onSetting({ effort: v as ThinkingLevel })}
          title="reasoning effort"
        />
        {catalog.isError && (
          <span className="font-mono text-[11px] text-red">catalog unavailable</span>
        )}
      </div>
    </div>
  )
}
