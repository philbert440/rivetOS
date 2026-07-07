/**
 * /wiki — the human-facing wiki (phase 3e; v2 layout 2026-07-07).
 *
 * Wikipedia form and function, Rivet style (Phil's ask): fixed sidebar with
 * search + navigation, article layout with a floated infobox, article/
 * history/raw views, emerald/red wiki links (emerald = exists, red = gap),
 * category bar from tags, recent-changes and random pages. Server-rendered,
 * zero build step, no client JS beyond the search form — RivetHub (phase 4)
 * is the rich client; this is the always-on view.
 *
 * Brand: emerald-on-dark, DM Sans / JetBrains Mono, blueprint grid.
 *
 * Routes (underscore names sit outside SLUG_RE — unshadowable):
 *   /wiki                    main page (stats, gaps, newest)
 *   /wiki?q=…                search results
 *   /wiki/_all               alphabetical topic index
 *   /wiki/_recent            recent changes
 *   /wiki/_gaps              gaps (red links + stalest)
 *   /wiki/_random            302 → a random topic
 *   /wiki/<slug>             article
 *   /wiki/<slug>?view=history|raw
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { parseWikiPage } from '@rivetos/wiki-core'
import type { GatewayRoute } from '@rivetos/types'
import { logger } from '../../logger.js'
import type { WikiIndexLike } from './wiki-api.js'

const log = logger('WikiHtml')

export interface WikiHtmlOptions {
  index: WikiIndexLike
  wikiDir?: string
  /** Shown in the sidebar footer, e.g. the node name. */
  nodeName?: string
}

const SLUG_RE = /^[a-z0-9-]{1,80}$/

type Topic = Awaited<ReturnType<WikiIndexLike['listTopics']>>['topics'][number]
type Gaps = Awaited<ReturnType<WikiIndexLike['gaps']>>

