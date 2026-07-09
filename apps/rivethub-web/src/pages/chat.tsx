/**
 * Chat — the day-one job (phase-4 design doc). Layout mirrors
 * rivet-android: conversation drawer on the left, transcript + composer on
 * the right. Live updates ride the all-sessions WS (stores/chat.ts); HTTP
 * seeds a transcript on first open.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionMessage } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { useChat } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { Transcript } from '../components/transcript.js'
import { Composer } from '../components/composer.js'
import { XtermAttach } from '../components/xterm-attach.js'
import { chipsFromLiveTools } from '../lib/ask-user.js'
import { DenBot } from '../components/den-bot.js'
import { ContextBar } from '../components/context-bar.js'
import { Pencil, RefreshCw } from 'lucide-react'
import { useSessionNames } from '../stores/session-names.js'

// A conversation id IS a UUID so it can be the harness's native session id
// (claude --session-id requires a UUID). Then the join key, the harness's
// on-disk store filename, and the drawer id are all the same value.
function newSessionId(): string {
  return crypto.randomUUID()
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
  // The drawer lists the node's harness sessions straight from their on-disk
  // stores — node+harness specific by construction (the store is local disk,
  // so it never holds another node's sessions). Ids are the harness's native
  // session ids; opening one resumes it.
  const harnessQuery = useQuery({
    queryKey: ['harness-sessions', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.harnessSessions(signal),
    refetchInterval: 30_000,
    enabled: connected,
  })

  if (!connected) return <NotConnected />

  const harness = harnessQuery.data?.sessions ?? []
  const harnessById = new Map(harness.map((s) => [s.id, s] as const))
  // Fresh drafts (a UUID with no store file yet) first, then every harness
  // session, newest-first from the store. Deduped: once a draft's first turn
  // creates its store file, it shows as a harness session, not a draft.
  const draftItems = chat.drafts
    .filter((d) => !harnessById.has(d))
    .map((id) => ({ id, title: 'new conversation', command: undefined }))
  const harnessItems = harness.map((s) => ({ id: s.id, title: s.title, command: s.command }))
  const items = [...draftItems, ...harnessItems]
  const active = useChat((s) => s.active)
  const activeHarness = active ? harnessById.get(active) : undefined

  return (
    <div className="flex h-full">
      <SessionDrawer
        items={items}
        active={active}
        error={harnessQuery.isError ? harnessQuery.error.message : undefined}
      />
      {active ? (
        // Keyed by session id: switching conversations must fully remount so
        // the view (chat/terminal/den), the attached PTY, and the transcript
        // all belong to the newly-selected session. Without the key React
        // reuses the instance and a Terminal-mode switch keeps showing the
        // previous conversation's PTY (stale mode/termPtyId).
        <ActiveSession key={active} sessionId={active} harnessCommand={activeHarness?.command} />
      ) : (
        <EmptyState />
      )}
    </div>
  )
}

/** One conversation row — shows the custom name (if set) over the derived
 *  title, with inline rename (pencil on hover → input; Enter/blur saves, empty
 *  clears, Escape cancels). Rename persists per node+session (localStorage). */
