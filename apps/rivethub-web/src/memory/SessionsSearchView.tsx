/**
 * Memory home — sessions and search on one screen (experimental
 * `memoryHome`). Empty box: every session on the node, grouped by day.
 * Typing filters titles at once; after a pause datahub search runs and its
 * hits are grouped under their session, with matching wiki topics on top.
 */

import { useEffect, useMemo, useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronLeft, X } from 'lucide-react'
import type { MemorySearchHit } from '@rivetos/types'
import type { RivetGateway } from '@rivetos/gateway-client'
import { Select } from '../components/select.js'
import { TagChips } from '../components/tag-chips.js'
import { HarnessBadge, StatusPill, sessionPathParam } from '../pages/sessions.js'
import { shortNativeId } from '../lib/harness-chat.js'
import {
  cwdBasename,
  filterSessionList,
  harnessFilterOptions,
  type SessionListRow,
  type SessionStatusFilter,
} from '../lib/session-list.js'
import {
  acceptedTagOptions,
  filterRowsByTag,
  sessionKeysOf,
  sortTagsForChips,
  tagIdentity,
  tagsForRow,
  type AnyTag,
} from '../lib/session-tags.js'
import { useSessionRows } from '../lib/use-session-rows.js'
import { useSessionTagsLookup, useTagEndpoint, useTagMutations } from '../lib/use-session-tags.js'
import { preview, relativeTime } from './format.js'
import {
  excerpt,
  groupRowsByDay,
  highlightParts,
  isToolStub,
  joinKey,
  sessionResults,
  type SessionResult,
} from './memory-home.js'

const SEARCH_DELAY_MS = 350
const EXCERPTS_SHOWN = 2