export function createWikiHtmlRoute(opts: WikiHtmlOptions): GatewayRoute {
  const wikiDir = opts.wikiDir ?? '/rivet-shared/wiki'

  return {
    prefix: '/wiki',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return text(res, 405, 'method not allowed')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/wiki'.length).replace(/^\//, '')
        const { topics, total } = await opts.index.listTopics({ limit: 500 })
        const ctx: RenderCtx = {
          slugs: new Set(topics.map((t) => t.slug)),
          nodeName: opts.nodeName,
          total,
        }

        if (rest === '') {
          const q = url.searchParams.get('q')
          if (q) {
            const hits = await opts.index.searchTopics(q, { limit: 20 })
            return page(res, ctx, `Search: ${q}`, renderSearch(q, hits))
          }
          const gaps = await opts.index.gaps({ staleLimit: 5 })
          return page(res, ctx, 'Main Page', renderMain(topics, total, gaps, ctx))
        }

        if (rest === '_all') return page(res, ctx, 'All topics', renderAll(topics))
        if (rest === '_recent') return page(res, ctx, 'Recent changes', renderRecent(topics))
        if (rest === '_gaps') {
          const gaps = await opts.index.gaps({ staleLimit: 20 })
          return page(res, ctx, 'Gaps', renderGaps(gaps, ctx))
        }
        if (rest === '_random') {
          const pick = topics[Math.floor(Math.random() * Math.max(topics.length, 1))]
          res.writeHead(302, { Location: pick ? `/wiki/${pick.slug}` : '/wiki' })
          res.end()
          return
        }

        if (!SLUG_RE.test(rest)) return text(res, 400, 'invalid slug')
        const markdown = await readFile(join(wikiDir, 'topics', `${rest}.md`), 'utf8').catch(
          () => undefined,
        )
        if (markdown === undefined) {
          return page(
            res,
            ctx,
            rest,
            `<p class="muted">No article for <span class="redlink">${esc(rest)}</span> yet — a red link. Have the conversation that fills it in, and the extractor will write this page.</p>`,
            404,
          )
        }
        const view = url.searchParams.get('view') ?? 'article'
        if (view === 'raw') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
          res.end(markdown)
          return
        }
        try {
          const parsed = parseWikiPage(markdown)
          const row = await opts.index.getTopic(rest).catch(() => undefined)
          return page(
            res,
            ctx,
            parsed.meta.title,
            view === 'history'
              ? renderHistoryView(parsed, ctx)
              : renderArticle(parsed, row?.updatedAt, ctx),
            200,
            rest,
            view,
          )
        } catch {
          return page(
            res,
            ctx,
            rest,
            `<p class="muted">This page is malformed (likely a hand edit) — <a href="/wiki/${esc(rest)}?view=raw">view raw</a>. The next extractor pass will re-structure it.</p>`,
          )
        }
      } catch (err: unknown) {
        log.error(`/wiki failed: ${err instanceof Error ? err.message : String(err)}`)
        text(res, 500, 'internal error')
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Markdown (escaped-by-default subset with wiki-link awareness)
// ---------------------------------------------------------------------------

interface RenderCtx {
  slugs: Set<string>
  nodeName?: string
  total: number
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function renderMarkdown(md: string, ctx?: RenderCtx): string {
  const out: string[] = []
  let inFence = false
  let inList = false
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  for (const line of md.split('\n')) {
    if (/^```/.test(line.trim())) {
      closeList()
      out.push(inFence ? '</code></pre>' : '<pre><code>')
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(esc(line))
      continue
    }
    const h = /^(#{1,4}) (.*)$/.exec(line)
    if (h) {
      closeList()
      const level = Math.min(h[1].length + 2, 6)
      out.push(`<h${String(level)}>${inline(h[2], ctx)}</h${String(level)}>`)
      continue
    }
    const li = /^\s*[-*] (.*)$/.exec(line)
    if (li) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(li[1], ctx)}</li>`)
      continue
    }
    closeList()
    if (line.trim() === '') out.push('')
    else out.push(`<p>${inline(line, ctx)}</p>`)
  }
  closeList()
  if (inFence) out.push('</code></pre>')
  return out.join('\n')
}

function inline(s: string, ctx?: RenderCtx): string {
  let t = esc(s)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // [[slug]] wiki links: emerald when the article exists, red when a gap.
  t = t.replace(/\[\[([a-z0-9-]+)\]\]/g, (_, slug: string) => wikiLink(slug, ctx))
  // Text is pre-escaped, so '<' can't occur and entities are attribute-safe.
  t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" class="ext">$1</a>')
  return t
}

function wikiLink(slug: string, ctx?: RenderCtx, label?: string): string {
  const textLabel = esc(label ?? slug)
  if (ctx && !ctx.slugs.has(slug)) {
    return `<a href="/wiki/${slug}" class="redlink">${textLabel}</a>`
  }
  return `<a href="/wiki/${slug}">${textLabel}</a>`
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function fmtDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : '—'
}

function staleness(lastVerifiedAt?: string): string {
  if (!lastVerifiedAt) return '<span class="badge stale">never verified</span>'
  const days = Math.floor((Date.now() - Date.parse(lastVerifiedAt)) / 86_400_000)
  if (days > 30) return `<span class="badge stale">${String(days)}d stale</span>`
  if (days > 7) return `<span class="badge aging">${String(days)}d</span>`
  return '<span class="badge fresh">current</span>'
}

function renderArticle(
  p: ReturnType<typeof parseWikiPage>,
  updatedAt: string | undefined,
  ctx: RenderCtx,
): string {
  const meta = p.meta
  const infobox = `<aside class="infobox">
<div class="ib-title">${esc(meta.title)}</div>
<table>
<tr><th>Status</th><td>${staleness(meta.lastVerified)}</td></tr>
<tr><th>Verified</th><td>${fmtDate(meta.lastVerified)}</td></tr>
<tr><th>Updated</th><td>${fmtDate(updatedAt)}</td></tr>
${meta.aliases.length > 0 ? `<tr><th>Aliases</th><td>${meta.aliases.map(esc).join('<br>')}</td></tr>` : ''}
${meta.entities.length > 0 ? `<tr><th>Entities</th><td>${meta.entities.map((e) => `<code>${esc(e)}</code>`).join('<br>')}</td></tr>` : ''}
<tr><th>Sources</th><td>${String(meta.sources.reduce((n, s) => n + s.ids.length, 0))} linked</td></tr>
</table></aside>`

  const recent = p.history.slice(0, 4)
  const history = recent
    .map(
      (h, i) =>
        `<details${i === 0 ? ' open' : ''}><summary><strong>${esc(h.date)}</strong>${h.title ? ` — ${esc(h.title)}` : ''}</summary>${renderMarkdown(h.body, ctx)}</details>`,
    )
    .join('\n')
  const more =
    p.history.length > 4
      ? `<p><a href="/wiki/${esc(meta.slug)}?view=history">Full history (${String(p.history.length)} entries) →</a></p>`
      : ''
  const categories =
    meta.tags.length > 0
      ? `<nav class="catbar">Categories: ${meta.tags.map((t) => `<a href="/wiki/_all">${esc(t)}</a>`).join(' · ')}</nav>`
      : ''
  return `${infobox}
${renderMarkdown(p.currentState, ctx)}
<h2>Recent history</h2>
${history || '<p class="muted">(none yet)</p>'}
${more}
${categories}`
}

function renderHistoryView(p: ReturnType<typeof parseWikiPage>, ctx: RenderCtx): string {
  const entries = p.history
    .map(
      (h) =>
        `<section class="hentry"><h3>${esc(h.date)}${h.title ? ` — ${esc(h.title)}` : ''}</h3>${renderMarkdown(h.body, ctx)}</section>`,
    )
    .join('\n')
  const sources = p.meta.sources
    .map((s) => `<li>${esc(s.kind)}: ${s.ids.map((i) => `<code>${esc(i)}</code>`).join(', ')}</li>`)
    .join('')
  return `<p><a href="/wiki/${esc(p.meta.slug)}">← article</a></p>
${entries || '<p class="muted">(no history)</p>'}
<h2>Provenance</h2><ul>${sources || '<li class="muted">(none)</li>'}</ul>`
}

function topicRow(t: Topic): string {
  return `<li><a href="/wiki/${esc(t.slug)}">${esc(t.title)}</a> ${staleness(t.lastVerifiedAt)}<div class="muted">${esc(t.currentState.slice(0, 150))}</div></li>`
}

function renderMain(topics: Topic[], total: number, gaps: Gaps, ctx: RenderCtx): string {
  const newest = [...topics].sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1)).slice(0, 8)
  const gapsBlock =
    gaps.redLinks.length > 0 || gaps.stalest.length > 0
      ? `<div class="panel warn"><h2>Gaps — worth a conversation</h2>
${
  gaps.redLinks.length > 0
    ? `<ul>${gaps.redLinks
        .slice(0, 8)
        .map(
          (r) =>
            `<li><span class="redlink">${esc(r.entity)}</span> <span class="muted">mentioned by ${r.referencedBy
              .slice(0, 3)
              .map((s) => wikiLink(s, ctx))
              .join(', ')}</span></li>`,
        )
        .join('')}</ul>`
    : ''
}
${
  gaps.stalest.length > 0
    ? `<p class="muted">Longest unverified: ${gaps.stalest
        .slice(0, 5)
        .map((t) => wikiLink(t.slug, ctx, t.title))
        .join(' · ')}</p>`
    : ''
}
<p class="muted"><a href="/wiki/_gaps">all gaps →</a></p></div>`
      : ''
  return `<p class="lead">The living encyclopedia of RivetOS memory — ${String(total)} topic${total === 1 ? '' : 's'} distilled from conversation history, updated as new summaries land.</p>
${gapsBlock}
<div class="panel"><h2>Recently updated</h2><ul class="topiclist">${newest.map(topicRow).join('')}</ul>
<p class="muted"><a href="/wiki/_all">all topics</a> · <a href="/wiki/_recent">recent changes</a> · <a href="/wiki/_random">random</a></p></div>`
}

