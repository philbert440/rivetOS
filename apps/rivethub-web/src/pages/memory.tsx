/**
 * Memory — Wikipedia-style native Hub UI over datahub `/api/wiki`.
 *
 * Layout mirrors the server /wiki shell: sticky wiki nav, lead + panels on
 * the main page, article with infobox / TOC / sections / categories / related
 * crosslinks. Content is memory summaries; the UI makes them feel encyclopedic.
 */

import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { GatewayError } from '@rivetos/gateway-client'
import type { WikiIndexEntry, WikiPageResponse } from '@rivetos/types'
import { NotConnected } from '../components/not-connected.js'
import { MemoryHubNav } from '../memory/MemoryHubNav.js'
import { WikiMarkdown } from '../components/wiki-markdown.js'
import { SegmentedControl } from '../components/segmented-control.js'
import { useWikiEndpoint } from '../lib/wiki-client.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { cn } from '../lib/utils.js'
import { stalenessLabel, tocFromMarkdown } from '../lib/wiki-base.js'

type HubView = 'main' | 'all' | 'recent' | 'gaps'

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = Date.parse(iso)
  if (!Number.isFinite(d)) return iso.slice(0, 10)
  return new Date(d).toLocaleDateString()
}

function Badge(props: { lastVerified?: string }): JSX.Element {
  const s = stalenessLabel(props.lastVerified)
  const color =
    s.kind === 'fresh'
      ? 'border-em text-em'
      : s.kind === 'aging'
        ? 'border-warn/80 text-warn'
        : 'border-red text-red'
  return (
    <span className={cn('rounded-full border bg-bg px-2 py-0.5 font-mono text-[10px]', color)}>
      {s.label}
    </span>
  )
}

function WikiNotConfigured(props: { needNode: boolean }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-sm font-semibold text-em">Memory wiki</div>
      <p className="max-w-md text-sm text-ink-dim">
        {props.needNode
          ? 'Connect a node first so we can discover datahub on the mesh — or set the datahub gateway URL in Settings.'
          : 'Point RivetHub at datahub (the mesh memory wiki host). The wiki is readable memory summaries, not the chat node.'}
      </p>
      <Link
        to="/settings"
        className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em"
      >
        Open Settings
      </Link>
    </div>
  )
}

function WikiShell(props: {
  endpointLabel: string
  children: ReactNode
  hubView?: HubView
  onHubView?: (v: HubView) => void
  search: string
  onSearch: (q: string) => void
  onSearchSubmit: () => void
  total?: number
}): JSX.Element {
  const items: { id: HubView; label: string }[] = [
    { id: 'main', label: 'Main page' },
    {
      id: 'all',
      label: props.total !== undefined ? `All topics (${String(props.total)})` : 'All topics',
    },
    { id: 'recent', label: 'Recent changes' },
    { id: 'gaps', label: 'Gaps' },
  ]

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel/90 px-3 py-4">
        <Link
          to="/memory"
          onClick={() => props.onHubView?.('main')}
          className="mb-3 text-base font-bold text-ink hover:text-em"
        >
          <span className="text-em">🔩</span> Memory wiki
        </Link>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            props.onSearchSubmit()
          }}
        >
          <input
            type="search"
            value={props.search}
            onChange={(e) => props.onSearch(e.target.value)}
            placeholder="Search memory…"
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-em"
          />
        </form>
        <nav className="mt-4 flex flex-col gap-0.5">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            Navigate
          </div>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => props.onHubView?.(it.id)}
              className={cn(
                'rounded px-2 py-1.5 text-left text-sm',
                props.hubView === it.id
                  ? 'bg-panel-2 text-em'
                  : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
              )}
            >
              {it.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto border-t border-line pt-3 font-mono text-[10px] leading-relaxed text-ink-dim">
          datahub · {props.endpointLabel}
          <br />
          distilled from conversation history
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">{props.children}</div>
    </div>
  )
}

