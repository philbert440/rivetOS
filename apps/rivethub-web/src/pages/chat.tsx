/**
 * Chat — the day-one job (phase-4 design doc). Layout mirrors
 * rivet-android: conversation drawer on the left, transcript + composer on
 * the right. Live updates ride the all-sessions WS (stores/chat.ts); HTTP
 * seeds a transcript on first open.
 */

import { useEffect, useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { isValidGatewayUrl, useConnection } from '../stores/connection.js'
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

  // One socket for the whole page; reconnect (and reset per-gateway state)
  // when the endpoint identity changes.
  useEffect(() => {
    chat.connect(`${baseUrl}|${token ?? ''}`)
    return () => useChat.getState().disconnect()
  }, [baseUrl, token])

  const connected = isValidGatewayUrl(baseUrl)
  const sessionsQuery = useQuery({
    queryKey: ['sessions', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.listSessions(signal),
    refetchInterval: 30_000,
    enabled: connected,
  })

  if (!connected) return <NotConnected />

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
  const [agent, setAgent] = useState<string | undefined>()
  const messages = useChat((s) => s.messages[props.sessionId]) ?? []
  const live = useChat((s) => s.live[props.sessionId])
  const wsStatus = useChat((s) => s.wsStatus)
  const wsEpoch = useChat((s) => s.wsEpoch)
  const seed = useChat((s) => s.seed)
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)

  // HTTP backfill on first open, on endpoint/credential change, and after
  // every reconnect (wsEpoch) — frames dropped during an outage only come
  // back through the ring.
  const backfill = useQuery({
    queryKey: ['session-messages', baseUrl, token ?? '', props.sessionId, wsEpoch],
    queryFn: ({ signal }) =>
      useConnection.getState().gateway.sessionMessages(props.sessionId, signal),
  })
  useEffect(() => {
    if (backfill.data) seed(props.sessionId, backfill.data.messages)
  }, [backfill.data, props.sessionId])

  // Catalog-driven agent picker (4g): local agents only — a remote agent
  // needs a task, not a chat turn. Empty = the node's default agent.
  const catalog = useQuery({
    queryKey: ['catalog-agents', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.catalogAgents(signal),
    staleTime: 300_000,
  })
  const localAgents = (catalog.data?.agents ?? []).filter((a) => a.local)

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-line bg-panel/40 px-4 py-1.5">
        <span className="truncate font-mono text-xs text-ink-dim">{props.sessionId}</span>
        <span className="flex items-center gap-2">
          {catalog.isLoading && (
            <span className="font-mono text-[11px] text-ink-dim">loading agents…</span>
          )}
          {catalog.isError && (
            <span className="font-mono text-[11px] text-red">catalog unavailable</span>
          )}
          {catalog.isSuccess && localAgents.length === 0 && (
            <span className="font-mono text-[11px] text-ink-dim">
              no local agents — using default
            </span>
          )}
          <select
            value={agent ?? ''}
            onChange={(e) => setAgent(e.target.value || undefined)}
            className="rounded border border-line bg-panel px-2 py-1 font-mono text-xs"
          >
            <option value="">default agent</option>
            {localAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
                {'model' in a && a.model ? ` (${a.model})` : ''}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Transcript messages={messages} live={live} />
      </div>
      <Composer sessionId={props.sessionId} wsStatus={wsStatus} agent={agent} />
    </div>
  )
}

function NotConnected(): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <div className="text-3xl">🔩</div>
      <div className="text-sm text-ink-dim">No node connected.</div>
      <Link
        to="/settings"
        className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em"
      >
        Connect to a node
      </Link>
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