function renderAll(topics: Topic[]): string {
  const sorted = [...topics].sort((a, b) => a.title.localeCompare(b.title))
  const groups = new Map<string, Topic[]>()
  for (const t of sorted) {
    const letter = (t.title[0] ?? '#').toUpperCase()
    groups.set(letter, [...(groups.get(letter) ?? []), t])
  }
  return (
    [...groups.entries()]
      .map(
        ([letter, ts]) =>
          `<h2>${esc(letter)}</h2><ul class="topiclist">${ts.map(topicRow).join('')}</ul>`,
      )
      .join('\n') || '<p class="muted">No topics yet — the backfill is still writing.</p>'
  )
}

function renderRecent(topics: Topic[]): string {
  const sorted = [...topics].sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1))
  const byDay = new Map<string, Topic[]>()
  for (const t of sorted) {
    const day = fmtDate(t.updatedAt)
    byDay.set(day, [...(byDay.get(day) ?? []), t])
  }
  return (
    [...byDay.entries()]
      .map(
        ([day, ts]) =>
          `<h2>${esc(day)}</h2><ul class="topiclist">${ts.map(topicRow).join('')}</ul>`,
      )
      .join('\n') || '<p class="muted">Nothing yet.</p>'
  )
}

function renderGaps(gaps: Gaps, ctx: RenderCtx): string {
  return `<h2>Red links — mentioned, no article</h2>
<ul>${gaps.redLinks.map((r) => `<li><span class="redlink">${esc(r.entity)}</span> <span class="muted">← ${r.referencedBy.map((s) => wikiLink(s, ctx)).join(', ')}</span></li>`).join('') || '<li class="muted">(none)</li>'}</ul>
<h2>Longest unverified</h2>
<ul class="topiclist">${gaps.stalest.map(topicRow).join('') || '<li class="muted">(none)</li>'}</ul>`
}

