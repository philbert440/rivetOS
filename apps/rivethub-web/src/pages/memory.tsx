/**
 * Memory — native Hub UI over datahub `/api/wiki`.
 *
 * Wiki = memory-DB summaries in human-readable topic form. Source of truth is
 * **datahub** (Settings override or mesh discovery). No iframe of `/wiki`.
 */

import { useEffect, useState, type JSX } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { GatewayError } from '@rivetos/gateway-client'
import type { WikiIndexEntry, WikiPageResponse } from '@rivetos/types'
import { NotConnected } from '../components/not-connected.js'
import { WikiMarkdown } from '../components/wiki-markdown.js'
import { useWikiEndpoint } from '../lib/wiki-client.js'
import { copyTextToClipboard } from '../lib/clipboard.js'

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = Date.parse(iso)
  if (!Number.isFinite(d)) return iso.slice(0, 10)
  return new Date(d).toLocaleDateString()
}

function WikiNotConfigured(props: { needNode: boolean }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="font-mono text-sm text-em">Memory wiki</div>
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

/** Route: /memory — search + recent + gaps */
export function MemoryPage(): JSX.Element {
  const { endpoint, pending, needNode } = useWikiEndpoint()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])

  const index = useQuery({
    queryKey: ['wiki-index', endpoint?.baseUrl, debounced],
    enabled: !!endpoint,
    queryFn: ({ signal }) =>
      endpoint!.gateway.wikiIndex(debounced ? { q: debounced, limit: 40 } : { limit: 40 }, signal),
  })

  const gaps = useQuery({
    queryKey: ['wiki-gaps', endpoint?.baseUrl],
    enabled: !!endpoint && !debounced,
    queryFn: ({ signal }) => endpoint!.gateway.wikiGaps(12, signal),
  })

  if (needNode) return <NotConnected />
  if (pending) {
    return <div className="p-8 font-mono text-sm text-ink-dim">resolving datahub…</div>
  }
  if (!endpoint) return <WikiNotConfigured needNode={false} />

  const topics = index.data?.topics ?? []

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6 py-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-semibold text-em">Memory</h1>
          <p className="mt-0.5 font-mono text-[11px] text-ink-dim">
            datahub · {endpoint.baseUrl}
            {endpoint.source === 'mesh' ? ' · mesh' : ''}
          </p>
        </div>
        <form
          className="flex min-w-[16rem] flex-1 max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setDebounced(q.trim())
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search topics…"
            autoFocus
            className="w-full rounded border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-em"
          />
        </form>
      </header>

      {index.isError && (
        <div className="mb-3 font-mono text-sm text-red">{index.error.message}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {debounced ? (
          <Section title={`Search · ${debounced}`}>
            {topics.length === 0 && !index.isLoading ? (
              <p className="text-sm text-ink-dim">No topics matched.</p>
            ) : (
              <TopicList
                topics={topics}
                onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
              />
            )}
          </Section>
        ) : (
          <>
            <Section title="Recent topics">
              {index.isLoading ? (
                <p className="text-sm text-ink-dim">loading…</p>
              ) : (
                <TopicList
                  topics={topics}
                  onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
                />
              )}
            </Section>

            {gaps.data && (gaps.data.stalest.length > 0 || gaps.data.redLinks.length > 0) && (
              <Section title="Gaps & stale">
                {gaps.data.stalest.length > 0 && (
                  <div className="mb-3">
                    <div className="mb-1 font-mono text-[11px] text-ink-dim">stalest</div>
                    <TopicList
                      topics={gaps.data.stalest}
                      onOpen={(slug) => void navigate({ to: '/memory/$slug', params: { slug } })}
                    />
                  </div>
                )}
                {gaps.data.redLinks.length > 0 && (
                  <div>
                    <div className="mb-1 font-mono text-[11px] text-ink-dim">
                      red links (entities)
                    </div>
                    <ul className="flex flex-col gap-1">
                      {gaps.data.redLinks.slice(0, 12).map((r) => (
                        <li key={r.entity} className="font-mono text-xs text-red">
                          {r.entity}
                          <span className="text-ink-dim">
                            {' '}
                            · {r.referencedBy.length} ref
                            {r.referencedBy.length === 1 ? '' : 's'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Route: /memory/$slug */
export function MemoryTopicPage(): JSX.Element {
  const { slug } = useParams({ from: '/memory/$slug' })
  const { endpoint, pending, needNode } = useWikiEndpoint()
  const [view, setView] = useState<'article' | 'history' | 'raw'>('article')
  const [copied, setCopied] = useState(false)

  const page = useQuery({
    queryKey: ['wiki-page', endpoint?.baseUrl, slug],
    enabled: !!endpoint && !!slug,
    queryFn: ({ signal }) => endpoint!.gateway.wikiPage(slug, signal),
  })

  if (needNode) return <NotConnected />
  if (pending) {
    return <div className="p-8 font-mono text-sm text-ink-dim">resolving datahub…</div>
  }
  if (!endpoint) return <WikiNotConfigured needNode={false} />

  if (page.isError) {
    const err = page.error
    const notFound = err instanceof GatewayError && err.status === 404
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <BackLink />
        <div className={`mt-4 font-mono text-sm ${notFound ? 'text-ink-dim' : 'text-red'}`}>
          {notFound ? `No topic “${slug}”.` : err.message}
        </div>
      </div>
    )
  }

  if (!page.data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <BackLink />
        <div className="mt-4 text-sm text-ink-dim">loading…</div>
      </div>
    )
  }

  const p = page.data

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <BackLink />
      <header className="mb-4 mt-3">
        <h1 className="text-xl font-semibold text-ink">{p.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-dim">
          <span>{p.slug}</span>
          <span>verified {fmtDate(p.lastVerified)}</span>
          <span>updated {fmtDate(p.updatedAt)}</span>
          {p.gitSha && <span className="truncate">git {p.gitSha.slice(0, 7)}</span>}
        </div>
        {(p.tags.length > 0 || p.aliases.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {p.tags.map((t) => (
              <span
                key={`t-${t}`}
                className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-em"
              >
                {t}
              </span>
            ))}
            {p.aliases.map((a) => (
              <span
                key={`a-${a}`}
                className="rounded border border-line/60 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
              >
                {a}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="mb-4 flex gap-1 border-b border-line pb-2">
        {(['article', 'history', 'raw'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded px-3 py-1 font-mono text-xs ${
              view === v ? 'bg-panel-2 text-em' : 'text-ink-dim hover:text-ink'
            }`}
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto rounded px-2 py-1 font-mono text-[11px] text-ink-dim hover:text-em"
          onClick={() => {
            void copyTextToClipboard(p.markdown).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          {copied ? 'copied' : 'copy md'}
        </button>
      </div>

      {view === 'article' && <ArticleBody page={p} />}
      {view === 'history' && <HistoryBody page={p} />}
      {view === 'raw' && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-line bg-panel p-4 font-mono text-[12px] leading-relaxed text-ink">
          {p.markdown}
        </pre>
      )}

      {p.related && p.related.length > 0 && view === 'article' && (
        <section className="mt-8 border-t border-line pt-4">
          <div className="mb-2 font-mono text-xs font-semibold text-em">Related</div>
          <ul className="flex flex-wrap gap-2">
            {p.related.map((s) => (
              <li key={s}>
                <Link
                  to="/memory/$slug"
                  params={{ slug: s }}
                  className="font-mono text-xs text-em hover:underline"
                >
                  {s}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.entities.length > 0 && view === 'article' && (
        <section className="mt-6">
          <div className="mb-2 font-mono text-xs font-semibold text-em">Entities</div>
          <div className="flex flex-wrap gap-1.5">
            {p.entities.map((e) => (
              <code
                key={e}
                className="rounded bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink-dim"
              >
                {e}
              </code>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ArticleBody(props: { page: WikiPageResponse }): JSX.Element {
  const { page } = props
  return (
    <article>
      <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-ink-dim">
        Current state
      </div>
      <WikiMarkdown>{page.currentState || '_No current state section._'}</WikiMarkdown>
    </article>
  )
}

function HistoryBody(props: { page: WikiPageResponse }): JSX.Element {
  const { history } = props.page
  if (history.length === 0) {
    return <p className="text-sm text-ink-dim">No history entries.</p>
  }
  return (
    <div className="flex flex-col gap-6">
      {history.map((h, i) => (
        <section key={`${h.date}-${h.title}-${String(i)}`}>
          <div className="mb-1 font-mono text-xs text-em">
            {h.date}
            {h.title ? ` — ${h.title}` : ''}
          </div>
          <WikiMarkdown>{h.body || '_empty_'}</WikiMarkdown>
        </section>
      ))}
    </div>
  )
}

function TopicList(props: {
  topics: WikiIndexEntry[]
  onOpen: (slug: string) => void
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-2">
      {props.topics.map((t) => (
        <li key={t.slug}>
          <button
            type="button"
            onClick={() => props.onOpen(t.slug)}
            className="flex w-full flex-col gap-0.5 rounded border border-line bg-panel px-4 py-3 text-left hover:border-em"
          >
            <span className="text-sm text-ink">{t.title}</span>
            <span className="line-clamp-2 font-mono text-[11px] text-ink-dim">
              {t.excerpt || t.slug}
            </span>
            <span className="font-mono text-[10px] text-ink-dim">
              {t.slug}
              {t.updatedAt ? ` · ${fmtDate(t.updatedAt)}` : ''}
              {t.tags.length > 0 ? ` · ${t.tags.slice(0, 3).join(', ')}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Section(props: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mb-8">
      <div className="mb-2 font-mono text-xs font-semibold text-em">{props.title}</div>
      {props.children}
    </section>
  )
}

function BackLink(): JSX.Element {
  return (
    <Link to="/memory" className="font-mono text-xs text-ink-dim hover:text-em">
      ← Memory
    </Link>
  )
}
