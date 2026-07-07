/**
 * Chat — the day-one job (phase-4 design doc). Layout mirrors
 * rivet-android: conversation drawer on the left, transcript + composer on
 * the right. Live updates ride the all-sessions WS (stores/chat.ts); HTTP
 * seeds a transcript on first open.
 */

import { useEffect, useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { useChat } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { Transcript } from '../components/transcript.js'
import { Composer } from '../components/composer.js'
import { XtermAttach } from '../components/xterm-attach.js'

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

  const connected = useGatewayReady()
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
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat')
  const [termPtyId, setTermPtyId] = useState<string | undefined>()
  const [termError, setTermError] = useState<string | undefined>()
  const messages = useChat((s) => s.messages[props.sessionId]) ?? []
  const live = useChat((s) => s.live[props.sessionId])
  const wsStatus = useChat((s) => s.wsStatus)
  const wsEpoch = useChat((s) => s.wsEpoch)
  const seed = useChat((s) => s.seed)
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)

  // per-conversation model + effort (persisted). Keyed per node + session.
  const settingsKey = `${baseUrl}::${props.sessionId}`
  const settings = useChatSettings((s) => s.byKey[settingsKey])
  const setSetting = useChatSettings((s) => s.set)

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

  // Switching to Terminal spawns the harness matching the chosen model once
  // (the TUI side of this session); toggling back detaches but leaves the PTY
  // for reattach. The model id maps to a term roster command when one exists.
  const enterTerminal = (): void => {
    setMode('terminal')
    if (termPtyId) return
    const command = settings?.agent || undefined
    void useConnection
      .getState()
      .gateway.termSpawn(command ? { command } : {})
      .then((p) => setTermPtyId(p.id))
      .catch((e: unknown) => setTermError((e as Error).message))
  }

  const denUrl = `${baseUrl.replace(/\/+$/, '')}/den/`

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-line bg-panel/40 px-4 py-1.5">
        <span className="truncate font-mono text-xs text-ink-dim">{props.sessionId}</span>
        <span className="flex items-center gap-2">
          {/* [Chat | Terminal] toggle — same session, two views */}
          <span className="flex overflow-hidden rounded-md border border-line">
            <button
              onClick={() => setMode('chat')}
              className={`px-2.5 py-1 font-mono text-[11px] ${mode === 'chat' ? 'bg-panel-2 text-em' : 'text-ink-dim hover:text-ink'}`}
            >
              Chat
            </button>
            <button
              onClick={enterTerminal}
              className={`border-l border-line px-2.5 py-1 font-mono text-[11px] ${mode === 'terminal' ? 'bg-panel-2 text-em' : 'text-ink-dim hover:text-ink'}`}
            >
              Terminal
            </button>
          </span>
          <a
            href={denUrl}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-ink-dim hover:border-em hover:text-em"
            title="open the den for this node"
          >
            ▦ Den
          </a>
        </span>
      </div>

      {mode === 'chat' ? (
        <>
          <div className="flex-1 overflow-y-auto">
            <Transcript messages={messages} live={live} />
          </div>
          <Composer
            sessionId={props.sessionId}
            wsStatus={wsStatus}
            settingsKey={settingsKey}
            agent={settings?.agent || undefined}
            effort={settings?.effort ?? 'medium'}
            onSetting={(patch) => setSetting(settingsKey, patch)}
          />
        </>
      ) : termError ? (
        <div className="flex flex-1 items-center justify-center font-mono text-sm text-red">
          {termError}
        </div>
      ) : termPtyId ? (
        <XtermAttach key={`${baseUrl}|${termPtyId}`} ptyId={termPtyId} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
          spawning terminal…
        </div>
      )}
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
