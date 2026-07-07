/**
 * /wiki — the human-facing browse UI (phase 3e).
 *
 * Server-rendered HTML over the same WikiIndexLike + repo files as
 * /api/wiki: zero build step, no client JS beyond a search box. On the
 * datahub node this is the LANDING page (den.root_redirect: /wiki + gateway
 * caps for :80) — "go to the datahub IP, see the wiki version of memory".
 *
 * Gap surfacing is first-class (Phil): the index page leads with stale
 * pages and red links so missing knowledge prompts a conversation.
 *
 * Rendering is deliberately tiny: escaped-by-default markdown subset
 * (headings, bold, code, fences, bullets, links). RivetHub (phase 4) is
 * the rich client; this is the always-on fallback view.
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
  /** Shown in the header, e.g. the node name. */
  nodeName?: string
}

const SLUG_RE = /^[a-z0-9-]{1,80}$/

export function createWikiHtmlRoute(opts: WikiHtmlOptions): GatewayRoute {
  const wikiDir = opts.wikiDir ?? '/rivet-shared/wiki'

  return {
    prefix: '/wiki',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return text(res, 405, 'method not allowed')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/wiki'.length).replace(/^\//, '')

        if (rest === '') {
          const q = url.searchParams.get('q')
          if (q) {
            const hits = await opts.index.searchTopics(q, { limit: 20 })
            return html(res, renderShell('Search: ' + q, renderSearch(q, hits), opts.nodeName))
          }
          const [{ topics, total }, gaps] = await Promise.all([
            opts.index.listTopics({ limit: 200 }),
            opts.index.gaps({ staleLimit: 5 }),
          ])
          return html(
            res,
            renderShell('Memory Wiki', renderIndex(topics, total, gaps), opts.nodeName),
          )
        }

        if (!SLUG_RE.test(rest)) return text(res, 400, 'invalid slug')
        const markdown = await readFile(join(wikiDir, 'topics', `${rest}.md`), 'utf8').catch(
          () => undefined,
        )
        if (markdown === undefined) {
          return html(
            res,
            renderShell(
              rest,
              `<p class="muted">No page for <code>${esc(rest)}</code> yet — a red link. Have the conversation that fills it in.</p>`,
              opts.nodeName,
            ),
            404,
          )
        }
        const page = parseWikiPage(markdown)
        return html(res, renderShell(page.meta.title, renderPage(page), opts.nodeName))
      } catch (err: unknown) {
        log.error(`/wiki failed: ${err instanceof Error ? err.message : String(err)}`)
        text(res, 500, 'internal error')
      }
    },
  }
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

type Topic = Awaited<ReturnType<WikiIndexLike['listTopics']>>['topics'][number]
type Gaps = Awaited<ReturnType<WikiIndexLike['gaps']>>

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Tiny escaped-by-default markdown subset. */
export function renderMarkdown(md: string): string {
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
      const level = h[1].length + 2 // page h1/h2 are the shell's
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }
    const li = /^\s*[-*] (.*)$/.exec(line)
    if (li) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    closeList()
    if (line.trim() === '') out.push('')
    else out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  if (inFence) out.push('</code></pre>')
  return out.join('\n')
}

function inline(s: string): string {
  let t = esc(s)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // [[slug]] wiki links, then plain URLs.
  t = t.replace(/\[\[([a-z0-9-]+)\]\]/g, '<a href="/wiki/$1">$1</a>')
  t = t.replace(/(https?:\/\/[^\s&<]+)/g, '<a href="$1">$1</a>')
  return t
}

function staleBadge(lastVerifiedAt?: string): string {
  if (!lastVerifiedAt) return '<span class="badge stale">never verified</span>'
  const days = Math.floor((Date.now() - Date.parse(lastVerifiedAt)) / 86_400_000)
  if (days > 30) return `<span class="badge stale">${String(days)}d stale</span>`
  if (days > 7) return `<span class="badge aging">${String(days)}d</span>`
  return ''
}

function topicLi(t: Topic): string {
  return `<li><a href="/wiki/${esc(t.slug)}">${esc(t.title)}</a> ${staleBadge(t.lastVerifiedAt)}<div class="muted">${esc(t.currentState.slice(0, 160))}</div></li>`
}

