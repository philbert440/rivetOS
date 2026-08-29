/**
 * Chat — the day-one job (phase-4 design doc). Layout mirrors
 * rivet-android: conversation drawer on the left, transcript + composer on
 * the right.
 *
 * Two bindings feed one surface (docs/plans/harness-control-plane.md):
 *
 *   - **Control plane.** Sessions a registered HarnessDriver claims come from
 *     `GET /api/harnesses/:id/sessions`, stream over
 *     `WS /api/harness-sessions/ws`, hard-resync from the session transcript
 *     on every (re)connect, and take turns through `sendUserTurn`. Affordances
 *     follow the driver's capability flags — a `false` flag answers 501, so
 *     the button is hidden rather than shown-and-failing.
 *   - **Legacy.** Everything the plane does not claim (grok, hermes — their
 *     drivers land in Phase 3) keeps the gateway chat channel binding it has
 *     today: the all-sessions WS, server-pushed transcripts, PTY inject.
 *
 * The split is per-session and automatic; there is no mode to pick.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useSearch, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  prefixSystemPrompt,
  type ApprovalDecision,
  type HarnessSessionSummary,
  type SessionMessage,
} from '@rivetos/types'
import { rekeyAgentLastSessions } from '../lib/agent-session.js'
import {
  clearSystemPromptSent,
  markSystemPromptSent,
  rekeySystemPromptSent,
  wasSystemPromptSent,
} from '../lib/system-prompt-sent.js'
import { uuidv4 } from '../lib/uuid.js'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { useChat, type OutboundItem } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { Transcript } from '../components/transcript.js'
import { Composer, type ComposerHandle } from '../components/composer.js'
import { XtermAttach } from '../components/xterm-attach.js'
import { SessionErrorBoundary } from '../components/session-error-boundary.js'
import { HarnessApprovalCard } from '../components/harness-approval-card.js'
import { questionsFromLiveTools } from '../lib/ask-user.js'
import { harnessAccent } from '../lib/harness-colors.js'
import { attachHarnessSession } from '../lib/harness-attach.js'
import { createPtyEnsurer } from '../lib/pty-ensure.js'
import {
  createOutboundPump,
  startStaleTurnRelease,
  type OutboundPump,
  type OutboundPumpStore,
} from '../lib/outbound-pump.js'
import {
  applyRegistryEventToPlaneSessions,
  chatItems,
  denRoomKey,
  fetchHarnessPlaneSessions,
  findChatItem,
  harnessGate,
  isTurnInFlight,
  shortNativeId,
  type ChatItem,
  type HarnessGate,
} from '../lib/harness-chat.js'
import { DenBot } from '../components/den-bot.js'
import { ContextBar } from '../components/context-bar.js'
import { SegmentedControl } from '../components/segmented-control.js'
import { clampDrawerWidth, DRAWER_WIDTH_DEFAULT, SplitHandle } from '../components/split-handle.js'
import { Archive, ArchiveRestore, Pencil, Square, Trash2 } from 'lucide-react'
import { useSessionNames } from '../stores/session-names.js'
import { useArchived } from '../stores/archived.js'
import { getSessionMode, setSessionMode, type SessionViewMode } from '../lib/session-mode.js'

/** Stable empty array for zustand selectors — `?? []` inside a selector
 *  allocates a new [] every run when the key is missing, which zustand treats
 *  as a state change → infinite re-render → minified React crash on open. */
const EMPTY_OUTBOUND: OutboundItem[] = []
const EMPTY_MESSAGES: SessionMessage[] = []

/** Pause between a control-plane interrupt and the turn that displaced it. */
const INTERRUPT_SETTLE_MS = 400

/** Adapter handing the extracted pump (lib/outbound-pump.ts) the chat-store
 *  slice it drives — reads go through getState() so the pump always sees the
 *  latest queue/live state. */
const pumpStore: OutboundPumpStore = {
  queue: (sid) => useChat.getState().outbound[sid],
  liveIsBusy: (sid) => useChat.getState().liveIsBusy(sid),
  live: (sid) => useChat.getState().live[sid],
  liveTs: (sid) => useChat.getState().liveTs[sid],
  markSending: (sid, id) => useChat.getState().markOutboundSending(sid, id),
  dequeue: (sid, id) => useChat.getState().dequeueOutbound(sid, id),
  requeue: (sid, id) => useChat.getState().requeueOutbound(sid, id),
  fail: (sid, id) => useChat.getState().failOutbound(sid, id),
  beginLive: (sid, activity) => useChat.getState().beginLive(sid, activity),
  clearLive: (sid) => useChat.getState().clearLive(sid),
}

type InjectSink = (text: string, interrupt: boolean) => Promise<void>

/**
 * One outbound pump per conversation, for the app lifetime. ActiveSession
 * remounts on every session switch (it is keyed by session id), and a
 * per-mount pump drops the single-flight/inject latch — the only
 * double-inject guard — exactly in the window it exists to protect: the old
 * pump keeps latching (its trailing clearLive nukes whatever the new pump
 * started) while the new pump sees a non-busy placeholder and injects.
 * The view rebinds the inject sink on every (re)mount;
 * nothing disposes these (dispose is the terminal teardown, exercised by the
 * pump tests).
 */
const outboundPumps = new Map<string, { pump: OutboundPump; sink: { current: InjectSink } }>()

function outboundPumpFor(sessionId: string): {
  pump: OutboundPump
  sink: { current: InjectSink }
} {
  let entry = outboundPumps.get(sessionId)
  if (!entry) {
    // Rejects until a mounted view binds its inject: a pump firing with no
    // view (a retry timer outliving the component) must fail the bubble
    // visibly, never report a silent success and drop the message.
    const sink: { current: InjectSink } = {
      current: () => Promise.reject(new Error('no mounted session view')),
    }
    entry = {
      sink,
      pump: createOutboundPump({
        sessionId,
        store: pumpStore,
        inject: (text, interrupt) => sink.current(text, interrupt),
        isTurnInFlight,
      }),
    }
    outboundPumps.set(sessionId, entry)
  }
  return entry
}

// A draft id IS a UUID so it can become the harness's native session id
// (claude --session-id requires a UUID). It stays bare until the control plane
// adopts the session and hands back a canonical `<harness-id>:<uuid>`.
function newSessionId(): string {
  return uuidv4()
}

