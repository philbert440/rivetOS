/**
 * Chat — the day-one job (phase-4 design doc). Layout mirrors
 * rivet-android: conversation drawer on the left, transcript + composer on
 * the right. Live updates ride the all-sessions WS (stores/chat.ts); HTTP
 * seeds a transcript on first open.
 */

import { useEffect, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConnection } from '../stores/connection.js'
import { useChat } from '../stores/chat.js'
import { Transcript } from '../components/transcript.js'
import { Composer } from '../components/composer.js'

function newSessionId(): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `chat-${stamp}-${crypto.randomUUID().slice(0, 4)}`
}

export function ChatPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const chat = useChat()

  // One socket for the whole page; reconnect when the endpoint changes.
  useEffect(() => {
    chat.connect()
    return () => useChat.getState().disconnect()
  }, [baseUrl, token])

  const sessionsQuery = useQuery({
    queryKey: ['sessions', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.listSessions(signal),
    refetchInterval: 30_000,
  })

  const known = sessionsQuery.data?.sessions.map((s) => s.id) ?? []
  const sessions = [...chat.drafts.filter((d) => !known.includes(d)), ...known]
  const active = useChat((s) => s.active)

  return (
    <div className="flex h-full">
      <SessionDrawer
        sessions={sessions}
        active={active}
        error={sessionsQuery.isError ? sessionsQuery.error.message : undefined}
      />
      {active ? <ActiveSession sessionId={active} /> : <EmptyState />}
    </div>
  )
}

function SessionDrawer(props: {
  sessions: string[]
  active?: string
  error?: string
}): JSX.Element {
  const setActive = useChat((s) => s.setActive)
  const addDraft = useChat((s) => s.addDraft)
  const wsStatus = useChat((s) => s.wsStatus)

  return (
    <div className="flex w-60 shrink-0 flex-col border-r border-line bg-panel/40">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="font-mono text-xs text-ink-dim">
          conversations{' '}
          <span className={wsStatus === 'open' ? 'text-em' : 'text-red'}>
            {wsStatus === 'open' ? '●' : '○'}
          </span>
        </span>
        <button
          onClick={() => {
            const id = newSessionId()
            addDraft(id)
            setActive(id)
          }}
          className="rounded border border-line px-2 py-1 text-xs text-ink-dim hover:border-em hover:text-em"
        >
          + new
        </button>
      </div>
      {props.error && <div className="px-3 py-2 font-mono text-xs text-red">{props.error}</div>}
      <div className="flex-1 overflow-y-auto px-2">
        {props.sessions.map((id) => (
          <button
            key={id}
            onClick={() => setActive(id)}
            className={`mb-1 block w-full truncate rounded px-3 py-2 text-left font-mono text-xs ${
              id === props.active
                ? 'bg-panel-2 text-em'
                : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
            }`}
          >
            {id}
          </button>
        ))}
        {props.sessions.length === 0 && !props.error && (
          <div className="px-3 py-2 text-xs text-ink-dim">no conversations yet</div>
        )}
      </div>
    </div>
  )
}

function ActiveSession(props: { sessionId: string }): JSX.Element {
  const messages = useChat((s) => s.messages[props.sessionId]) ?? []
  const live = useChat((s) => s.live[props.sessionId])
  const wsStatus = useChat((s) => s.wsStatus)
  const seed = useChat((s) => s.seed)
  const baseUrl = useConnection((s) => s.baseUrl)

  // HTTP backfill on first open (and on endpoint change).
  const backfill = useQuery({
    queryKey: ['session-messages', baseUrl, props.sessionId],
    queryFn: ({ signal }) =>
      useConnection.getState().gateway.sessionMessages(props.sessionId, signal),
  })
  useEffect(() => {
    if (backfill.data) seed(props.sessionId, backfill.data.messages)
  }, [backfill.data, props.sessionId])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <Transcript messages={messages} live={live} />
      </div>
      <Composer sessionId={props.sessionId} wsStatus={wsStatus} />
    </div>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2">
      <div className="text-3xl">🔩</div>
      <div className="text-sm text-ink-dim">Pick a conversation or start a new one.</div>
    </div>
  )
}