function renderIndex(topics: Topic[], total: number, gaps: Gaps): string {
  const gapsBlock =
    gaps.redLinks.length > 0 || gaps.stalest.length > 0
      ? `<section class="gaps"><h2>Gaps — worth a conversation</h2>
${gaps.redLinks.length > 0 ? `<h3>Red links (mentioned, no page)</h3><ul>${gaps.redLinks.map((r) => `<li><span class="red">${esc(r.entity)}</span> <span class="muted">← ${r.referencedBy.map(esc).join(', ')}</span></li>`).join('')}</ul>` : ''}
${gaps.stalest.length > 0 ? `<h3>Longest unverified</h3><ul>${gaps.stalest.map(topicLi).join('')}</ul>` : ''}
</section>`
      : ''
  return `${searchBox('')}
${gapsBlock}
<section><h2>Topics (${String(total)})</h2><ul>${topics.map(topicLi).join('')}</ul></section>`
}

function renderSearch(q: string, hits: Topic[]): string {
  return `${searchBox(q)}
<section><h2>Results</h2>${hits.length > 0 ? `<ul>${hits.map(topicLi).join('')}</ul>` : '<p class="muted">Nothing — maybe a gap worth filling.</p>'}</section>
<p><a href="/wiki">← all topics</a></p>`
}

function renderPage(page: ReturnType<typeof parseWikiPage>): string {
  const meta = page.meta
  const chips = [...meta.tags, ...meta.entities]
    .map((t) => `<span class="badge">${esc(t)}</span>`)
    .join(' ')
  const history = page.history
    .map(
      (h) =>
        `<details><summary><strong>${esc(h.date)}</strong>${h.title ? ` — ${esc(h.title)}` : ''}</summary>${renderMarkdown(h.body)}</details>`,
    )
    .join('\n')
  const sources = meta.sources
    .map((s) => `<li>${esc(s.kind)}: ${s.ids.map((i) => `<code>${esc(i)}</code>`).join(', ')}</li>`)
    .join('')
  return `<p><a href="/wiki">← all topics</a></p>
<div>${chips} ${staleBadge(meta.lastVerified)}</div>
<h2>Current state</h2>
${renderMarkdown(page.currentState)}
<h2>History</h2>
${history || '<p class="muted">(none)</p>'}
<details><summary class="muted">Provenance (${String(meta.sources.length)})</summary><ul>${sources}</ul>
<p class="muted"><a href="/api/wiki/${esc(meta.slug)}/raw">raw markdown</a></p></details>`
}

function searchBox(q: string): string {
  return `<form action="/wiki" method="get"><input type="search" name="q" value="${esc(q)}" placeholder="Search the wiki…" autofocus></form>`
}

function renderShell(title: string, body: string, nodeName?: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — RivetOS Wiki</title>
<style>
:root{color-scheme:dark light}
body{font-family:'DM Sans',system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:1.5rem;background:#0d1117;color:#e6edf3;line-height:1.55}
a{color:#34d399}h1,h2,h3{line-height:1.2}h1{border-bottom:1px solid #30363d;padding-bottom:.4rem}
code,pre{font-family:'JetBrains Mono',monospace;background:#161b22;border-radius:4px}
code{padding:.1rem .3rem}pre{padding:.7rem;overflow-x:auto}pre code{padding:0;background:none}
ul{padding-left:1.2rem}li{margin:.35rem 0}
.muted{color:#8b949e;font-size:.9rem}
.badge{font-size:.75rem;background:#21262d;border:1px solid #30363d;border-radius:999px;padding:.05rem .55rem;vertical-align:middle}
.badge.stale{border-color:#f85149;color:#f85149}.badge.aging{border-color:#d29922;color:#d29922}
.red{color:#f85149}
.gaps{border:1px solid #30363d;border-radius:8px;padding:.2rem 1rem .6rem;margin:1rem 0;background:#11151c}
input[type=search]{width:100%;padding:.55rem .8rem;border-radius:8px;border:1px solid #30363d;background:#161b22;color:inherit;font-size:1rem}
details{margin:.4rem 0}summary{cursor:pointer}
footer{margin-top:2.5rem;font-size:.8rem;color:#8b949e;border-top:1px solid #30363d;padding-top:.6rem}
</style></head>
<body><h1>${esc(title)}</h1>
${body}
<footer>RivetOS memory wiki${nodeName ? ` · ${esc(nodeName)}` : ''} · <a href="/api/wiki">JSON API</a></footer>
</body></html>`
}

function html(res: ServerResponse, body: string, code = 200): void {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

function text(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain' })
  res.end(body)
}