/** Route: /memory — main / all / recent / gaps + search */
export function MemoryPage(): JSX.Element {
  const { endpoint, pending, needNode } = useWikiEndpoint()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [hubView, setHubView] = useState<HubView>('main')
  const navigate = useNavigate()

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])

  const searching = debounced.length > 0

  const index = useQuery({
    queryKey: ['wiki-index', endpoint?.baseUrl, searching ? debounced : hubView],
    enabled: !!endpoint,
    queryFn: ({ signal }) => {
      if (searching) return endpoint!.gateway.wikiIndex({ q: debounced, limit: 50 }, signal)
      return endpoint!.gateway.wikiIndex({ limit: hubView === 'all' ? 500 : 80 }, signal)
    },
  })

  const gaps = useQuery({
    queryKey: ['wiki-gaps', endpoint?.baseUrl],
    enabled: !!endpoint && (hubView === 'main' || hubView === 'gaps') && !searching,
    queryFn: ({ signal }) => endpoint!.gateway.wikiGaps(40, signal),
  })

  if (needNode) return <NotConnected />
  if (pending) {
    return <div className="p-8 font-mono text-sm text-ink-dim">resolving datahub…</div>
  }
  if (!endpoint) return <WikiNotConfigured needNode={false} />

  const topics = index.data?.topics ?? []
  const total = index.data?.total ?? topics.length

  return (
    <WikiShell
      endpointLabel={endpoint.baseUrl.replace(/^https?:\/\//, '')}
      hubView={hubView}
      onHubView={(v) => {
        setHubView(v)
        setQ('')
        setDebounced('')
      }}
      search={q}
      onSearch={setQ}
      onSearchSubmit={() => setDebounced(q.trim())}
      total={total}
    >
      <div className="mx-auto max-w-4xl px-4 py-8 md:px-6 lg:px-10">
        {index.isError && (
          <div className="mb-4 font-mono text-sm text-red">{index.error.message}</div>
        )}

        {searching ? (
          <>
            <h1 className="mb-1 border-b border-line pb-2 text-2xl font-semibold">
              Results for “{debounced}”
            </h1>
            <p className="mb-6 text-sm text-ink-dim">From RivetOS memory</p>
            <TopicList
              topics={topics}
              empty="Nothing matched — try Gaps, or a broader term."
              onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
            />
          </>
        ) : hubView === 'all' ? (
          <AllTopics
            topics={topics}
            onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
          />
        ) : hubView === 'recent' ? (
          <RecentTopics
            topics={topics}
            onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
          />
        ) : hubView === 'gaps' ? (
          <GapsView
            gaps={gaps.data}
            loading={gaps.isLoading}
            onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
          />
        ) : (
          <MainPage
            total={total}
            topics={topics}
            gaps={gaps.data}
            onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
            onView={setHubView}
          />
        )}
      </div>
    </WikiShell>
  )
}

function MainPage(props: {
  total: number
  topics: WikiIndexEntry[]
  gaps?: { redLinks: { entity: string; referencedBy: string[] }[]; stalest: WikiIndexEntry[] }
  onOpen: (slug: string) => void
  onView: (v: HubView) => void
}): JSX.Element {
  const newest = useMemo(
    () => [...props.topics].sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1)).slice(0, 10),
    [props.topics],
  )

  return (
    <>
      <h1 className="mb-1 border-b border-line pb-2 text-2xl font-semibold tracking-tight">
        Main page
      </h1>
      <p className="mb-2 text-sm text-ink-dim">
        From RivetOS memory — the distilled record of what is currently true.
      </p>
      <p className="mb-8 text-[15px] leading-relaxed text-ink">
        The living encyclopedia of RivetOS memory —{' '}
        <strong className="text-em">{props.total}</strong> topic
        {props.total === 1 ? '' : 's'} distilled from conversation history, updated as new summaries
        land. Broad topics hold the current picture; sections and{' '}
        <span className="text-em">[[wiki links]]</span> connect the mesh of what we know.
      </p>

      {props.gaps && (props.gaps.redLinks.length > 0 || props.gaps.stalest.length > 0) && (
        <section className="mb-8 rounded-lg border border-red/40 bg-panel p-4">
          <h2 className="mb-2 text-lg font-semibold text-ink">Gaps — worth a conversation</h2>
          {props.gaps.redLinks.length > 0 && (
            <ul className="mb-3 space-y-1 text-sm">
              {props.gaps.redLinks.slice(0, 8).map((r) => (
                <li key={r.entity}>
                  <span className="text-red">{r.entity}</span>
                  <span className="text-ink-dim">
                    {' '}
                    · mentioned by{' '}
                    {r.referencedBy.slice(0, 3).map((s, i) => (
                      <span key={s}>
                        {i > 0 ? ', ' : ''}
                        <button
                          type="button"
                          className="text-em hover:underline"
                          onClick={() => props.onOpen(s)}
                        >
                          {s}
                        </button>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {props.gaps.stalest.length > 0 && (
            <p className="text-sm text-ink-dim">
              Longest unverified:{' '}
              {props.gaps.stalest.slice(0, 5).map((t, i) => (
                <span key={t.slug}>
                  {i > 0 ? ' · ' : ''}
                  <button
                    type="button"
                    className="text-em hover:underline"
                    onClick={() => props.onOpen(t.slug)}
                  >
                    {t.title}
                  </button>
                </span>
              ))}
            </p>
          )}
          <button
            type="button"
            className="mt-2 text-sm text-em hover:underline"
            onClick={() => props.onView('gaps')}
          >
            all gaps →
          </button>
        </section>
      )}

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="mb-3 text-lg font-semibold">Recently updated</h2>
        <TopicList
          topics={newest}
          empty="No topics yet — backfill still writing."
          onOpen={props.onOpen}
        />
        <div className="mt-3 flex flex-wrap gap-3 text-sm text-ink-dim">
          <button
            type="button"
            className="text-em hover:underline"
            onClick={() => props.onView('all')}
          >
            all topics
          </button>
          <button
            type="button"
            className="text-em hover:underline"
            onClick={() => props.onView('recent')}
          >
            recent changes
          </button>
          <button
            type="button"
            className="text-em hover:underline"
            onClick={() => props.onView('gaps')}
          >
            gaps
          </button>
        </div>
      </section>
    </>
  )
}

function AllTopics(props: {
  topics: WikiIndexEntry[]
  onOpen: (slug: string) => void
}): JSX.Element {
  const groups = useMemo(() => {
    const sorted = [...props.topics].sort((a, b) => a.title.localeCompare(b.title))
    const map = new Map<string, WikiIndexEntry[]>()
    for (const t of sorted) {
      const letter = (t.title[0] || '#').toUpperCase()
      const list = map.get(letter) ?? []
      list.push(t)
      map.set(letter, list)
    }
    return [...map.entries()]
  }, [props.topics])

  return (
    <>
      <h1 className="mb-1 border-b border-line pb-2 text-2xl font-semibold">All topics</h1>
      <p className="mb-6 text-sm text-ink-dim">Alphabetical index of memory articles</p>
      {groups.map(([letter, ts]) => (
        <section key={letter} className="mb-6">
          <h2 className="mb-2 text-lg font-semibold text-em">{letter}</h2>
          <TopicList topics={ts} empty="" onOpen={props.onOpen} />
        </section>
      ))}
      {groups.length === 0 && <p className="text-sm text-ink-dim">No topics yet.</p>}
    </>
  )
}

function RecentTopics(props: {
  topics: WikiIndexEntry[]
  onOpen: (slug: string) => void
}): JSX.Element {
  const byDay = useMemo(() => {
    const sorted = [...props.topics].sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1))
    const map = new Map<string, WikiIndexEntry[]>()
    for (const t of sorted) {
      const day = fmtDate(t.updatedAt)
      const list = map.get(day) ?? []
      list.push(t)
      map.set(day, list)
    }
    return [...map.entries()]
  }, [props.topics])

  return (
    <>
      <h1 className="mb-1 border-b border-line pb-2 text-2xl font-semibold">Recent changes</h1>
      <p className="mb-6 text-sm text-ink-dim">Topics by last update</p>
      {byDay.map(([day, ts]) => (
        <section key={day} className="mb-6">
          <h2 className="mb-2 text-lg font-semibold text-em">{day}</h2>
          <TopicList topics={ts} empty="" onOpen={props.onOpen} />
        </section>
      ))}
    </>
  )
}

function GapsView(props: {
  gaps?: { redLinks: { entity: string; referencedBy: string[] }[]; stalest: WikiIndexEntry[] }
  loading: boolean
  onOpen: (slug: string) => void
}): JSX.Element {
  if (props.loading) return <p className="text-sm text-ink-dim">loading gaps…</p>
  const g = props.gaps
  return (
    <>
      <h1 className="mb-1 border-b border-line pb-2 text-2xl font-semibold">Gaps</h1>
      <p className="mb-6 text-sm text-ink-dim">Red links and longest-unverified articles</p>
      <h2 className="mb-2 text-lg font-semibold">Red links — mentioned, no article</h2>
      <ul className="mb-8 space-y-1 text-sm">
        {(g?.redLinks ?? []).map((r) => (
          <li key={r.entity}>
            <span className="text-red">{r.entity}</span>
            <span className="text-ink-dim">
              {' '}
              ←{' '}
              {r.referencedBy.map((s, i) => (
                <span key={s}>
                  {i > 0 ? ', ' : ''}
                  <button
                    type="button"
                    className="text-em hover:underline"
                    onClick={() => props.onOpen(s)}
                  >
                    {s}
                  </button>
                </span>
              ))}
            </span>
          </li>
        ))}
        {(g?.redLinks.length ?? 0) === 0 && <li className="text-ink-dim">(none)</li>}
      </ul>
      <h2 className="mb-2 text-lg font-semibold">Longest unverified</h2>
      <TopicList topics={g?.stalest ?? []} empty="(none)" onOpen={props.onOpen} />
    </>
  )
}

function TopicList(props: {
  topics: WikiIndexEntry[]
  empty: string
  onOpen: (slug: string) => void
}): JSX.Element {
  if (props.topics.length === 0) {
    return props.empty ? <p className="text-sm text-ink-dim">{props.empty}</p> : <></>
  }
  return (
    <ul className="space-y-3">
      {props.topics.map((t) => (
        <li key={t.slug}>
          <button
            type="button"
            onClick={() => props.onOpen(t.slug)}
            className="group w-full text-left"
          >
            <span className="text-[15px] text-em group-hover:underline">{t.title}</span>{' '}
            <Badge lastVerified={t.updatedAt} />
            <div className="mt-0.5 line-clamp-2 text-sm text-ink-dim">{t.excerpt || t.slug}</div>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Route: /memory/$slug — Wikipedia-style article */
export function MemoryTopicPage(): JSX.Element {
  const { slug } = useParams({ from: '/memory/$slug' })
  const { endpoint, pending, needNode } = useWikiEndpoint()
  const [view, setView] = useState<'article' | 'history' | 'raw'>('article')
  const [copied, setCopied] = useState(false)
  const [q, setQ] = useState('')
  const navigate = useNavigate()

  const page = useQuery({
    queryKey: ['wiki-page', endpoint?.baseUrl, slug],
    enabled: !!endpoint && !!slug,
    queryFn: ({ signal }) => endpoint!.gateway.wikiPage(slug, signal),
  })

  const indexLite = useQuery({
    queryKey: ['wiki-index-lite', endpoint?.baseUrl],
    enabled: !!endpoint,
    queryFn: ({ signal }) => endpoint!.gateway.wikiIndex({ limit: 500 }, signal),
    staleTime: 120_000,
  })

  const knownSlugs = useMemo(() => {
    const s = new Set((indexLite.data?.topics ?? []).map((t) => t.slug))
    if (slug) s.add(slug)
    for (const r of page.data?.related ?? []) s.add(r)
    return s
  }, [indexLite.data, slug, page.data?.related])

  if (needNode) return <NotConnected />
  if (pending) {
    return <div className="p-8 font-mono text-sm text-ink-dim">resolving datahub…</div>
  }
  if (!endpoint) return <WikiNotConfigured needNode={false} />

  const wrap = (inner: JSX.Element): JSX.Element => (
    <div className="flex h-full min-h-0 flex-col">
      <MemoryHubNav tab="wiki" gateway={endpoint.gateway} baseUrl={endpoint.baseUrl} />
      <div className="min-h-0 flex-1 overflow-hidden">{inner}</div>
    </div>
  )

  const shellProps = {
    endpointLabel: endpoint.baseUrl.replace(/^https?:\/\//, ''),
    search: q,
    onSearch: setQ,
    onSearchSubmit: () => {
      void navigate({ to: '/memory' })
    },
    total: indexLite.data?.total,
  }

  if (page.isError) {
    const err = page.error
    const notFound = err instanceof GatewayError && err.status === 404
    return wrap(
      <WikiShell {...shellProps}>
        <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
          <Link to="/memory" search={{ tab: 'wiki' }} className="text-sm text-em hover:underline">
            ← Main page
          </Link>
          <div className={`mt-4 text-sm ${notFound ? 'text-ink-dim' : 'text-red'}`}>
            {notFound ? (
              <>
                <h1 className="mb-2 text-2xl font-semibold text-ink">{slug}</h1>
                <p>
                  This page does not exist yet (red link). Teach the mesh — a future extraction pass
                  may open the article when the fact lands.
                </p>
              </>
            ) : (
              err.message
            )}
          </div>
        </div>
      </WikiShell>,
    )
  }

  if (!page.data) {
    return wrap(
      <WikiShell {...shellProps}>
        <div className="p-8 text-sm text-ink-dim">loading…</div>
      </WikiShell>,
    )
  }

  return wrap(
    <WikiShell {...shellProps}>
      <ArticleBody
        page={page.data}
        view={view}
        setView={setView}
        knownSlugs={knownSlugs}
        copied={copied}
        onCopy={() => {
          void copyTextToClipboard(page.data.markdown).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
      />
    </WikiShell>,
  )
}

function ArticleBody(props: {
  page: WikiPageResponse
  view: 'article' | 'history' | 'raw'
  setView: (v: 'article' | 'history' | 'raw') => void
  knownSlugs: Set<string>
  copied: boolean
  onCopy: () => void
}): JSX.Element {
  const p = props.page
  const bodyMd =
    props.view === 'article' ? (p.currentState.trim() ? p.currentState : p.markdown) : ''
  const toc = tocFromMarkdown(bodyMd)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-6 lg:px-10">
      <Link to="/memory" search={{ tab: 'wiki' }} className="text-sm text-ink-dim hover:text-em">
        ← Main page
      </Link>

      <h1 className="mt-3 border-b border-line pb-2 text-3xl font-semibold tracking-tight text-ink">
        {p.title}
      </h1>
      <p className="mt-1 text-sm text-ink-dim">
        From RivetOS memory — the distilled record of what is currently true.
      </p>

      <nav className="mt-4 flex flex-wrap items-center gap-4 border-b border-line pb-2 text-sm">
        <SegmentedControl
          ariaLabel="Topic view"
          value={props.view}
          onChange={props.setView}
          options={[
            { value: 'article', label: 'Article' },
            { value: 'history', label: 'History' },
            { value: 'raw', label: 'Raw' },
          ]}
        />
        <button
          type="button"
          onClick={props.onCopy}
          className="ml-auto font-mono text-[11px] text-ink-dim hover:text-em"
        >
          {props.copied ? 'copied' : 'copy md'}
        </button>
      </nav>

      {props.view === 'raw' && (
        <pre className="mt-6 overflow-x-auto whitespace-pre-wrap rounded border border-line bg-panel p-4 font-mono text-[12px] leading-relaxed">
          {p.markdown}
        </pre>
      )}

      {props.view === 'history' && (
        <div className="mt-6 space-y-8">
          {p.history.length === 0 ? (
            <p className="text-sm text-ink-dim">No history entries yet.</p>
          ) : (
            p.history.map((h, i) => (
              <section
                key={`${h.date}-${h.title}-${String(i)}`}
                className="border-l-2 border-line pl-4"
              >
                <h3 className="mb-2 font-mono text-sm text-em">
                  {h.date}
                  {h.title ? ` — ${h.title}` : ''}
                </h3>
                <WikiMarkdown knownSlugs={props.knownSlugs}>{h.body || '_empty_'}</WikiMarkdown>
              </section>
            ))
          )}
          {p.sources.length > 0 && (
            <section>
              <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold">Provenance</h2>
              <ul className="space-y-1 font-mono text-xs text-ink-dim">
                {p.sources.map((s, i) => (
                  <li key={String(i)}>
                    {s.kind}: {s.ids.join(', ')}
                    {s.conversationId ? ` · conv ${s.conversationId}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {props.view === 'article' && (
        <div className="mt-6">
          <aside className="mb-6 w-full rounded-lg border border-line bg-panel text-sm lg:float-right lg:mb-4 lg:ml-6 lg:w-72">
            <div className="border-b border-line bg-em/5 px-3 py-2 font-semibold">{p.title}</div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
              <tbody>
                <tr>
                  <th className="w-24 px-3 py-1.5 text-left font-medium text-ink-dim">Status</th>
                  <td className="py-1.5 pr-3">
                    <Badge lastVerified={p.lastVerified} />
                  </td>
                </tr>
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium text-ink-dim">Verified</th>
                  <td className="py-1.5 pr-3 font-mono">{fmtDate(p.lastVerified)}</td>
                </tr>
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium text-ink-dim">Updated</th>
                  <td className="py-1.5 pr-3 font-mono">{fmtDate(p.updatedAt)}</td>
                </tr>
                {p.aliases.length > 0 && (
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium text-ink-dim">Aliases</th>
                    <td className="py-1.5 pr-3">
                      {p.aliases.map((a) => (
                        <div key={a}>{a}</div>
                      ))}
                    </td>
                  </tr>
                )}
                {p.entities.length > 0 && (
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium text-ink-dim">Entities</th>
                    <td className="py-1.5 pr-3 font-mono text-[11px]">
                      {p.entities.map((e) => (
                        <div key={e}>
                          <code className="rounded bg-bg px-1">{e}</code>
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium text-ink-dim">Sources</th>
                  <td className="py-1.5 pr-3 font-mono">
                    {String(p.sources.reduce((n, s) => n + s.ids.length, 0))} linked
                  </td>
                </tr>
                {p.gitSha && (
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium text-ink-dim">Git</th>
                    <td className="py-1.5 pr-3 font-mono">{p.gitSha.slice(0, 7)}</td>
                  </tr>
                )}
              </tbody>
              </table>
            </div>
          </aside>

          {toc.length > 1 && (
            <nav className="mb-6 max-w-sm rounded-lg border border-line bg-panel/80 p-3 text-sm">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                Contents
              </div>
              <ol className="list-decimal space-y-1 pl-4">
                {toc.map((e) => (
                  <li key={e.id} className={e.level === 3 ? 'ml-3 list-none text-ink-dim' : ''}>
                    <a href={`#${e.id}`} className="text-em hover:underline">
                      {e.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}

          <article className="min-w-0">
            <WikiMarkdown knownSlugs={props.knownSlugs}>
              {bodyMd || '_No current state section yet._'}
            </WikiMarkdown>
          </article>

          {p.history.length > 0 && (
            <section className="clear-both mt-10">
              <h2 className="mb-3 border-b border-line pb-1 text-xl font-semibold">
                Recent history
              </h2>
              <div className="space-y-2">
                {p.history.slice(0, 4).map((h, i) => (
                  <details key={`${h.date}-${String(i)}`} open={i === 0}>
                    <summary className="cursor-pointer text-sm font-medium text-ink">
                      <span className="font-mono text-em">{h.date}</span>
                      {h.title ? ` — ${h.title}` : ''}
                    </summary>
                    <div className="mt-2 border-l border-line pl-3">
                      <WikiMarkdown knownSlugs={props.knownSlugs}>
                        {h.body || '_empty_'}
                      </WikiMarkdown>
                    </div>
                  </details>
                ))}
              </div>
              {p.history.length > 4 && (
                <button
                  type="button"
                  className="mt-3 text-sm text-em hover:underline"
                  onClick={() => props.setView('history')}
                >
                  Full history ({String(p.history.length)} entries) →
                </button>
              )}
            </section>
          )}

          {p.related && p.related.length > 0 && (
            <section className="clear-both mt-10">
              <h2 className="mb-2 border-b border-line pb-1 text-xl font-semibold">See also</h2>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {p.related.map((s) => (
                  <li key={s}>
                    <Link
                      to="/memory/$slug"
                      params={{ slug: s }}
                      className={cn(
                        'text-sm hover:underline',
                        props.knownSlugs.has(s) ? 'text-em' : 'text-red',
                      )}
                    >
                      {s}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.tags.length > 0 && (
            <nav className="clear-both mt-10 border-t border-line pt-3 text-sm text-ink-dim">
              Categories:{' '}
              {p.tags.map((t, i) => (
                <span key={t}>
                  {i > 0 ? ' · ' : ''}
                  <span className="text-em">{t}</span>
                </span>
              ))}
            </nav>
          )}
        </div>
      )}
    </div>
  )
}