/** localStorage key for a thread's per-node persisted state. */
const storageKey = (baseUrl: string, key: string): string => `${baseUrl}::${key}`

/**
 * Read a thread's persisted value, falling back to the pre-canonical key.
 *
 * Names and per-thread settings were filed under the bare native id before
 * hub chat keyed on `SessionId`. Nothing is rewritten on upgrade: the read
 * falls back to the old key and the next write lands on the new one, so the
 * migration happens per conversation as it is used (§ Legacy keys — aliases
 * cover reads).
 */
function persisted<T>(
  byKey: Record<string, T | undefined>,
  baseUrl: string,
  key: string,
): T | undefined {
  const own = byKey[storageKey(baseUrl, key)]
  if (own !== undefined) return own
  const native = denRoomKey(key)
  return native === key ? undefined : byKey[storageKey(baseUrl, native)]
}

/**
 * Move a thread's persisted state onto a key it has just been rekeyed to.
 *
 * The read fallback above covers bare → canonical. This covers the case it
 * cannot: a driver ROTATING its native id, where old and new keys share
 * nothing. Lazy — only threads the client actually touches pay for it.
 *
 * ONLY call this when the thread's records really moved. On a destination
 * collision `rekey` deliberately leaves two live threads apart, and copying
 * the retired one's custom name onto the survivor (then clearing it from the
 * original) would swap two real conversations' metadata at exactly the moment
 * the code decided they must not merge — hence the `moved` gate at every call
 * site. Both stores are cleared, not just the name: a half-migrated key would
 * resurrect stale settings through `persisted()`'s fallback.
 */
function migrateSessionKey(baseUrl: string, from: string, to: string): void {
  const names = useSessionNames.getState()
  const name = names.byKey[storageKey(baseUrl, from)]
  if (name !== undefined && names.byKey[storageKey(baseUrl, to)] === undefined) {
    names.set(storageKey(baseUrl, to), name)
  }
  names.set(storageKey(baseUrl, from), '') // empty clears the override
  const settings = useChatSettings.getState()
  const prior = settings.byKey[storageKey(baseUrl, from)]
  if (prior !== undefined && settings.byKey[storageKey(baseUrl, to)] === undefined) {
    settings.set(storageKey(baseUrl, to), prior)
  }
  settings.clear(storageKey(baseUrl, from))
  rekeyAgentLastSessions(from, to)
  rekeySystemPromptSent(from, to)
}

