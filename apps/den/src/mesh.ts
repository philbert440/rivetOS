// Mesh overview route (/mesh): every den-enabled mesh node as a card — LED
// dot colored by the node's latest activity, node name, den host, live
// session count, and a cheap visualization of the first session (activity
// label + title from `latest`; deliberately NOT a live room embed). Clicking
// a card navigates to that node's own den origin — each node's den-server
// serves its own viewer and session grid — except the local node's card,
// which just goes home to '/'. Data: GET /mesh.json (den-server assembles
// roster + peer probes, see services/den-server/src/mesh.ts), polled every
// 10s. No Pixi, no packs, no session feed on this route: plain DOM only.

import { serverHttp, viewerHref, withToken } from './net.js'
import { ACTIVITY_LABEL, LED_COLOR } from './room.js'
import type { Activity } from '@rivetos/den-protocol'

const POLL_MS = 10_000
const ONLINE_LED = 0x34d399 // online but no activity info (every remote node)
const OFFLINE_LED = 0x3a4a5e

/** One /mesh.json roster entry — every field defensive: the payload crosses
 *  a version boundary (older/newer den-servers) and `latest` only exists on
 *  the entry that IS the answering process (null there when it sleeps). */
export interface MeshNodePayload {
  id?: string
  name?: string
  denUrl?: string
  online?: boolean
  sessions?: number | null
  latest?: { activity?: string; title?: string } | null
}

/** Everything a card renders, pre-derived so the DOM pass is dumb. */
export interface MeshCard {
  id: string
  name: string
  /** host[:port] of the node's den, for the card's second line */
  host: string
  online: boolean
  /** 'N sessions' / '1 session' / 'online' (count unknown) / 'offline' */
  status: string
  /** LED fill, CSS hex */
  led: string
  /** first-session peek — only the local node publishes one */
  latest: { title: string; label: string } | null
  /** the card for the den answering /mesh.json (or this page's own origin) */
  local: boolean
  /** click target: home for the local node, the node's own origin otherwise */
  href: string
}

const css = (c: number): string => `#${c.toString(16).padStart(6, '0')}`

/** Pure card-model construction (unit-tested; rendering is the e2e's job).
 *  `homeHref` is what the local node's card links to — the caller passes
 *  viewerHref('/') so ?server=/?token= survive the trip home. */
export function buildMeshCards(
  nodes: MeshNodePayload[],
  pageOrigin: string,
  homeHref = '/',
): MeshCard[] {
  return nodes.map((n) => {
    const id = n.id ?? '?'
    let host = n.denUrl ?? ''
    let origin = n.denUrl ?? ''
    try {
      const u = new URL(n.denUrl ?? '')
      host = u.host
      origin = u.origin
    } catch {
      // denUrl missing/unparseable — show it raw; the card still renders
    }
    const online = n.online === true
    // `latest` present (even null) ⇔ the answering process is this node;
    // matching the page origin catches it too when the id mapping is off
    const local = 'latest' in n || (origin !== '' && origin === pageOrigin)
    const activity = n.latest?.activity
    const led = !online
      ? OFFLINE_LED
      : activity
        ? (LED_COLOR[activity as Activity] ?? ONLINE_LED)
        : ONLINE_LED
    const status = !online
      ? 'offline'
      : typeof n.sessions === 'number'
        ? `${n.sessions} session${n.sessions === 1 ? '' : 's'}`
        : 'online'
    const latest = n.latest?.title
      ? {
          title: n.latest.title,
          label: ACTIVITY_LABEL[activity as Activity] ?? activity?.replace(/_/g, ' ') ?? '',
        }
      : null
    return {
      id,
      name: n.name ?? id,
      host,
      online,
      status,
      led: css(led),
      latest,
      local,
      href: local ? homeHref : origin,
    }
  })
}

// tiny imperative-DOM helper, same spirit as the rest of the viewer
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function card(c: MeshCard): HTMLAnchorElement {
  const a = el('a', c.online ? 'mesh-card' : 'mesh-card off')
  a.href = c.href
  const head = el('div', 'mesh-card-head')
  const led = el('span', 'mesh-led')
  led.style.background = c.led
  led.style.boxShadow = c.online ? `0 0 8px ${c.led}` : 'none'
  head.append(led, el('span', 'mesh-name', c.name))
  a.append(head, el('div', 'mesh-host', c.host), el('div', 'mesh-count', c.status))
  if (c.latest) {
    const peek = el('div', 'mesh-latest')
    peek.append(el('div', 'mesh-latest-title', c.latest.title))
    if (c.latest.label) peek.append(el('div', 'mesh-latest-act', c.latest.label))
    a.append(peek)
  }
  return a
}

/** The /mesh page. Called by boot() before any Pixi/pack work; owns the DOM
 *  until the next full navigation (BACK link / card click), so cleanup is
 *  just the poll timer on pagehide. */
export function renderMesh(root: HTMLElement): void {
  // the fixed chrome in index.html belongs to the grid route
  const strip = document.getElementById('header-strip')
  if (strip) strip.style.display = 'none'

  const page = el('div', 'mesh-page')
  const bar = el('div', 'mesh-bar')
  const back = el('a', 'mesh-back', '← DEN')
  back.href = viewerHref('/')
  const status = el('span', 'mesh-status', 'loading…')
  bar.append(back, el('span', 'mesh-title', 'MESH'), status)
  const grid = el('div', 'mesh-grid')
  page.append(bar, grid)
  root.appendChild(page)

  const message = (text: string) => {
    grid.replaceChildren(el('div', 'mesh-msg', text))
  }

  async function refresh(): Promise<void> {
    try {
      const r = await fetch(withToken(`${serverHttp}/mesh.json`))
      // 404 = no mesh file on this node — an empty den, not an error
      if (r.status === 404) {
        status.textContent = ''
        message('no den-enabled nodes in the mesh — see docs/DEN.md')
        return
      }
      if (!r.ok) throw new Error(`/mesh.json → ${r.status}`)
      const data = (await r.json()) as { updatedAt?: number; nodes?: MeshNodePayload[] }
      const cards = buildMeshCards(data.nodes ?? [], location.origin, viewerHref('/'))
      status.textContent = `${cards.length} node${cards.length === 1 ? '' : 's'}`
      if (cards.length === 0) {
        message('no den-enabled nodes in the mesh — see docs/DEN.md')
        return
      }
      grid.replaceChildren(...cards.map(card))
    } catch {
      // unreachable server / bad JSON: keep whatever is on screen, say so
      status.textContent = 'den-server unreachable — retrying'
    }
  }

  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS)
  window.addEventListener('pagehide', () => clearInterval(timer))
}
