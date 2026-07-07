import { useState, type JSX } from 'react'
import type { WsStatus } from '../stores/chat.js'
import { useConnection } from '../stores/connection.js'

export function Composer(props: { sessionId: string; wsStatus: WsStatus }): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>()
  const connected = props.wsStatus === 'open'

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body) return
    setError(undefined)
    setText('')
    try {
      // Fire-and-forget; the reply (and the echo of this message) arrives on
      // the sessions WS. Sending is gated on the socket being open so a send
      // can't silently vanish while we're blind.
      await useConnection.getState().gateway.postMessage(props.sessionId, { text: body })
    } catch (err) {
      setError((err as Error).message)
      setText(body) // give the draft back
    }
  }

  return (
    <div className="border-t border-line bg-panel/60 px-6 py-4">
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
          disabled={!connected}
          className="flex-1 resize-none rounded border border-line bg-panel px-3 py-2.5 text-sm outline-none focus:border-em disabled:opacity-50"
        />
        <button
          onClick={() => void send()}
          disabled={!connected || !text.trim()}
          className="rounded bg-em-dim px-4 py-2.5 text-sm font-medium text-bg hover:bg-em disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  )
}