export function ChatPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  // Desktop mTLS (#491): bumps when the gateway swaps onto the loopback
  // identity pipe with baseUrl unchanged — without it in the deps this
  // socket would stay on the pre-pipe gateway (which cannot authenticate)
  // for the whole session. Same-identity reconnects preserve chat state.
  const transportEpoch = useConnection((s) => s.transportEpoch)
  // Fine-grained selectors, NOT `useChat()`: subscribing the page to the
  // whole store would re-render the drawer + session view on every streaming
  // frame of the active turn.
  const connect = useChat((s) => s.connect)
  const drafts = useChat((s) => s.drafts)

  // One socket for the whole page; reconnect (and reset per-gateway state)
  // when the endpoint identity changes.
  useEffect(() => {
    connect(baseUrl)
    return () => useChat.getState().disconnect()
  }, [baseUrl, transportEpoch, connect])

  const connected = useGatewayReady()
  // The drawer lists the node's harness sessions straight from their on-disk
  // stores — node+harness specific by construction (the store is local disk,
  // so it never holds another node's sessions). Ids are the harness's native
  // session ids; opening one resumes it. Refresh is push-driven: the server
  // watches the store dirs and emits sessions-dirty; the slow interval is
  // only a safety net for missed events.
  const queryClient = useQueryClient()
  const sessionsDirty = useChat((s) => s.sessionsDirty)
  const harnessQuery = useQuery({
    queryKey: ['harness-sessions', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.harnessSessions(signal),
    refetchInterval: 120_000,
    enabled: connected,
  })

  // The node's driver registry + capability sheet. Rarely changes (drivers
  // register at boot), so it is cached hard and only re-read per endpoint.
  const registryQuery = useQuery({
    queryKey: ['harnesses', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.harnesses(signal),
    staleTime: 300_000,
    enabled: connected,
  })
  const descriptors = registryQuery.data?.harnesses

  // Control-plane sessions, one list per registered driver. A node with no
  // drivers (older den-server) simply returns nothing and the drawer falls
  // back to the legacy scan alone — that is the no-regression path.
  // Key is shared with the registry-stream merge path below — setQueryData
  // must hit the same entry the useQuery reads.
  const planeQueryKey = ['harness-plane-sessions', baseUrl, descriptors?.length ?? 0] as const
  const planeQuery = useQuery({
    queryKey: planeQueryKey,
    queryFn: ({ signal }) =>
      fetchHarnessPlaneSessions(useConnection.getState().gateway, descriptors, signal),
    enabled: connected && (descriptors?.length ?? 0) > 0,
    refetchInterval: 120_000,
  })

  const invalidateSessions = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['harness-sessions', baseUrl] })
    void queryClient.invalidateQueries({ queryKey: ['harness-plane-sessions', baseUrl] })
  }
  useEffect(() => {
    if (sessionsDirty > 0) invalidateSessions()
  }, [sessionsDirty, baseUrl, queryClient])

  // Registry stream: `session-created` / `session-updated` across every driver
  // so the drawer live-updates instead of polling (contract § gateway surface).
  // Fast path: merge the carried summary (or status patch) into the plane
  // session list cache so new/updated rows paint before the refetch returns.
  // Invalidation stays as reconciliation — a missed event, a partial cache,
  // or a server-side field the event does not carry still heals on the next
  // list fetch. Merged rows are full HarnessSessionSummary values (same shape
  // as listSessions), so plane-selection (`harnessGate`) cannot tell them apart.
  const hasDrivers = (descriptors?.length ?? 0) > 0
  useEffect(() => {
    if (!connected || !hasDrivers) return
    const sub = useConnection.getState().gateway.watchHarnesses((event) => {
      if (event.type !== 'session-created' && event.type !== 'session-updated') return
      // Identity changes land here first, and for a ROTATION this is the only
      // place both halves are known: `previousSessionId` shares no native id
      // with its successor, so nothing derivable from the drawer row could
      // find the thread the user has open. Adoption is folded in for every
      // opened thread, not just the active one — a background draft left in
      // `opened` under its bare id keeps catching bridge frames onto records
      // no drawer row renders.
      const previous = event.type === 'session-updated' ? event.previousSessionId : undefined
      for (const from of useChat.getState().adoptSessionKey(event.sessionId, previous)) {
        migrateSessionKey(baseUrl, from, event.sessionId)
      }
      queryClient.setQueryData<HarnessSessionSummary[]>(planeQueryKey, (prev) =>
        applyRegistryEventToPlaneSessions(prev, event),
      )
      // Fallback / reconciliation: refetch still runs so a raced merge cannot
      // leave the cache permanently wrong relative to the node.
      invalidateSessions()
    })
    return () => sub.close()
    // planeQueryKey fields are baseUrl/token/descriptors.length — listed
    // explicitly so the effect rebinds when the endpoint or driver set
    // changes. transportEpoch rebinds it onto the mTLS pipe gateway.
  }, [connected, hasDrivers, baseUrl, transportEpoch, queryClient, descriptors?.length])

  const items = useMemo(
    () =>
      chatItems({
        drafts,
        harnessSessions: planeQuery.data ?? [],
        legacySessions: harnessQuery.data?.sessions ?? [],
      }),
    [drafts, planeQuery.data, harnessQuery.data?.sessions],
  )
  const active = useChat((s) => s.active)
  const setActive = useChat((s) => s.setActive)
  const navigate = useNavigate()
  const { session: sessionFromUrl } = useSearch({ from: '/' })
  // Bidirectional ?session= sync. One effect, one direction at a time,
  // arbitrated by lastUrlRef so the two never fight:
  //   - URL changed (first load, deep link, back/forward) → URL wins. A
  //     CLEARED param wins too: back/forward or a shared `/` must drop the
  //     selection, or the UI keeps showing a thread the address bar disowns
  //     (and a refresh then loses).
  //   - Selection changed in the store (drawer click, rekey adoption,
  //     boundary close) → written back to the URL, replace-only, so
  //     refresh/share works without stuffing history. Draft ids are never
  //     written: drafts are memory-only, so a bookmarked `/?session=<uuid>`
  //     would remount ActiveSession for a conversation the drawer no longer
  //     has. The URL picks the thread up once the plane adopts it and the
  //     rekey effect moves `active` onto the canonical key.
  const lastUrlRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (sessionFromUrl !== lastUrlRef.current) {
      lastUrlRef.current = sessionFromUrl
      setActive(sessionFromUrl)
      return
    }
    const urlTarget = active !== undefined && !drafts.includes(active) ? active : undefined
    if (urlTarget !== sessionFromUrl) {
      lastUrlRef.current = urlTarget
      void navigate({ to: '/', search: urlTarget ? { session: urlTarget } : {}, replace: true })
    }
  }, [sessionFromUrl, active, drafts, setActive, navigate])
  // Tolerant lookup: the open thread's key changes under the selection when
  // the plane adopts a draft (bare uuid → canonical) or a driver rotates the
  // native id. The rekey effect below moves the conversation onto the new
  // key; until it runs, this keeps the view rendering the right row instead
  // of blanking it.
  const activeItem = findChatItem(items, active)
  const gate = harnessGate(activeItem, descriptors)

  // Reconciliation for the adoption the registry stream did not deliver — a
  // missed event, a node with no registry stream, or a plane refetch that
  // revealed the claim first. Rotation is NOT reachable from here (the new
  // row shares no native half with the retired key, so `findChatItem` returns
  // nothing); that path is wired to `session-updated` above.
  const activeKey = activeItem?.key
  useEffect(() => {
    if (active === undefined || activeKey === undefined || activeKey === active) return
    // Only migrate persisted state when the records actually moved — see
    // `migrateSessionKey`.
    if (useChat.getState().rekey(active, activeKey)) migrateSessionKey(baseUrl, active, activeKey)
  }, [active, activeKey, baseUrl])

  // Resizable drawer: cut-off titles are the drawer's whole job, so the user
  // decides how much room they get. Persisted; double-click resets.
  const [drawerWidth, setDrawerWidth] = useState(() => {
    try {
      const raw = localStorage.getItem('rivethub.drawerWidth')
      return raw ? clampDrawerWidth(Number(raw)) : DRAWER_WIDTH_DEFAULT
    } catch {
      return DRAWER_WIDTH_DEFAULT
    }
  })
  const commitDrawerWidth = (w: number): void => {
    setDrawerWidth(w)
    try {
      localStorage.setItem('rivethub.drawerWidth', String(w))
    } catch {
      /* storage disabled — width just won't persist */
    }
  }

  if (!connected) return <NotConnected />

  return (
    <div className="flex h-full">
      <SessionDrawer
        items={items}
        active={active}
        width={drawerWidth}
        error={harnessQuery.isError ? harnessQuery.error.message : undefined}
      />
      <SplitHandle
        width={drawerWidth}
        onResize={setDrawerWidth}
        onCommit={commitDrawerWidth}
        onReset={() => commitDrawerWidth(DRAWER_WIDTH_DEFAULT)}
      />
      {active ? (
        // Keyed by session id: switching conversations must fully remount so
        // the view (chat/terminal/den), the attached PTY, and the transcript
        // all belong to the newly-selected session. Without the key React
        // reuses the instance and a Terminal-mode switch keeps showing the
        // previous conversation's PTY (stale mode/termPtyId).
        // Error boundary: a render crash must not trap the whole shell —
        // "back to conversations" clears selection without quitting.
        <SessionErrorBoundary key={active} sessionId={active} onClose={() => setActive(undefined)}>
          <ActiveSession
            sessionId={active}
            item={activeItem}
            gate={gate}
            harnessCommand={activeItem?.command}
          />
        </SessionErrorBoundary>
      ) : (
        <EmptyState />
      )}
    </div>
  )
}

/** One conversation row — shows the custom name (if set) over the derived
 *  title, with inline rename (pencil on hover → input; Enter/blur saves, empty
 *  clears, Escape cancels). Rename persists per node+session (localStorage).
 *  Control-plane rows also carry a harness badge (§ Session identity: "UI may
 *  badge harness + short native suffix"). */
