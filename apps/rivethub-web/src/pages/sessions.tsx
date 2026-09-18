/**
 * Session pages — node session index + read-only detail with a visible
 * reconnect → transcript-restore strip. Weekend slice: no composer.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Check, ChevronDown, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import type {
  HarnessSessionSummary,
  HarnessStatusFrame,
  HarnessTranscriptTurn,
  SessionMessage,
} from '@rivetos/types'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { Select } from '../components/select.js'
import { ContextBar } from '../components/context-bar.js'
import { Transcript } from '../components/transcript.js'
import { Button } from '../components/ui/button.js'
import { accentFor } from '../lib/agent-accent.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import {
  applyRegistryEventToPlaneSessions,
  chatItems,
  fetchHarnessPlaneSessions,
  shortNativeId,
} from '../lib/harness-chat.js'
import { attachHarnessSession, type SessionContextStamp } from '../lib/harness-attach.js'
import {
  applyTranscriptEvent,
  emptyTranscript,
  resyncTranscript,
  type SessionTranscript,
} from '../lib/session-transcript.js'
import { messagesFromHarnessTurns } from '../lib/harness-turns.js'
import type { LiveTurn } from '../lib/fold-stream.js'
import {
  cwdBasename,
  filterSessionList,
  harnessFilterOptions,
  sessionListRows,
  type SessionListRow,
  type SessionStatusFilter,
} from '../lib/session-list.js'
import {
  resolveSessionRouteParam,
  sessionDetailPath,
  sessionLookupId,
  sessionRouteParam,
} from '../lib/session-route-id.js'
import { createSyncLog, syncLogReducer, type SyncCause } from '../lib/session-sync-log.js'
import { useIsNarrow } from '../lib/use-narrow.js'
import { cn } from '../lib/utils.js'
import { useConnection } from '../stores/connection.js'

function relativeUpdated(ms: number, now = Date.now()): string {
  if (!ms) return '—'
  const ago = now - ms
  if (ago < 90_000) return 'just now'
  if (ago < 3_600_000) return `${String(Math.round(ago / 60_000))}m ago`
  if (ago < 86_400_000) return `${String(Math.round(ago / 3_600_000))}h ago`
  return `${String(Math.round(ago / 86_400_000))}d ago`
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const STATUS_PILL: Record<string, string> = {
  active: 'border-em/40 bg-em/10 text-em',
  idle: 'border-line bg-panel-2 text-ink-dim',
  ended: 'border-line bg-bg text-ink-dim',
  error: 'border-red/40 bg-red/10 text-red',
}

function StatusPill(props: { status?: string; blocked?: boolean }): JSX.Element | null {
  if (!props.status && !props.blocked) return null
  return (
    <span className="inline-flex items-center gap-1">
      {props.status && (
        <span
          className={cn(
            'rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide',
            STATUS_PILL[props.status] ?? STATUS_PILL.idle,
          )}
        >
          {props.status}
        </span>
      )}
      {props.blocked && (
        <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] text-warn">
          blocked
        </span>
      )}
    </span>
  )
}

function HarnessBadge(props: { harnessId?: string; command?: string }): JSX.Element | null {
  const label = props.harnessId ?? props.command
  if (!label) return null
  const color = accentFor({ harnessId: props.harnessId, command: props.command })
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
      title={label}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  )
}

function CopyableId(props: { value: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={props.label ?? 'Copy id'}
      className="inline-flex max-w-full items-center gap-1 rounded border border-transparent px-1 font-mono text-[11px] text-ink-dim hover:border-line hover:bg-panel-2 hover:text-ink"
      onClick={() => {
        void copyTextToClipboard(props.value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      <span className="min-w-0 truncate">{props.value}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-em" />
      ) : (
        <Copy className="size-3 shrink-0" />
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export function SessionsPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const connected = useGatewayReady()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const narrow = useIsNarrow()
  const [harnessFilter, setHarnessFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all')
  const [textFilter, setTextFilter] = useState('')
  const [listResyncedAt, setListResyncedAt] = useState<number | undefined>()

  const registryQuery = useQuery({
    queryKey: ['harnesses', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.harnesses(signal),
    staleTime: 300_000,
    enabled: connected,
  })
  const descriptors = registryQuery.data?.harnesses

  const planeQueryKey = ['harness-plane-sessions', baseUrl, descriptors?.length ?? 0] as const
  const planeQuery = useQuery({
    queryKey: planeQueryKey,
    queryFn: ({ signal }) =>
      fetchHarnessPlaneSessions(useConnection.getState().gateway, descriptors, signal),
    enabled: connected && (descriptors?.length ?? 0) > 0,
  })

  const legacyQuery = useQuery({
    queryKey: ['harness-sessions', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.harnessSessions(signal),
    enabled: connected,
  })

  const invalidateSessions = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['harness-sessions', baseUrl] })
    void queryClient.invalidateQueries({ queryKey: ['harness-plane-sessions', baseUrl] })
  }, [queryClient, baseUrl])

  const hasDrivers = (descriptors?.length ?? 0) > 0
  useEffect(() => {
    if (!connected || !hasDrivers) return
    let opens = 0
    const sub = useConnection.getState().gateway.watchHarnesses(
      (event) => {
        if (event.type !== 'session-created' && event.type !== 'session-updated') return
        queryClient.setQueryData<HarnessSessionSummary[]>(planeQueryKey, (prev) =>
          applyRegistryEventToPlaneSessions(prev, event),
        )
        invalidateSessions()
      },
      undefined,
      {
        onStatus: (status) => {
          if (status !== 'open') return
          opens += 1
          // Registry stream has no replay — refetch on every reopen.
          if (opens > 1) {
            invalidateSessions()
            setListResyncedAt(Date.now())
          }
        },
      },
    )
    return () => sub.close()
  }, [
    connected,
    hasDrivers,
    baseUrl,
    transportEpoch,
    queryClient,
    descriptors?.length,
    invalidateSessions,
  ])

  const items = useMemo(
    () =>
      chatItems({
        drafts: [],
        harnessSessions: planeQuery.data ?? [],
        legacySessions: legacyQuery.data?.sessions ?? [],
      }),
    [planeQuery.data, legacyQuery.data?.sessions],
  )

  const rows = useMemo(
    () => sessionListRows(items, planeQuery.data ?? []),
    [items, planeQuery.data],
  )

  const filtered = useMemo(
    () =>
      filterSessionList(rows, {
        harnessId: harnessFilter,
        status: statusFilter,
        text: textFilter,
      }),
    [rows, harnessFilter, statusFilter, textFilter],
  )

  const harnessOptions = useMemo(() => {
    const ids = harnessFilterOptions(rows)
    return [{ value: '', label: 'all harnesses' }, ...ids.map((id) => ({ value: id, label: id }))]
  }, [rows])

  if (!connected) return <NotConnected />

  const openRow = (row: SessionListRow): void => {
    void navigate({ to: '/sessions/$sessionId', params: { sessionId: sessionPathParam(row) } })
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-semibold text-em">Sessions</h1>
          {listResyncedAt !== undefined && (
            <p className="mt-0.5 font-mono text-[11px] text-ink-dim">
              list resynced {formatClock(listResyncedAt)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={harnessFilter}
            title="harness filter"
            label="Harness"
            onChange={setHarnessFilter}
            options={harnessOptions}
          />
          <Select
            value={statusFilter}
            title="status filter"
            label="Status"
            onChange={(v) => setStatusFilter(v as SessionStatusFilter)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'live', label: 'Live' },
              { value: 'ended', label: 'Ended' },
            ]}
          />
          <input
            type="search"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Filter title / cwd"
            aria-label="Filter title or cwd"
            className="min-w-[10rem] rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink placeholder:text-ink-dim"
          />
        </div>
      </div>

      {(planeQuery.isError || legacyQuery.isError) && (
        <div className="font-mono text-sm text-red">
          {planeQuery.error?.message ?? legacyQuery.error?.message ?? 'failed to load sessions'}
        </div>
      )}

      {narrow ? (
        <ul className="flex flex-col gap-2">
          {filtered.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => openRow(row)}
                className="flex w-full flex-col gap-1 rounded border border-line bg-panel px-4 py-3 text-left hover:border-em"
              >
                <span className="truncate text-sm text-ink">
                  {row.title || shortNativeId(row.key)}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <HarnessBadge harnessId={row.harnessId} command={row.command} />
                  <StatusPill status={row.status} blocked={row.blocked} />
                </span>
                <span className="font-mono text-[11px] text-ink-dim">
                  {relativeUpdated(row.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <thead className="border-b border-line bg-panel-2/60 font-mono text-[11px] text-ink-dim">
              <tr>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Harness</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium">cwd</th>
                <th className="px-3 py-2 font-medium">Id</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.key}
                  className="cursor-pointer border-b border-line/60 hover:bg-panel-2/40"
                  onClick={() => openRow(row)}
                >
                  <td className="max-w-[14rem] truncate px-3 py-2 text-ink">
                    {row.title || shortNativeId(row.key)}
                  </td>
                  <td className="px-3 py-2">
                    <HarnessBadge harnessId={row.harnessId} command={row.command} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={row.status} blocked={row.blocked} />
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-dim">
                    {relativeUpdated(row.updatedAt)}
                  </td>
                  <td className="max-w-[8rem] truncate px-3 py-2 font-mono text-[11px] text-ink-dim">
                    {cwdBasename(row.cwd) ?? '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-dim">
                    {shortNativeId(row.sessionId ?? row.key)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length === 0 && (
        <p className="text-sm text-ink-dim">
          no sessions
          {harnessFilter || statusFilter !== 'all' || textFilter.trim()
            ? ' match these filters'
            : ''}
        </p>
      )}
    </div>
  )
}

/** Router param for the detail route — encoded canonical, or raw bare key. */
function sessionPathParam(row: SessionListRow): string {
  return sessionRouteParam(row.sessionId ?? row.key)
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type StripState =
  | { kind: 'connecting' }
  | { kind: 'live'; turnCount: number }
  | { kind: 'disconnected' }
  | { kind: 'reconnected'; turnCount: number; at: number }
  | { kind: 'fatal'; message: string }

export function SessionDetailPage(): JSX.Element {
  const { sessionId: routeSegment } = useParams({ from: '/sessions/$sessionId' })
  const navigate = useNavigate()
  const connected = useGatewayReady()
  const baseUrl = useConnection((s) => s.baseUrl)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const narrow = useIsNarrow()

  const resolved = useMemo(() => resolveSessionRouteParam(routeSegment), [routeSegment])
  const lookupId = sessionLookupId(resolved)

  const [metaOpen, setMetaOpen] = useState(!narrow)
  const [syncOpen, setSyncOpen] = useState(!narrow)
  const [strip, setStrip] = useState<StripState>({ kind: 'connecting' })
  const [syncLog, dispatchSync] = useReducer(syncLogReducer, undefined, createSyncLog)
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [live, setLive] = useState<LiveTurn | undefined>()
  const [agentStatus, setAgentStatus] = useState<HarnessStatusFrame | undefined>()
  const [ctxStamp, setCtxStamp] = useState<SessionContextStamp | undefined>()
  const [copiedLink, setCopiedLink] = useState(false)

  const openCountRef = useRef(0)
  const pendingCauseRef = useRef<SyncCause>('attach')
  const resyncStartedRef = useRef(0)
  const manualPendingRef = useRef(false)
  const attachmentRef = useRef<ReturnType<typeof attachHarnessSession> | undefined>(undefined)
  const transcriptRef = useRef<SessionTranscript>(emptyTranscript())
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const summaryQuery = useQuery({
    queryKey: ['harness-session', baseUrl, lookupId],
    queryFn: ({ signal }) => useConnection.getState().gateway.getHarnessSession(lookupId, signal),
    enabled: connected && Boolean(lookupId),
    retry: false,
  })

  // redirectedTo → replace navigation to the canonical encoded URL
  useEffect(() => {
    const redirected = summaryQuery.data?.redirectedTo
    if (!redirected) return
    const next = sessionRouteParam(redirected)
    if (next === routeSegment) return
    void navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: next },
      replace: true,
    })
  }, [summaryQuery.data?.redirectedTo, routeSegment, navigate])

  const canonicalId =
    summaryQuery.data?.sessionId ?? (resolved.kind === 'canonical' ? resolved.sessionId : undefined)
  const chatKey = canonicalId ?? lookupId
  const attachId = canonicalId ?? lookupId

  // Live attach — hard-resync on every open; clean up on unmount / id change.
  useEffect(() => {
    if (!connected || !attachId) return
    openCountRef.current = 0
    manualPendingRef.current = false
    pendingCauseRef.current = 'attach'
    dispatchSync({ type: 'clear' })
    transcriptRef.current = emptyTranscript()
    setMessages([])
    setLive(undefined)
    setAgentStatus(undefined)
    setCtxStamp(undefined)
    setStrip({ kind: 'connecting' })

    const attachment = attachHarnessSession({
      gateway: useConnection.getState().gateway,
      sessionId: attachId,
      onStatus: (status) => {
        if (status === 'connecting') {
          setStrip({ kind: 'connecting' })
          return
        }
        if (status === 'closed') {
          setLive(undefined)
          setStrip({ kind: 'disconnected' })
          return
        }
        // open
        openCountRef.current += 1
        pendingCauseRef.current = openCountRef.current === 1 ? 'attach' : 'reconnect'
        resyncStartedRef.current = Date.now()
      },
      onResync: (turns: HarnessTranscriptTurn[], ctx?: SessionContextStamp) => {
        const durationMs = Date.now() - (resyncStartedRef.current || Date.now())
        const cause: SyncCause = manualPendingRef.current ? 'manual' : pendingCauseRef.current
        manualPendingRef.current = false
        const turnCount = turns.length
        dispatchSync({ type: 'record', cause, turnCount, durationMs })
        transcriptRef.current = resyncTranscript(turns)
        setMessages((prev) => messagesFromHarnessTurns(attachId, turns, prev))
        setCtxStamp(ctx)
        setLive(undefined)
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
        if (cause === 'reconnect' || cause === 'manual') {
          const at = Date.now()
          setStrip({ kind: 'reconnected', turnCount, at })
          fadeTimerRef.current = setTimeout(() => {
            setStrip({ kind: 'live', turnCount })
          }, 4000)
        } else {
          setStrip({ kind: 'live', turnCount })
        }
      },
      onTranscript: (event) => {
        const next = applyTranscriptEvent(transcriptRef.current, event)
        if (!next) {
          // Rev gap / splice mismatch — `false` asks the socket for a from:0
          // snapshot. Only here: in-order deltas splice locally.
          dispatchSync({
            type: 'record',
            cause: 'rev-gap sync',
            turnCount: event.total,
            durationMs: 0,
          })
          return false
        }
        transcriptRef.current = next
        setMessages((prev) => messagesFromHarnessTurns(attachId, next.turns, prev))
        if (event.from === 0 && event.contextWindow !== undefined) {
          setCtxStamp({
            contextWindow: event.contextWindow,
            compactAt: event.compactAt,
            contextSource: event.contextSource,
          })
        }
        return true
      },
      onLive: (turn) => setLive(turn),
      onAgentStatus: (frame) => setAgentStatus(frame),
      onFatal: (message) => {
        setStrip({ kind: 'fatal', message })
        setLive(undefined)
      },
    })
    attachmentRef.current = attachment
    return () => {
      attachment.close()
      attachmentRef.current = undefined
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [connected, attachId, baseUrl, transportEpoch])

  const transcriptTexts = useMemo(() => messages.map((m) => m.text), [messages])

  const onResyncNow = (): void => {
    manualPendingRef.current = true
    resyncStartedRef.current = Date.now()
    pendingCauseRef.current = 'manual'
    attachmentRef.current?.resync()
  }

  const onCopyLink = (): void => {
    const url = `${window.location.origin}${sessionDetailPath(chatKey)}`
    void copyTextToClipboard(url).then(() => {
      setCopiedLink(true)
      window.setTimeout(() => setCopiedLink(false), 1200)
    })
  }

  if (!connected) return <NotConnected />

  if (summaryQuery.isError && strip.kind !== 'fatal') {
    const msg =
      summaryQuery.error instanceof Error ? summaryQuery.error.message : 'session not found'
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-8 md:px-6">
        <p className="font-mono text-sm text-red">{msg}</p>
        <Link to="/sessions" className="text-sm text-em hover:underline">
          ← Sessions
        </Link>
      </div>
    )
  }

  const summary = summaryQuery.data
  const title = summary?.title || shortNativeId(chatKey)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConnectionStrip strip={strip} />

      <div
        className={cn(
          'border-b border-line bg-panel/80 px-4 py-3 md:px-6',
          narrow ? 'flex flex-col gap-2' : 'grid grid-cols-[1fr_minmax(14rem,18rem)] gap-4',
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/sessions" className="font-mono text-[11px] text-ink-dim hover:text-em">
              Sessions
            </Link>
            <span className="text-ink-dim">/</span>
            <h1 className="min-w-0 truncate font-mono text-base font-semibold text-em">{title}</h1>
            <StatusPill status={summary?.status} blocked={summary?.blocked} />
          </div>

          {narrow ? (
            <button
              type="button"
              className="mt-2 flex items-center gap-1 font-mono text-[11px] text-ink-dim"
              aria-expanded={metaOpen}
              onClick={() => setMetaOpen((v) => !v)}
            >
              <ChevronDown className={cn('size-3 transition', metaOpen && 'rotate-180')} />
              details
            </button>
          ) : null}

          {(!narrow || metaOpen) && (
            <div className="mt-2 flex flex-col gap-1.5 text-[12px] text-ink-dim">
              <div className="flex flex-wrap items-center gap-2">
                <HarnessBadge harnessId={summary?.harnessId} />
                {summary?.sessionId && (
                  <CopyableId value={summary.sessionId} label="Copy SessionId" />
                )}
              </div>
              {summary?.cwd && (
                <div className="font-mono text-[11px]" title={summary.cwd}>
                  cwd {summary.cwd}
                </div>
              )}
              <div className="font-mono text-[11px]">
                created {summary?.createdAt ? new Date(summary.createdAt).toLocaleString() : '—'}
                {' · '}
                updated {summary?.updatedAt ? new Date(summary.updatedAt).toLocaleString() : '—'}
              </div>
              <ContextBar
                model={summary?.model}
                transcriptTexts={transcriptTexts}
                contextWindow={ctxStamp?.contextWindow}
                compactAt={ctxStamp?.compactAt}
              />
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              to="/"
              search={{ session: chatKey }}
              className="inline-flex items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-ink hover:border-em"
            >
              <ExternalLink className="size-3" />
              Open in Chat
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onResyncNow}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className="size-3" />
              Resync now
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCopyLink}
              className="gap-1.5 text-xs"
            >
              {copiedLink ? <Check className="size-3 text-em" /> : <Copy className="size-3" />}
              Copy link
            </Button>
          </div>
        </div>

        <SyncLogPanel
          open={syncOpen}
          onToggle={() => setSyncOpen((v) => !v)}
          entries={syncLog.entries}
          narrow={narrow}
        />
      </div>

      <div className="min-h-0 flex-1">
        {strip.kind === 'fatal' ? (
          <div className="flex flex-col gap-2 px-6 py-8">
            <p className="font-mono text-sm text-red">{strip.message}</p>
            <Link to="/sessions" className="text-sm text-em hover:underline">
              ← Back to Sessions
            </Link>
          </div>
        ) : (
          <Transcript
            messages={messages}
            live={live}
            accent={accentFor({ harnessId: summary?.harnessId })}
            statusLine={
              !live && agentStatus?.status === 'working'
                ? {
                    text: agentStatus.tool?.name
                      ? `working · ${agentStatus.tool.name}`
                      : 'working…',
                  }
                : !live && agentStatus?.status === 'blocked'
                  ? { text: 'waiting for you' }
                  : undefined
            }
          />
        )}
      </div>
    </div>
  )
}

function ConnectionStrip(props: { strip: StripState }): JSX.Element {
  const { strip } = props
  let text: string
  let tone: string
  switch (strip.kind) {
    case 'connecting':
      text = 'Connecting…'
      tone = 'border-line bg-panel-2 text-ink-dim'
      break
    case 'live':
      text = `Live · transcript loaded from node (${String(strip.turnCount)} turns)`
      tone = 'border-em/30 bg-em/10 text-em'
      break
    case 'disconnected':
      text = 'Disconnected. Live state cleared, reconnecting…'
      tone = 'border-warn/40 bg-warn/10 text-warn'
      break
    case 'reconnected':
      text = `Reconnected · transcript restored over HTTP (${String(strip.turnCount)} turns, ${formatClock(strip.at)})`
      tone = 'border-em/40 bg-em/15 text-em'
      break
    case 'fatal':
      text = strip.message
      tone = 'border-red/40 bg-red/10 text-red'
      break
  }
  return (
    <div
      className={cn('sticky top-0 z-10 border-b px-4 py-1.5 font-mono text-[11px] md:px-6', tone)}
      role="status"
    >
      {text}
    </div>
  )
}

function SyncLogPanel(props: {
  open: boolean
  onToggle: () => void
  entries: ReturnType<typeof createSyncLog>['entries']
  narrow: boolean
}): JSX.Element {
  return (
    <div className="min-w-0 rounded border border-line bg-panel-2/40">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 font-mono text-[11px] text-ink-dim"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span>Sync log ({String(props.entries.length)})</span>
        <ChevronDown className={cn('size-3 transition', props.open && 'rotate-180')} />
      </button>
      {props.open && (
        <ul className="max-h-48 overflow-y-auto border-t border-line px-3 py-2">
          {props.entries.length === 0 && (
            <li className="text-[11px] text-ink-dim">no sync events yet</li>
          )}
          {props.entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line/40 py-1 font-mono text-[10px] text-ink-dim last:border-0"
            >
              <span>
                {formatClock(e.at)} · {e.cause}
              </span>
              <span>
                {String(e.turnCount)} turns
                {e.durationMs > 0 ? ` · ${String(e.durationMs)}ms` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