function Highlighted(props: { text: string; query: string }): JSX.Element {
  return (
    <>
      {highlightParts(props.text, props.query).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-em/20 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

function hitLabel(h: MemorySearchHit): string {
  return h.source === 'summary' ? (h.kind ?? 'summary') : (h.role ?? 'message')
}

function SessionCard(props: {
  result: SessionResult
  query: string
  expanded: boolean
  onToggle: () => void
  onOpen: (() => void) | undefined
  tags: readonly AnyTag[]
  onTagClick: (tag: AnyTag) => void
  onAccept: (id: string) => void
  onReject: (id: string) => void
  tagsBusy: boolean
}): JSX.Element {
  const { row, hits } = props.result
  const first = hits[0] as MemorySearchHit | undefined
  const title = row?.title || shortNativeId(row?.key ?? first?.sessionId ?? '') || 'Session'
  const when = row
    ? relativeTime(new Date(row.updatedAt).toISOString())
    : relativeTime(first?.createdAt)
  const useful = hits.filter((h) => !isToolStub(h))
  const shown = props.expanded ? useful : useful.slice(0, EXCERPTS_SHOWN)
  const extra = useful.length - EXCERPTS_SHOWN
  return (
    <li className="hit">
      <button
        type="button"
        className="hit-btn flex w-full flex-col gap-1.5 text-left"
        disabled={!props.onOpen}
        onClick={props.onOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-ink">
            <Highlighted text={title} query={props.query} />
          </span>
          <span className="ml-auto shrink-0 text-xs text-ink-dim classic:text-[11px]">{when}</span>
        </span>
        {row && (
          <span className="flex flex-wrap items-center gap-2">
            <HarnessBadge harnessId={row.harnessId} command={row.command} />
            <StatusPill status={row.status} blocked={row.blocked} />
            {row.cwd && (
              <span className="font-mono text-xs text-ink-dim classic:text-[11px]" title={row.cwd}>
                {cwdBasename(row.cwd)}
              </span>
            )}
          </span>
        )}
        {shown.map((h) => (
          <span key={`${h.source}-${h.id}`} className="flex gap-2 rounded bg-panel px-2 py-1.5">
            <span className="shrink-0 font-mono text-[11px] text-ink-dim">{hitLabel(h)}</span>
            <span className="hit-body min-w-0">
              <Highlighted text={excerpt(h.content, props.query)} query={props.query} />
            </span>
          </span>
        ))}
      </button>
      {props.tags.length > 0 && (
        <div className="mt-1.5">
          <TagChips
            tags={props.tags}
            max={4}
            onClick={props.onTagClick}
            onAccept={props.onAccept}
            onReject={props.onReject}
            busy={props.tagsBusy}
          />
        </div>
      )}
      {extra > 0 && (
        <button type="button" className="mt-1 text-xs text-em" onClick={props.onToggle}>
          {props.expanded ? 'Show fewer' : `+${String(extra)} more in this session`}
        </button>
      )}
    </li>
  )
}

export function SessionsSearchView(props: {
  gateway: RivetGateway
  baseUrl: string
  onOpenSession: (sessionId: string) => void
}): JSX.Element {
  const navigate = useNavigate()
  const { connected, rows, loadError } = useSessionRows()
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [harnessFilter, setHarnessFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all')
  const [tagFilter, setTagFilter] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), SEARCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [input])

  const search = useQuery({
    queryKey: ['memory-home-search', props.baseUrl, query, tagFilter],
    enabled: query !== '',
    queryFn: ({ signal }) =>
      props.gateway.memorySearch(
        { q: query, scope: 'both', limit: 50, ...(tagFilter ? { tag: tagFilter } : {}) },
        signal,
      ),
  })
  const topics = useQuery({
    queryKey: ['memory-home-topics', props.baseUrl, query],
    enabled: query !== '',
    queryFn: ({ signal }) => props.gateway.wikiIndex({ q: query, limit: 3 }, signal),
  })

  // Tags live on datahub, not the node: look them up for every listed row.
  const tagEndpoint = useTagEndpoint()
  const sessionKeys = useMemo(() => sessionKeysOf(rows), [rows])
  const { map: tagMap } = useSessionTagsLookup(tagEndpoint, sessionKeys)
  const tagMutations = useTagMutations(tagEndpoint)
  const tagOptions = useMemo(() => acceptedTagOptions(tagMap), [tagMap])

  // Harness and status are known only for node rows; search hits outside the
  // node are dropped when either is set. The tag filter also goes to search.
  const narrowed = harnessFilter !== '' || statusFilter !== 'all'
  const filtersOn = narrowed || tagFilter !== ''
  const base = useMemo(
    () => filterSessionList(rows, { harnessId: harnessFilter, status: statusFilter, text: '' }),
    [rows, harnessFilter, statusFilter],
  )
  const filtered = useMemo(
    () => filterRowsByTag(base, tagMap, tagFilter),
    [base, tagMap, tagFilter],
  )
  const titleMatches = useMemo(
    () =>
      input.trim()
        ? filterRowsByTag(
            filterSessionList(rows, {
              harnessId: harnessFilter,
              status: statusFilter,
              text: input,
            }),
            tagMap,
            tagFilter,
          )
        : [],
    [rows, harnessFilter, statusFilter, input, tagMap, tagFilter],
  )
  const results = useMemo(
    () =>
      sessionResults(
        query === input.trim() ? (search.data?.results ?? []) : [],
        base,
        titleMatches,
        {
          onlyKnownRows: narrowed,
        },
      ),
    [search.data, base, titleMatches, narrowed, query, input],
  )
  const groups = useMemo(() => groupRowsByDay(filtered), [filtered])
  const harnessOptions = useMemo(
    () => [
      { value: '', label: 'all harnesses' },
      ...harnessFilterOptions(rows).map((id) => ({ value: id, label: id })),
    ],
    [rows],
  )

  function showAll(): void {
    setInput('')
    setQuery('')
    setHarnessFilter('')
    setStatusFilter('all')
    setTagFilter('')
    setExpanded(new Set())
  }
  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function openerFor(r: SessionResult): (() => void) | undefined {
    if (r.row) {
      const row: SessionListRow = r.row
      return () =>
        void navigate({ to: '/sessions/$sessionId', params: { sessionId: sessionPathParam(row) } })
    }
    const sessionId = r.hits[0]?.sessionId
    return sessionId ? () => props.onOpenSession(sessionId) : undefined
  }

  function cardTagProps(r: SessionResult): {
    tags: AnyTag[]
    onTagClick: (t: AnyTag) => void
    onAccept: (id: string) => void
    onReject: (id: string) => void
    tagsBusy: boolean
  } {
    return {
      tags: r.row ? sortTagsForChips(tagsForRow(tagMap, r.row)) : [],
      onTagClick: (t) => setTagFilter(tagIdentity(t)),
      onAccept: (id) => void tagMutations.decide([id], 'accepted'),
      onReject: (id) => void tagMutations.decide([id], 'rejected'),
      tagsBusy: tagMutations.busy,
    }
  }

  const typing = input.trim() !== ''
  const searching = typing && (query !== input.trim() || search.isFetching)

  return (
    <div className="pane flex flex-col gap-3">
      <div className="searchbar" role="search">
        <input
          type="search"
          value={input}
          autoFocus
          placeholder="Search sessions and everything said in them"
          aria-label="Search sessions and memory"
          onChange={(e) => setInput(e.target.value)}
        />
        {typing && (
          <button
            type="button"
            className="ghost small inline-flex items-center"
            aria-label="Clear search"
            onClick={() => setInput('')}
          >
            <X className="size-3.5" />
          </button>
        )}
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
        {tagOptions.length > 1 && (
          <Select
            value={tagFilter}
            title="tag filter"
            label="Tag"
            onChange={setTagFilter}
            options={tagOptions}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-ink-dim" role="status">
        {typing ? (
          <span>
            {searching
              ? 'Matching titles now. Searching what was said…'
              : `${String(results.length)} ${results.length === 1 ? 'session matches' : 'sessions match'} “${input.trim()}”`}
          </span>
        ) : (
          <span>
            {filtersOn
              ? `Showing ${String(filtered.length)} of ${String(rows.length)} sessions`
              : `All sessions · ${String(rows.length)}`}
          </span>
        )}
        {(typing || filtersOn) && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-em"
            onClick={showAll}
          >
            <ChevronLeft className="size-3.5" />
            All sessions
          </button>
        )}
      </div>

      {!connected && (
        <div className="muted small">Connect a node to list its sessions. Search still works.</div>
      )}
      {loadError && <div className="banner bad">{loadError}</div>}
      {search.error && <div className="banner bad">{search.error.message}</div>}
      {typing && search.data?.degraded && (
        <div className="muted small">
          Meaning search is offline, so only exact words match right now.
        </div>
      )}

      {typing && (topics.data?.topics.length ?? 0) > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-ink-dim">Wiki topics</h2>
          <ul className="hits">
            {topics.data?.topics.map((t) => (
              <li key={t.slug} className="hit hit-click">
                <Link to="/memory/$slug" params={{ slug: t.slug }} className="flex gap-3">
                  <span className="shrink-0 text-sm text-ink">
                    <Highlighted text={t.title} query={query} />
                  </span>
                  <span className="hit-body min-w-0 truncate">{preview(t.excerpt, 160)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {typing ? (
        results.length > 0 ? (
          <ul className="hits">
            {results.map((r) => (
              <SessionCard
                key={r.key}
                result={r}
                query={input.trim()}
                expanded={expanded.has(r.key)}
                onToggle={() => toggle(r.key)}
                onOpen={openerFor(r)}
                {...cardTagProps(r)}
              />
            ))}
          </ul>
        ) : (
          !searching && (
            <div className="empty">
              <strong>Nothing found for “{input.trim()}”</strong>
              {filtersOn
                ? 'Try removing a filter, or use fewer words.'
                : 'Try fewer words, or a different word for the same thing.'}
            </div>
          )
        )
      ) : groups.length > 0 ? (
        groups.map((g) => (
          <section key={g.bucket} className="flex flex-col gap-2">
            <h2 className="text-xs uppercase tracking-wide text-ink-dim">
              {g.bucket} <span className="font-mono normal-case">{g.rows.length}</span>
            </h2>
            <ul className="hits">
              {g.rows.map((row) => {
                const r: SessionResult = { key: joinKey(row.sessionId ?? row.key), row, hits: [] }
                return (
                  <SessionCard
                    key={r.key}
                    result={r}
                    query=""
                    expanded={false}
                    onToggle={() => undefined}
                    onOpen={openerFor(r)}
                    {...cardTagProps(r)}
                  />
                )
              })}
            </ul>
          </section>
        ))
      ) : (
        connected && (
          <div className="empty">
            <strong>{filtersOn ? 'No sessions match these filters' : 'No sessions yet'}</strong>
            {filtersOn ? 'Remove a filter to see more.' : 'Sessions on this node show up here.'}
          </div>
        )
      )}
    </div>
  )
}