function DrawerItem(props: {
  item: ChatItem
  active: boolean
  archived: boolean
  onSelect: () => void
  onArchive: () => void
  onUnarchive: () => void
  /** Drafts only — a draft is local, so discarding it is a real delete. */
  onDiscard?: () => void
}): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const key = storageKey(baseUrl, props.item.key)
  const customName = useSessionNames((s) => persisted(s.byKey, baseUrl, props.item.key))
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
        title={
          props.item.sessionId ??
          (props.item.command ? `${props.item.command} · ${props.item.key}` : props.item.key)
        }
        className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs ${
          props.active ? 'text-em' : 'text-ink-dim group-hover:text-ink'
        }`}
      >
        {/* harness accent: claude clay / grok grey / local emerald */}
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: harnessAccent(props.item.harnessId ?? props.item.command) }}
          aria-hidden
        />
        <span className="min-w-0 truncate">{customName ?? props.item.title}</span>
        {/* live pip: a turn in flight pulses; an alive-but-quiet session is a
            steady dim dot. `status` only exists for control-plane rows. */}
        {props.item.status === 'active' && (
          <span className="relative flex size-1.5 shrink-0" title="turn in flight">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-em opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-em" />
          </span>
        )}
        {props.item.status === 'idle' && (
          <span className="size-1.5 shrink-0 rounded-full bg-em/40" title="session alive" />
        )}
        {props.item.harnessId && (
          <span
            title={`${props.item.harnessId} ${shortNativeId(props.item.key)}`}
            className="shrink-0 rounded bg-panel-2 px-1 font-mono text-[9px] text-ink-dim"
          >
            {props.item.harnessId}
          </span>
        )}
      </button>
      <span className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        <button
          onClick={() => {
            setDraft(customName ?? props.item.title)
            setEditing(true)
          }}
          aria-label="rename conversation"
          title="rename"
          className="px-1 py-2 text-ink-dim hover:text-em"
        >
          <Pencil className="size-3" />
        </button>
        {props.onDiscard ? (
          <button
            onClick={props.onDiscard}
            aria-label="discard draft"
            title="discard draft"
            className="px-1 py-2 pr-2 text-ink-dim hover:text-red"
          >
            <Trash2 className="size-3" />
          </button>
        ) : props.archived ? (
          <button
            onClick={props.onUnarchive}
            aria-label="unarchive conversation"
            title="unarchive"
            className="px-1 py-2 pr-2 text-ink-dim hover:text-em"
          >
            <ArchiveRestore className="size-3" />
          </button>
        ) : (
          <button
            onClick={props.onArchive}
            aria-label="archive conversation"
            title="archive (hides the row — the session itself is untouched)"
            className="px-1 py-2 pr-2 text-ink-dim hover:text-em"
          >
            <Archive className="size-3" />
          </button>
        )}
      </span>
    </div>
  )
}

/** Drawer shows a filter box once the list stops being glanceable. */
const DRAWER_FILTER_MIN = 6

function SessionDrawer(props: {
  items: ChatItem[]
  active?: string
  width: number
  error?: string
}): JSX.Element {
  const setActive = useChat((s) => s.setActive)
  const addDraft = useChat((s) => s.addDraft)
  const removeDraft = useChat((s) => s.removeDraft)
  const wsStatus = useChat((s) => s.wsStatus)
  const baseUrl = useConnection((s) => s.baseUrl)
  const names = useSessionNames((s) => s.byKey)
  const archivedKeys = useArchived((s) => s.keys)
  const archive = useArchived((s) => s.archive)
  const unarchive = useArchived((s) => s.unarchive)
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState('')

  const isArchived = (key: string): boolean => archivedKeys.includes(storageKey(baseUrl, key))
  const archivedCount = props.items.reduce((n, it) => n + (isArchived(it.key) ? 1 : 0), 0)

  // Filter on what the user actually SEES: custom name first, then the
  // derived title, then the raw id (so pasting a session uuid works too).
  const q = filter.trim().toLowerCase()
  const items = props.items.filter((it) => {
    // The active thread always stays listed — hiding the row under the
    // user's feet would strand the open conversation.
    if (!showArchived && isArchived(it.key) && it.key !== props.active) return false
    if (!q) return true
    const custom = persisted(names, baseUrl, it.key) ?? ''
    return (
      custom.toLowerCase().includes(q) ||
      it.title.toLowerCase().includes(q) ||
      it.key.toLowerCase().includes(q) ||
      (it.harnessId ?? '').includes(q)
    )
  })

  return (
    <div
      style={{ width: props.width }}
      className="flex shrink-0 flex-col border-r border-line bg-panel/40"
    >
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
      {(props.items.length >= DRAWER_FILTER_MIN || q) && (
        <div className="px-3 pb-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            aria-label="filter conversations"
            className="w-full rounded border border-line bg-panel px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-dim/60 focus:border-em"
          />
        </div>
      )}
      {props.error && <div className="px-3 py-2 font-mono text-xs text-red">{props.error}</div>}
      <div className="flex-1 overflow-y-auto px-2">
        {items.map((it) => (
          <DrawerItem
            key={it.key}
            item={it}
            active={it.key === props.active}
            archived={isArchived(it.key)}
            onSelect={() => setActive(it.key)}
            onArchive={() => archive(storageKey(baseUrl, it.key))}
            onUnarchive={() => unarchive(storageKey(baseUrl, it.key))}
            onDiscard={it.kind === 'draft' ? () => removeDraft(it.key) : undefined}
          />
        ))}
        {items.length === 0 && q && (
          <div className="px-3 py-2 text-xs text-ink-dim">no matches for “{filter.trim()}”</div>
        )}
        {props.items.length === 0 && !props.error && (
          <div className="px-3 py-2 text-xs text-ink-dim">no conversations yet</div>
        )}
      </div>
      {archivedCount > 0 && (
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="border-t border-line px-3 py-2 text-left font-mono text-[11px] text-ink-dim hover:text-ink"
        >
          {showArchived ? '▾' : '▸'} archived ({archivedCount})
        </button>
      )}
    </div>
  )
}

function ActiveSession(props: {
  sessionId: string
  /** Drawer row for this session (absent for a just-created draft). */
  item?: ChatItem
  /** Which control-plane affordances this session's driver actually has. */
  gate: HarnessGate
  harnessCommand?: string
}): JSX.Element {
  /** Canonical `<harness-id>:<native>` when the control plane owns this row. */
  const canonicalId = props.gate.bound ? props.item?.sessionId : undefined
  const baseUrl = useConnection((s) => s.baseUrl)
  // Chat is the starting place; the last-used view is remembered per thread
  // (terminal/den stick once chosen). Remounts per session, so the lazy
  // initializer re-reads on every switch.
  const [mode, setModeState] = useState<SessionViewMode>(() =>
    getSessionMode(storageKey(baseUrl, props.sessionId)),
  )
  const setMode = (m: SessionViewMode): void => {
    setModeState(m)
    setSessionMode(storageKey(baseUrl, props.sessionId), m)
  }
  const [termPtyId, setTermPtyId] = useState<string | undefined>()
  const [termError, setTermError] = useState<string | undefined>()
  // ref mirrors termPtyId so the unmount cleanup can kill the current PTY
  // (state is captured stale in an unmount-only effect)
  const termPtyRef = useRef<string | undefined>(undefined)
  termPtyRef.current = termPtyId
  // Selectors must return stable references when empty (see EMPTY_* above).
  const messages = useChat((s) => s.messages[props.sessionId] ?? EMPTY_MESSAGES)
  // The live turn changes identity on every streaming tick. Subscribe to the
  // full object only while it is actually rendered (chat mode); terminal/den
  // ride the boolean selectors below, so a busy stream doesn't repaint the
  // whole session view (header, xterm, iframe) per token.
  const live = useChat((s) => (mode === 'chat' ? s.live[props.sessionId] : undefined))
  const liveBusy = useChat((s) => {
    const L = s.live[props.sessionId]
    return !!(L && (L.text || L.tools.length > 0 || L.reasoningText))
  })
  const liveExists = useChat((s) => s.live[props.sessionId] !== undefined)
  // Context-fill: prefer the newest assistant turn that still carries usage
  // (Claude live path + harness resync). Fall back to the latest assistant
  // for model id; ContextBar estimates tokens when usage is absent.
  let lastAssistant: (typeof messages)[number] | undefined
  let lastWithUsage: (typeof messages)[number] | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    if (!lastAssistant) lastAssistant = messages[i]
    if (!lastWithUsage && (messages[i].usage?.promptTokens ?? 0) > 0) {
      lastWithUsage = messages[i]
    }
    // lastAssistant is necessarily set by this point (the first assistant
    // row assigns it), so lastWithUsage alone decides whether we're done.
    if (lastWithUsage) break
  }
  const contextSource = lastWithUsage ?? lastAssistant
  const wsStatus = useChat((s) => s.wsStatus)
  const wsEpoch = useChat((s) => s.wsEpoch)
  const seed = useChat((s) => s.seed)
  const dialOrigin = useConnection((s) => s.gateway.config.baseUrl)

  // per-conversation model + effort (persisted). Keyed per node + thread, with
  // the pre-canonical key as a read fallback; writes land on the new key.
  const settingsKey = storageKey(baseUrl, props.sessionId)
  const settings = useChatSettings((s) => persisted(s.byKey, baseUrl, props.sessionId))
  const setSetting = useChatSettings((s) => s.set)

  // ---- Transcript binding ---------------------------------------------------
  //
  // Control plane (driver-owned, liveStream on): tail
  // `WS /api/harness-sessions/ws` and hard-resync the transcript on every
  // (re)connect. The tail is at-most-once from attach time with no replay, so
  // re-subscribing is only half the recovery — the resync is the other half
  // (harness-control-plane.md § Contract semantics).
  //
  // Otherwise: the legacy push-synced watch. The server watches the on-disk
  // store and pushes turn deltas over the sessions WS; the store applies them.
  const streamId = props.gate.stream ? canonicalId : undefined
  const [streamError, setStreamError] = useState<string | undefined>()
  // transportEpoch: enrolling mid-run swaps the gateway onto the mTLS pipe;
  // the attach below snapshots the gateway, so it must tear down and rebind
  // or the open socket is stranded on a transport that can no longer auth.
  const transportEpoch = useConnection((s) => s.transportEpoch)
  useEffect(() => {
    if (streamId === undefined) {
      useChat.getState().watchTranscript(props.sessionId)
      return () => useChat.getState().unwatchTranscript(props.sessionId)
    }
    useChat.getState().bindHarness(props.sessionId, props.item?.harnessId ?? 'harness')
    const attachment = attachHarnessSession({
      gateway: useConnection.getState().gateway,
      sessionId: streamId,
      onTranscript: (turns) => useChat.getState().syncHarnessTranscript(props.sessionId, turns),
      onLive: (turn) => useChat.getState().setLive(props.sessionId, turn),
      onApproval: (event) => useChat.getState().applyApprovalEvent(props.sessionId, event),
      onError: (err) => setStreamError(err instanceof Error ? err.message : String(err)),
      // Terminal: the attachment has already stopped itself, so say so plainly
      // instead of leaving a banner that looks like it might clear.
      onFatal: (message) => {
        useChat.getState().setLive(props.sessionId, undefined)
        setStreamError(`${message} — this session is no longer attachable`)
      },
      onStatus: (status) => {
        if (status === 'open') setStreamError(undefined)
      },
    })
    return () => {
      attachment.close()
      useChat.getState().unbindHarness(props.sessionId)
    }
  }, [props.sessionId, streamId, props.item?.harnessId, transportEpoch])
  const transcript = useChat((s) => s.transcripts[props.sessionId])
  const storeHasTurns = (transcript?.turns.length ?? 0) > 0
  // Backfill gate: the store snapshot came back empty (API-only agents, fresh
  // drafts) — or no transcript frame arrived within a grace window (slow WS /
  // old server), where waiting forever would blank a ring-backed session.
  const [txGraceUp, setTxGraceUp] = useState(false)
  useEffect(() => {
    setTxGraceUp(false)
    const t = setTimeout(() => setTxGraceUp(true), 2_500)
    return () => clearTimeout(t)
  }, [props.sessionId, wsEpoch])
  const storeEmpty =
    (transcript !== undefined && transcript.turns.length === 0) ||
    (transcript === undefined && txGraceUp)

  // HTTP ring backfill — only when the TUI store has nothing (fresh draft /
  // API agent / node without a harness file). seed() MERGES so live WS frames
  // that raced in are kept.
  const backfill = useQuery({
    queryKey: ['session-messages', baseUrl, props.sessionId, wsEpoch],
    queryFn: ({ signal }) =>
      useConnection.getState().gateway.sessionMessages(props.sessionId, signal),
    enabled: storeEmpty,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  })
  useEffect(() => {
    if (storeHasTurns) return
    if (backfill.data) seed(props.sessionId, backfill.data.messages)
  }, [backfill.data, props.sessionId, storeHasTurns, seed])

  // Cold-session durable backfill (seamless 5e): empty ring + empty TUI →
  // memory conversation. Same enable gate as ring.
  const ringEmpty = backfill.isSuccess && backfill.data.messages.length === 0
  const coldBackfill = useQuery({
    queryKey: ['conv-messages', baseUrl, props.sessionId, wsEpoch],
    queryFn: ({ signal }) =>
      useConnection.getState().gateway.conversationMessages(props.sessionId, signal),
    enabled: storeEmpty && ringEmpty,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  })
  useEffect(() => {
    if (storeHasTurns) return
    if (coldBackfill.data?.messages.length) seed(props.sessionId, coldBackfill.data.messages)
  }, [coldBackfill.data, props.sessionId, storeHasTurns, seed])

  // Leaving a conversation does NOT kill its harness: detach only. Switching
  // away mid-turn must not abort the harness — the reply keeps streaming to
  // the chat via the bridge, and reopening reattaches the same live PTY. The
  // key on <ActiveSession> already resets this view's mode/termPtyId; the PTY
  // is cleaned up by XtermAttach's detach (WS close → detached TTL) and the
  // manager's LRU pool at maxPtys, not by a kill-on-leave.

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
      // Clear the ref synchronously, not just the state: until
      // the next render re-mirrors termPtyId, ensurePty() would otherwise
      // hand back the just-killed pty id and chat send would inject into a
      // dead PTY → 409. Mode stays put — the terminal spawn effect respawns
      // with the newly chosen model if terminal is showing.
      termPtyRef.current = undefined
      setTermPtyId(undefined)
    }
  }, [agentSel])

  // Ensure THE harness for this conversation exists (seamless join key):
  // spawn-or-get a PTY whose denSession IS props.sessionId, so chat (inject +
  // bridge), terminal (this PTY), and den (?session) are one live harness.
  // Idempotent server-side; the client guard avoids UI churn on double calls.
  // The single-flight mutex is lib/pty-ensure.ts (the spawn effect, chat
  // sends, and StrictMode double-mounts must share ONE spawn request, not
  // race two past the termPtyRef check — grok review, PR #349); the ref
  // indirection keeps the ensurer on the latest spawn closure (the model
  // dropdown changes the command between renders).
  const spawnPty = async (): Promise<string> => {
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
  const spawnPtyRef = useRef(spawnPty)
  spawnPtyRef.current = spawnPty
  const ensurePtyRef = useRef<(() => Promise<string>) | null>(null)
  ensurePtyRef.current ??= createPtyEnsurer({
    current: () => termPtyRef.current,
    spawn: () => spawnPtyRef.current(),
  })
  const ensurePty = ensurePtyRef.current

  // Terminal mode (including on open — it's the default) reveals the
  // conversation's harness: spawn-or-get whenever terminal is active with no
  // PTY. The gate ref is the mutex (state is async — grok review, PR #349):
  // 'inflight' blocks re-entry, 'failed' parks the effect so a broken node
  // doesn't retry-loop; clicking Terminal is the manual retry (spawnNonce
  // re-arms the effect even when mode is already 'terminal').
  const spawnGate = useRef<'idle' | 'inflight' | 'failed'>('idle')
  const [spawnNonce, setSpawnNonce] = useState(0)
  useEffect(() => {
    if (mode !== 'terminal' || termPtyId) return
    if (spawnGate.current !== 'idle') return
    spawnGate.current = 'inflight'
    setTermError(undefined) // a stale error must not mask this attempt
    void ensurePty()
      .then(() => {
        spawnGate.current = 'idle'
        setTermError(undefined)
      })
      .catch((e: unknown) => {
        spawnGate.current = 'failed'
        setTermError((e as Error).message)
      })
  }, [mode, termPtyId, spawnNonce, props.sessionId])

  const enterTerminal = (): void => {
    if (spawnGate.current === 'failed') {
      spawnGate.current = 'idle'
      setSpawnNonce((n) => n + 1)
    }
    setMode('terminal')
  }

  // Seamless chat send: enqueue + serial inject. The queue is visible in the
  // transcript (queued / sending badges + inject/cancel). The pump itself —
  // single-flight latch, inject latch, turn_in_flight backoff, stale-turn
  // release — is lib/outbound-pump.ts and lives in the module-level registry
  // above so the latch survives this component's remounts; the sink rebind
  // keeps it on the latest injectOne closure (gate/canonicalId change
  // between renders AND between mounts).
  const enqueueOutbound = useChat((s) => s.enqueueOutbound)
  const clearLive = useChat((s) => s.clearLive)
  const liveIsBusy = useChat((s) => s.liveIsBusy)
  const outbound = useChat((s) => s.outbound[props.sessionId] ?? EMPTY_OUTBOUND)
  const pendingAsk = useChat((s) => s.ask[props.sessionId])
  const dismissAsk = useChat((s) => s.dismissAsk)
  const composerRef = useRef<ComposerHandle | null>(null)
  const pumpEntry = outboundPumpFor(props.sessionId)

  // Ask card content: the live turn's ask tool wins (question just streamed
  // in); after the turn ends the store's stashed copy keeps the card up until
  // answered. Dismiss also has to silence the LIVE source (the store stash is
  // cleared, but live.tools still carries the tool), so a local flag covers
  // it — reset whenever a different question shows up.
  const [askDismissed, setAskDismissed] = useState(false)
  const liveAsk = questionsFromLiveTools(live?.tools ?? [])
  const askQuestions = liveAsk.length > 0 ? liveAsk : (pendingAsk ?? [])
  // Cheap identity for "a different question showed up" — stringifying the
  // whole array every render scales with option payloads.
  const askKey = `${String(askQuestions.length)}:${askQuestions[0]?.question ?? ''}:${String(
    askQuestions[0]?.options.length ?? 0,
  )}`
  useEffect(() => setAskDismissed(false), [askKey])
  const onDismissAsk = (): void => {
    setAskDismissed(true)
    dismissAsk(props.sessionId)
  }

  const peekSystemPrompt = (): string | undefined => {
    if (wasSystemPromptSent(props.sessionId)) return undefined
    const chat = useChat.getState()
    if ((chat.messages[props.sessionId] ?? EMPTY_MESSAGES).length > 0) return undefined
    if ((chat.transcripts[props.sessionId]?.turns.length ?? 0) > 0) return undefined
    const prompt = persisted(
      useChatSettings.getState().byKey,
      useConnection.getState().baseUrl,
      props.sessionId,
    )?.systemPrompt?.trim()
    return prompt || undefined
  }

  const injectOne = async (text: string, interrupt = false): Promise<void> => {
    const gw = useConnection.getState().gateway
    const prompt = peekSystemPrompt()
    if (canonicalId) {
      // Control plane: the driver owns spawn-or-resume, so there is no PTY to
      // ensure here. "Inject now" is interrupt-then-send, and only when the
      // driver actually has an interrupt (a false flag answers 501).
      if (interrupt && props.gate.canInterrupt) {
        await gw.interruptHarnessSession(canonicalId).catch(() => undefined)
        // Same beat the legacy interrupt-inject waits: the TUI needs a moment
        // to draw its cancel before the next paste, or the turn swallows it.
        await new Promise((r) => setTimeout(r, INTERRUPT_SETTLE_MS))
      }
      try {
        await gw.sendHarnessTurn(canonicalId, {
          text,
          ...(prompt ? { systemPrompt: prompt } : {}),
        })
        if (prompt) markSystemPromptSent(props.sessionId)
      } catch (err) {
        clearSystemPromptSent(props.sessionId)
        throw err
      }
      return
    }
    const injectText = prompt ? prefixSystemPrompt(prompt, text) : text
    try {
      await ensurePty()
      try {
        await gw.termInject({
          session: props.sessionId,
          text: injectText,
          ...(interrupt ? { interrupt } : {}),
        })
      } catch {
        // The harness may have been LRU-evicted while we held a stale pty ref
        //: drop the ref, respawn (store-existence → --resume so
        // context is kept), and retry once. A fresh harness has no turn to
        // interrupt, so the retry never sends Esc.
        termPtyRef.current = undefined
        setTermPtyId(undefined)
        await ensurePty()
        await gw.termInject({ session: props.sessionId, text: injectText })
      }
      if (prompt) markSystemPromptSent(props.sessionId)
    } catch (err) {
      clearSystemPromptSent(props.sessionId)
      throw err
    }
  }

  pumpEntry.sink.current = injectOne

  const pumpOutbound = (opts?: { forceId?: string; interrupt?: boolean }): Promise<void> =>
    pumpEntry.pump.pump(opts)

  // When a live turn ends (or the queue grows while idle), inject the next.
  useEffect(() => {
    if (liveIsBusy(props.sessionId)) return
    void pumpOutbound().catch(() => undefined)
  }, [liveBusy, outbound.length, props.sessionId])

  // Stale-turn release: the watcher itself is lib/outbound-pump.ts. Armed
  // only while something is actually queued — releasing is for the pump, not
  // the view, and a false positive on an idle queue would just kill a healthy
  // bubble.
  const hasQueued = outbound.some((o) => o.status === 'queued')
  useEffect(() => {
    if (!liveExists || !hasQueued) return
    return startStaleTurnRelease(pumpStore, props.sessionId)
  }, [liveExists, hasQueued, props.sessionId])

  const sendToHarness = (body: string): Promise<void> => {
    enqueueOutbound(props.sessionId, body)
    // Fire-and-forget pump — composer unlocks immediately so more turns queue.
    void pumpOutbound().catch(() => undefined)
    return Promise.resolve()
  }

  // Stable identities: these reach every Bubble through the transcript, and a
  // fresh closure per render would defeat memo(Bubble) across the board.
  const onInjectOutbound = useCallback(
    (id: string): void => {
      // Inject NOW means now: Esc the in-flight turn so the harness drops what
      // it's doing and picks this message up (idle harness: the Esc is a no-op).
      const interrupt = useChat.getState().liveIsBusy(props.sessionId)
      void pumpEntry.pump.pump({ forceId: id, interrupt }).catch(() => undefined)
    },
    [props.sessionId, pumpEntry],
  )

  const onCancelOutbound = useCallback(
    (id: string): void => {
      // Recall, don't discard: the text goes back into the composer so it can
      // be edited and re-sent (prepended above any draft already in progress).
      const item = useChat.getState().outbound[props.sessionId]?.find((o) => o.id === id)
      useChat.getState().cancelOutbound(props.sessionId, id)
      if (item?.text) composerRef.current?.prepend(item.text)
      // Free the pump only when the cancelled id IS the in-flight send — the
      // pump itself decides (a cancel of another queued bubble must not drop
      // the inject latch). The re-pump no-ops while the latch holds.
      pumpEntry.pump.reset(id)
      void pumpEntry.pump.pump().catch(() => undefined)
    },
    [props.sessionId, pumpEntry],
  )

  // While a live turn streams, the store may already carry its partial solid
  // turn (blocks flush to disk as they commit) — hide that last in-flight
  // assistant message so the live bubble (which renders the same content
  // plus the streaming cursor) is its only representation. It reappears the
  // moment the live slot clears.
  const lastMsg = messages.at(-1)
  const shownMessages = useMemo(
    () =>
      liveBusy && lastMsg?.role === 'assistant' && lastMsg.id.startsWith('harness:')
        ? messages.slice(0, -1)
        : messages,
    [liveBusy, lastMsg, messages],
  )
  // Memoized per-render derivations: ContextBar / Transcript re-render on
  // identity, and a fresh array each frame would defeat that on every
  // streaming tick.
  const transcriptTexts = useMemo(() => messages.map((m) => m.text), [messages])
  const outboundStatus = useMemo(
    () => Object.fromEntries(outbound.map((o) => [o.id, o.status])),
    [outbound],
  )

  // Capability-gated affordances. `canInterrupt` is the driver's own flag —
  // hidden rather than shown-and-501'd when the node has no interrupt path.
  const onInterrupt = (): void => {
    if (!canonicalId) return
    void useConnection
      .getState()
      .gateway.interruptHarnessSession(canonicalId)
      .then(() => clearLive(props.sessionId))
      .catch((e: unknown) => setStreamError(e instanceof Error ? e.message : String(e)))
  }

  // Approvals only exist for drivers that surface their permission gate on the
  // wire; `claude-code` reports `approvals: false` always (its prompts live
  // inside the TUI), so this stays empty there.
  const pendingApprovals = useChat((s) => s.approvals[props.sessionId])
  const onDecideApproval = (requestId: string, decision: ApprovalDecision): void => {
    if (!canonicalId) return
    // Optimistic: the driver broadcasts approval-resolved to every subscriber,
    // which clears the card again on any other client. Restore it if the POST
    // fails, though — the harness is still blocked on that request, and a
    // vanished card would leave the session wedged with nothing to click.
    const request = useChat
      .getState()
      .approvals[props.sessionId]?.find((p) => p.requestId === requestId)
    useChat.getState().clearApproval(props.sessionId, requestId)
    void useConnection
      .getState()
      .gateway.resolveHarnessApproval(canonicalId, requestId, decision)
      .catch((e: unknown) => {
        setStreamError(e instanceof Error ? e.message : String(e))
        if (request) useChat.getState().applyApprovalEvent(props.sessionId, request)
      })
  }

  // The viewer bundle matches `?session=` against the ROOM keys in its own den
  // snapshot, so this is the one hub→id handoff that does not go through a
  // den-server edge and has to be projected onto the den's key space.
  // Use the dial origin (desktop mTLS loopback pipe), not the https node URL —
  // an iframe to https://node:5174 is a new TLS session and WebKit cannot
  // present the device cert, so the den returns 401.
  const denUrl = `${dialOrigin.replace(/\/+$/, '')}/den/?session=${encodeURIComponent(denRoomKey(props.sessionId))}`

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-panel/40 px-4 py-1.5">
        {/* Canonical `<harness-id>:<native>` once the control plane owns the
            session; the bare den join key until then. */}
        <span className="truncate font-mono text-xs text-ink-dim">
          {canonicalId ?? props.sessionId}
        </span>
        {/* Context-fill bar — reported usage when present; else estimate. */}
        <ContextBar
          tokens={contextSource?.usage?.promptTokens}
          model={
            contextSource?.model || lastAssistant?.model || settings?.agent || props.harnessCommand
          }
          transcriptTexts={transcriptTexts}
        />
        {/* Interrupt is the driver's capability, not a UI preference: shown
            only when the control plane owns this session AND reports one. */}
        {props.gate.canInterrupt && liveBusy && (
          <button
            onClick={onInterrupt}
            title="cancel the in-flight turn"
            className="flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 font-mono text-[11px] text-ink-dim hover:border-red hover:text-red"
          >
            <Square className="size-2.5 fill-current" aria-hidden />
            Stop
          </button>
        )}
        {/* [Terminal | Chat | Den] — three views of ONE session, ordered by
            immersion (terminal is home); the bar stays visible so the den
            never takes over with no way back. */}
        <span className="shrink-0">
          <SegmentedControl
            ariaLabel="Session view"
            value={mode}
            onChange={(v) => {
              // Terminal goes through enterTerminal: a parked ('failed')
              // spawn gate re-arms the spawn effect.
              if (v === 'terminal') enterTerminal()
              else setMode(v)
            }}
            options={[
              { value: 'terminal', label: 'Terminal' },
              { value: 'chat', label: 'Chat' },
              { value: 'den', label: '▦ Den', title: 'the den for this conversation' },
            ]}
          />
        </span>
      </div>
      {mode === 'chat' ? (
        <>
          {/* Transcript owns its scroll container (stick-to-bottom lives there). */}
          <Transcript
            messages={shownMessages}
            accent={harnessAccent(props.harnessCommand ?? settings?.agent)}
            live={live}
            outbound={outboundStatus}
            onInjectOutbound={onInjectOutbound}
            onCancelOutbound={onCancelOutbound}
          />
          {outbound.some((o) => o.status === 'queued') && (
            <div className="border-t border-line bg-panel-2/40 px-4 py-1.5 font-mono text-[11px] text-ink-dim">
              {outbound.filter((o) => o.status === 'queued').length} message
              {outbound.filter((o) => o.status === 'queued').length === 1 ? '' : 's'} queued — will
              send when Rivet finishes the current turn (or use inject on the bubble)
            </div>
          )}
          {streamError && (
            <div className="border-t border-line bg-panel-2/40 px-4 py-1.5 font-mono text-[11px] text-red">
              harness stream: {streamError}
            </div>
          )}
          {props.gate.canApprove && pendingApprovals && pendingApprovals.length > 0 && (
            <div className="px-4">
              <HarnessApprovalCard pending={pendingApprovals} onDecide={onDecideApproval} />
            </div>
          )}
          <Composer
            sessionId={props.sessionId}
            wsStatus={wsStatus}
            settingsKey={settingsKey}
            agent={settings?.agent || undefined}
            effort={settings?.effort ?? 'medium'}
            systemPrompt={settings?.systemPrompt}
            onSetting={(patch) => setSetting(settingsKey, patch)}
            onSend={sendToHarness}
            handleRef={composerRef}
            ask={askDismissed ? [] : askQuestions}
            onDismissAsk={onDismissAsk}
          />
        </>
      ) : mode === 'den' ? (
        // Embedded, not a link-out: replaces the chat/terminal area so the
        // toggle bar (the way back) stays put. Same session as chat/terminal.
        <iframe
          key={`${dialOrigin}|${props.sessionId}`}
          src={denUrl}
          title="den"
          className="min-h-0 flex-1 border-0 bg-bg"
        />
      ) : termError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1">
          <span className="font-mono text-sm text-red">{termError}</span>
          <span className="text-xs text-ink-dim">click Terminal to retry</span>
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
