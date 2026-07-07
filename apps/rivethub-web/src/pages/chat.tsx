/**
 * Chat — the day-one job (phase-4 design doc). Layout mirrors
 * rivet-android: conversation drawer on the left, transcript + composer on
 * the right. Live updates ride the all-sessions WS (stores/chat.ts); HTTP
 * seeds a transcript on first open.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
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
  const [spawning, setSpawning] = useState(false)
  // ref mirrors termPtyId so the unmount cleanup can kill the current PTY
  // (state is captured stale in an unmount-only effect) — #310 review.
  const termPtyRef = useRef<string | undefined>(undefined)
  termPtyRef.current = termPtyId
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

  // Cold-session durable backfill (seamless 5e): a harness conversation this
  // process didn't run through the chat-loop has an EMPTY ring — its committed
  // transcript lives in memory. Fetch it only when the ring came back empty.
  // seed() MERGES by id (append), so cold msgs are the base and any live
  // bridge frame that raced in ahead is preserved, not clobbered (#315
  // review); the index ids (`${key}:${i}`) never collide with live UUIDs.
  const ringEmpty = backfill.isSuccess && backfill.data.messages.length === 0
  const coldBackfill = useQuery({
    queryKey: ['conv-messages', baseUrl, token ?? '', props.sessionId, wsEpoch],
    queryFn: ({ signal }) =>
      useConnection.getState().gateway.conversationMessages(props.sessionId, signal),
    enabled: ringEmpty,
  })
  useEffect(() => {
    if (coldBackfill.data?.messages.length) seed(props.sessionId, coldBackfill.data.messages)
  }, [coldBackfill.data, props.sessionId])

  // Kill the session's terminal PTY when leaving this conversation — without
  // it, switching sessions orphans a PTY for the 30-min detach TTL and can
  // hit maxPtys after a few sessions (#310 review). Toggling Chat↔Terminal
  // does NOT unmount ActiveSession, so it keeps the PTY for reattach.
  useEffect(() => {
    return () => {
      const id = termPtyRef.current
      if (id)
        void useConnection
          .getState()
          .gateway.termKill(id)
          .catch(() => undefined)
    }
  }, [])

  // Model change invalidates a running terminal (it's the wrong harness now):
  // kill it so the next Terminal entry / chat send respawns with the chosen
  // model.
  const agentSel = settings?.agent ?? ''
  useEffect(() => {
    const id = termPtyRef.current
    if (id) {
      void useConnection
        .getState()
        .gateway.termKill(id)
        .catch(() => undefined)
      // Clear the ref synchronously, not just the state (#315 review): until
      // the next render re-mirrors termPtyId, ensurePty() would otherwise
      // hand back the just-killed pty id and chat send would inject into a
      // dead PTY → 409.
      termPtyRef.current = undefined
      setTermPtyId(undefined)
      setMode('chat')
    }
  }, [agentSel])

  // Ensure THE harness for this conversation exists (seamless join key):
  // spawn-or-get a PTY whose denSession IS props.sessionId, so chat (inject +
  // bridge), terminal (this PTY), and den (?session) are one live harness.
  // Idempotent server-side; the client guard avoids UI churn on double calls.
  const ensurePty = async (): Promise<string> => {
    if (termPtyRef.current) return termPtyRef.current
    const command = settings?.agent || undefined
    const gw = useConnection.getState().gateway
    // model id is the roster command when the node has one (e.g. 'claude'); an
    // API-only agent has none → fall back to the node's default harness.
    const p = command
      ? await gw
          .termSpawn({ command, session: props.sessionId })
          .catch(() => gw.termSpawn({ session: props.sessionId }))
      : await gw.termSpawn({ session: props.sessionId })
    setTermPtyId(p.id)
    termPtyRef.current = p.id
    return p.id
  }

  // Switching to Terminal reveals the conversation's harness (spawn-or-get).
  const enterTerminal = (): void => {
    setMode('terminal')
    if (termPtyId || spawning) return
    setSpawning(true)
    void ensurePty()
      .catch((e: unknown) => setTermError((e as Error).message))
      .finally(() => setSpawning(false))
  }

  // Seamless chat send: a turn drives the SAME harness (inject into its PTY);
  // its den events stream the reply back via the bridge. This is what makes
  // chat↔terminal↔den one thread — the terminal shows the very harness the
  // chat is talking to, with full context.
  const sendToHarness = async (body: string): Promise<void> => {
    await ensurePty()
    await useConnection.getState().gateway.termInject({ session: props.sessionId, text: body })
  }

  const denUrl = `${baseUrl.replace(/\/+$/, '')}/den/?session=${encodeURIComponent(props.sessionId)}`

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
            onSend={sendToHarness}
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