function renderSearch(q: string, hits: Topic[]): string {
  return `<h2>Results for “${esc(q)}”</h2>
${hits.length > 0 ? `<ul class="topiclist">${hits.map(topicRow).join('')}</ul>` : '<p class="muted">Nothing — maybe a gap worth filling. Try <a href="/wiki/_gaps">the gaps page</a>.</p>'}`
}

// ---------------------------------------------------------------------------
// Shell — sidebar + article frame, Rivet brand
// ---------------------------------------------------------------------------

function shell(
  ctx: RenderCtx,
  title: string,
  body: string,
  slug?: string,
  view = 'article',
): string {
  const tabs = slug
    ? `<nav class="tabs">
<a href="/wiki/${esc(slug)}"${view === 'article' ? ' class="on"' : ''}>Article</a>
<a href="/wiki/${esc(slug)}?view=history"${view === 'history' ? ' class="on"' : ''}>History</a>
<a href="/wiki/${esc(slug)}?view=raw">Raw</a>
<a href="/api/wiki/${esc(slug)}">JSON</a>
</nav>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — RivetOS Wiki</title>
<style>
:root{--bg:#0d1117;--panel:#11151c;--line:#30363d;--ink:#e6edf3;--muted:#8b949e;--em:#34d399;--red:#f85149;--amber:#d29922;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:'DM Sans',system-ui,sans-serif;background:var(--bg);color:var(--ink);line-height:1.6;
background-image:linear-gradient(rgba(52,211,153,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(52,211,153,.03) 1px,transparent 1px);background-size:32px 32px}
a{color:var(--em);text-decoration:none}a:hover{text-decoration:underline}
a.redlink,span.redlink{color:var(--red)}a.ext{color:#79c0ff}
.layout{display:grid;grid-template-columns:15rem 1fr;min-height:100vh}
.sidebar{border-right:1px solid var(--line);padding:1.2rem 1rem;background:var(--panel);position:sticky;top:0;height:100vh;overflow-y:auto}
.logo{font-weight:700;font-size:1.15rem;margin-bottom:.9rem;display:block;color:var(--ink)}
.logo .bolt{color:var(--em)}
.sidebar input[type=search]{width:100%;padding:.45rem .7rem;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:inherit;font-size:.92rem}
.sidebar nav{margin-top:1.1rem}
.sidebar nav h4{margin:.9rem 0 .3rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.sidebar nav a{display:block;padding:.14rem 0;font-size:.95rem}
.sidefoot{margin-top:1.4rem;font-size:.75rem;color:var(--muted);border-top:1px solid var(--line);padding-top:.7rem}
main{padding:1.6rem 2.4rem;max-width:62rem}
h1.title{margin:.1rem 0 .2rem;font-size:1.9rem;border-bottom:1px solid var(--line);padding-bottom:.35rem}
.fromline{color:var(--muted);font-size:.85rem;margin-bottom:1rem}
.tabs{display:flex;gap:1rem;border-bottom:1px solid var(--line);margin:0 0 1.1rem;font-size:.92rem}
.tabs a{padding:.3rem 0;color:var(--muted)}.tabs a.on{color:var(--em);border-bottom:2px solid var(--em)}
.infobox{float:right;width:17rem;margin:0 0 1rem 1.4rem;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:.86rem}
.infobox .ib-title{padding:.5rem .8rem;font-weight:700;border-bottom:1px solid var(--line);background:rgba(52,211,153,.06)}
.infobox table{width:100%;border-collapse:collapse}
.infobox th{width:5.6rem;text-align:left;vertical-align:top;color:var(--muted);font-weight:500;padding:.35rem .8rem}
.infobox td{padding:.35rem .8rem .35rem 0;word-break:break-word}
code,pre{font-family:'JetBrains Mono',monospace;background:#161b22;border-radius:4px}
code{padding:.08rem .3rem;font-size:.88em}pre{padding:.7rem;overflow-x:auto}pre code{padding:0;background:none}
ul{padding-left:1.2rem}.topiclist{list-style:none;padding-left:0}.topiclist li{margin:.55rem 0}
.muted{color:var(--muted);font-size:.9rem}
.badge{font-size:.72rem;border:1px solid var(--line);border-radius:999px;padding:.02rem .5rem;vertical-align:middle;background:var(--bg)}
.badge.stale{border-color:var(--red);color:var(--red)}.badge.aging{border-color:var(--amber);color:var(--amber)}.badge.fresh{border-color:var(--em);color:var(--em)}
.panel{border:1px solid var(--line);border-radius:8px;padding:.4rem 1.1rem .8rem;margin:1rem 0;background:var(--panel)}
.panel.warn{border-color:rgba(248,81,73,.5)}
.lead{font-size:1.05rem}
.catbar{clear:both;margin-top:1.6rem;border-top:1px solid var(--line);padding-top:.5rem;font-size:.85rem;color:var(--muted)}
details{margin:.45rem 0}summary{cursor:pointer}
.hentry{border-left:2px solid var(--line);padding-left:1rem;margin:1rem 0}
@media(max-width:52rem){.layout{grid-template-columns:1fr}.sidebar{position:static;height:auto}.infobox{float:none;width:100%;margin:0 0 1rem}}
</style></head>
<body><div class="layout">
<aside class="sidebar">
<a class="logo" href="/wiki"><span class="bolt">🔩</span> RivetOS Wiki</a>
<form action="/wiki" method="get"><input type="search" name="q" placeholder="Search memory…"></form>
<nav>
<h4>Navigate</h4>
<a href="/wiki">Main page</a>
<a href="/wiki/_all">All topics (${String(ctx.total)})</a>
<a href="/wiki/_recent">Recent changes</a>
<a href="/wiki/_gaps">Gaps</a>
<a href="/wiki/_random">Random article</a>
<h4>Tools</h4>
<a href="/api/wiki">JSON API</a>
</nav>
<div class="sidefoot">RivetOS memory wiki${ctx.nodeName ? `<br>node: ${esc(ctx.nodeName)}` : ''}<br>written by the compaction worker;<br>humans may edit — nothing is lost.</div>
</aside>
<main>
<h1 class="title">${esc(title)}</h1>
<div class="fromline">From RivetOS memory — the distilled record of what is currently true.</div>
${tabs}
${body}
</main>
</div></body></html>`
}

function page(
  res: ServerResponse,
  ctx: RenderCtx,
  title: string,
  body: string,
  code = 200,
  slug?: string,
  view?: string,
): void {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(shell(ctx, title, body, slug, view))
}

function text(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain' })
  res.end(body)
}