function DrawerItem(props: {
  item: { id: string; title: string; command?: string }
  active: boolean
  onSelect: () => void
}): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const key = `${baseUrl}::${props.item.id}`
  const customName = useSessionNames((s) => s.byKey[key])
  const setName = useSessionNames((s) => s.set)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Escape cancels; a blur can still fire as the input unmounts, so guard the
  // commit so Escape never saves (grok review).
  const cancelRef = useRef(false)

  if (editing) {
    const commit = (): void => {
      if (cancelRef.current) {
        cancelRef.current = false
        setEditing(false)
        return
      }
      setName(key, draft)
      setEditing(false)
    }
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          commit()
        }}
        className="mb-1 flex items-center rounded bg-panel-2 px-3 py-1.5"
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              cancelRef.current = true
              setEditing(false)
            }
          }}
          onBlur={commit}
          placeholder={props.item.title}
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none"
        />
      </form>
    )
  }

  return (
    <div
      className={`group mb-1 flex items-center rounded ${
        props.active ? 'bg-panel-2' : 'hover:bg-panel-2'
      }`}
    >
      <button
        onClick={props.onSelect}
        title={props.item.command ? `${props.item.command} · ${props.item.id}` : props.item.id}
        className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-xs ${
          props.active ? 'text-em' : 'text-ink-dim group-hover:text-ink'
        }`}
      >
        {customName ?? props.item.title}
      </button>
      <button
        onClick={() => {
          setDraft(customName ?? props.item.title)
          setEditing(true)
        }}
        aria-label="rename conversation"
        title="rename"
        className="hidden shrink-0 px-2 py-2 text-ink-dim hover:text-em group-hover:block group-focus-within:block focus:block"
      >
        <Pencil className="size-3" />
      </button>
    </div>
  )
}

function SessionDrawer(props: {
  items: { id: string; title: string; command?: string }[]
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
        {props.items.map((it) => (
          <DrawerItem
            key={it.id}
            item={it}
            active={it.id === props.active}
            onSelect={() => setActive(it.id)}
          />
        ))}
        {props.items.length === 0 && !props.error && (
          <div className="px-3 py-2 text-xs text-ink-dim">no conversations yet</div>
        )}
      </div>
    </div>
  )
}

function ActiveSession(props: { sessionId: string; harnessCommand?: string }): JSX.Element {
  const [mode, setMode] = useState<'chat' | 'terminal' | 'den'>('chat')
  const [termPtyId, setTermPtyId] = useState<string | undefined>()
  const [termError, setTermError] = useState<string | undefined>()
  const [spawning, setSpawning] = useState(false)
  const [resyncConfirm, setResyncConfirm] = useState(false)
  const [resyncing, setResyncing] = useState(false)
  const [resyncMsg, setResyncMsg] = useState<string | undefined>()
  // ref mirrors termPtyId so the unmount cleanup can kill the current PTY
  // (state is captured stale in an unmount-only effect) — #310 review.
  const termPtyRef = useRef<string | undefined>(undefined)
  termPtyRef.current = termPtyId
  const messages = useChat((s) => s.messages[props.sessionId]) ?? []
  const live = useChat((s) => s.live[props.sessionId])
  // Context-fill: the NEWEST assistant turn (walking back, skipping a trailing
  // in-flight user turn). Its prompt tokens ARE the context sent that turn. We
  // deliberately use the latest assistant's own usage — not the latest turn
  // that happens to have usage — so a non-reporting/cold-backfilled last turn
  // hides the bar rather than showing a stale older number (grok review).
  let lastAssistant: (typeof messages)[number] | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistant = messages[i]
      break
    }
  }
  const wsStatus = useChat((s) => s.wsStatus)
  const wsEpoch = useChat((s) => s.wsEpoch)
  const seed = useChat((s) => s.seed)
  const replace = useChat((s) => s.replace)
  const queryClient = useQueryClient()
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
    // Load-once: the live transcript is kept current by the WS store, so the
    // HTTP seed only needs to run once per (session, epoch). Cache it so
    // re-opening a conversation shows instantly instead of a blank refetch.
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
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
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  })
  useEffect(() => {
    if (coldBackfill.data?.messages.length) seed(props.sessionId, coldBackfill.data.messages)
  }, [coldBackfill.data, props.sessionId])

  // Leaving a conversation does NOT kill its harness: detach only. Switching
  // away mid-turn must not abort the harness — the reply keeps streaming to
  // the chat via the bridge, and reopening reattaches the same live PTY. The
  // key on <ActiveSession> already resets this view's mode/termPtyId; the PTY
  // is cleaned up by XtermAttach's detach (WS close → detached TTL) and the
  // manager's LRU pool at maxPtys (#316), not by a kill-on-leave.

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
    const gw = useConnection.getState().gateway
    // A harness session (already in the store) resumes; a fresh conversation
    // pins its id (--session-id, via the join key) so its store file lines up.
    // Command: the harness's own for a resume, else the model dropdown.
    const command = props.harnessCommand || settings?.agent || undefined
    const body = {
      session: props.sessionId,
      ...(command ? { command } : {}),
      ...(props.harnessCommand ? { resume: props.sessionId } : {}),
    }
    // An API-only agent has no roster command → fall back to the node default
    // rather than 404 (keeps the session id via --session-id if a UUID).
    const p = command
      ? await gw.termSpawn(body).catch(() => gw.termSpawn({ session: props.sessionId }))
      : await gw.termSpawn(body)
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
  const addOptimisticUser = useChat((s) => s.addOptimisticUser)
  const sendToHarness = async (body: string): Promise<void> => {
    // Show the turn immediately — the inject echo (harness hook → bridge) has
    // real latency, unlike the chat-loop's instant echo.
    addOptimisticUser(props.sessionId, body)
    const gw = useConnection.getState().gateway
    await ensurePty()
    try {
      await gw.termInject({ session: props.sessionId, text: body })
    } catch (err) {
      // The harness may have been LRU-evicted while we held a stale pty ref
      // (#318 review): drop the ref, respawn (store-existence → --resume so
      // context is kept), and retry once.
      termPtyRef.current = undefined
      setTermPtyId(undefined)
      await ensurePty()
      await gw.termInject({ session: props.sessionId, text: body })
      void err
    }
  }

  /**
   * Hard-resync from the on-disk TUI store (Android resyncCliTranscript).
   * Drops the chat UI transcript + live turn and rebuilds from harness
   * jsonl/sqlite. Falls back to memory conversationMessages if the store
   * has no turns yet. Destructive to optimistic/chat-only bubbles — confirm first.
   */
  const resyncFromTui = async (): Promise<void> => {
    setResyncing(true)
    setResyncMsg(undefined)
    try {
      const gw = useConnection.getState().gateway
      const transcript = await gw.harnessTranscript(props.sessionId)
      let next: SessionMessage[]
      if (transcript.turns.length > 0) {
        next = transcript.turns.map((t, i) => ({
          id: `harness:${props.sessionId}:${String(i)}`,
          sessionId: props.sessionId,
          role: t.role,
          text: t.text,
          ts: i + 1, // preserve order; harness store has no reliable per-turn ms
        }))
      } else {
        // No on-disk store (fresh draft / unknown harness) — fall back to
        // durable memory + ring, still as a hard replace so dups/stuck live clear.
        const [ring, cold] = await Promise.all([
          gw.sessionMessages(props.sessionId).catch(() => ({ messages: [] as SessionMessage[] })),
          gw
            .conversationMessages(props.sessionId)
            .catch(() => ({ messages: [] as SessionMessage[] })),
        ])
        const byId = new Map<string, SessionMessage>()
        for (const m of cold.messages) byId.set(m.id, m)
        for (const m of ring.messages) byId.set(m.id, m)
        next = [...byId.values()].sort((a, b) => a.ts - b.ts)
      }
      replace(props.sessionId, next)
      // Drop cached backfills so the next open doesn't re-seed stale merges.
      void queryClient.invalidateQueries({
        queryKey: ['session-messages', baseUrl, token ?? '', props.sessionId],
      })
      void queryClient.invalidateQueries({
        queryKey: ['conv-messages', baseUrl, token ?? '', props.sessionId],
      })
      setResyncMsg(
        transcript.turns.length > 0
          ? `resynced ${String(next.length)} turn(s) from ${transcript.command || 'tui'}`
          : next.length > 0
            ? `resynced ${String(next.length)} turn(s) from memory/ring`
            : 'no transcript found on this node',
      )
    } catch (err) {
      setResyncMsg((err as Error).message)
    } finally {
      setResyncing(false)
      setResyncConfirm(false)
    }
  }

  const denUrl = `${baseUrl.replace(/\/+$/, '')}/den/?session=${encodeURIComponent(props.sessionId)}`

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-panel/40 px-4 py-1.5">
        <span className="truncate font-mono text-xs text-ink-dim">{props.sessionId}</span>
        {/* Context-fill bar — how full the model's window is (latest turn). */}
        <ContextBar tokens={lastAssistant?.usage?.promptTokens} model={lastAssistant?.model} />
        {/* Resync from TUI — Android-style un-wedge (confirm first). */}
        <button
          type="button"
          onClick={() => setResyncConfirm(true)}
          disabled={resyncing}
          title="Resync chat from the terminal session transcript"
          aria-label="Resync transcript"
          className="ml-auto shrink-0 rounded border border-line px-2 py-1 text-ink-dim hover:border-em hover:text-em disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${resyncing ? 'animate-spin' : ''}`} />
        </button>
        {/* [Chat | Terminal | Den] — three views of ONE session; the bar
            stays visible so the den never takes over with no way back. */}
        <span className="flex shrink-0 overflow-hidden rounded-md border border-line">
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
          <button
            onClick={() => setMode('den')}
            title="the den for this conversation"
            className={`border-l border-line px-2.5 py-1 font-mono text-[11px] ${mode === 'den' ? 'bg-panel-2 text-em' : 'text-ink-dim hover:text-ink'}`}
          >
            ▦ Den
          </button>
        </span>
      </div>
      {resyncMsg && (
        <div className="border-b border-line bg-panel-2/40 px-4 py-1 font-mono text-[11px] text-ink-dim">
          {resyncMsg}
        </div>
      )}
      {resyncConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-bg/70 p-4">
          <div
            role="dialog"
            aria-labelledby="resync-title"
            className="w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-lg"
          >
            <h2 id="resync-title" className="mb-2 font-mono text-sm font-semibold text-em">
              Resync transcript?
            </h2>
            <p className="mb-4 text-sm text-ink-dim">
              Rebuilds this chat from the on-disk terminal (TUI) session, dropping any chat-only
              or stuck messages that diverged from it. Use this if the chat looks out of sync
              with Terminal mode.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResyncConfirm(false)}
                className="rounded border border-line px-3 py-1.5 text-sm text-ink-dim hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void resyncFromTui()}
                disabled={resyncing}
                className="rounded border border-em bg-em-dim/20 px-3 py-1.5 text-sm text-em hover:bg-em-dim/40 disabled:opacity-50"
              >
                {resyncing ? 'Resyncing…' : 'Resync'}
              </button>
            </div>
          </div>
        </div>
      )}

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
            suggestions={chipsFromLiveTools(live?.tools ?? [])}
          />
        </>
      ) : mode === 'den' ? (
        // Embedded, not a link-out: replaces the chat/terminal area so the
        // toggle bar (the way back) stays put. Same session as chat/terminal.
        <iframe
          key={props.sessionId}
          src={denUrl}
          title="den"
          className="min-h-0 flex-1 border-0 bg-bg"
        />
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
      <DenBot className="size-16 opacity-90" />
      <div className="text-sm text-ink-dim">Pick a conversation or start a new one.</div>
    </div>
  )
}
