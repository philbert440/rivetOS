/**
 * Memory — the mesh memory wiki, embedded. The wiki is server-rendered by
 * the gateway that owns the memory index (one node serves it for the whole
 * mesh), so this is a full-bleed iframe.
 *
 * Keep-alive: the iframe lives in the ROOT layout (MemoryFrame), not the
 * route — mounted once at app start (warm by the first click) and merely
 * hidden while you're elsewhere, so the wiki keeps its page and scroll
 * across navigation instead of reloading. The /memory route component is a
 * placeholder; the frame overlays it whenever the route is active.
 */

import { type JSX } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useConnection } from '../stores/connection.js'
import { useWikiSettings } from '../stores/wiki-settings.js'

export function buildSrc(url: string, baseUrl: string, token?: string): string {
  if (!token || !baseUrl) return url
  try {
    const wiki = new URL(url)
    if (wiki.origin !== new URL(baseUrl).origin) return url
    wiki.searchParams.set('token', token)
    return wiki.toString()
  } catch {
    return url
  }
}

/** Rendered by the root layout as a sibling of the route outlet. */
export function MemoryFrame(): JSX.Element | null {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const wikiUrl = useWikiSettings((s) => s.wikiUrl)
  const active = useRouterState({ select: (s) => s.location.pathname === '/memory' })

  const url = wikiUrl || (baseUrl ? `${baseUrl}/wiki` : '')
  if (!url) {
    if (!active) return null
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-dim">
        Set a wiki URL (or connect a node) in Settings to browse memory.
      </div>
    )
  }

  // ?token= only helps when the wiki is served by the active (token-gated)
  // gateway; iframes can't carry a bearer header. A standalone wiki node is
  // tokenless by posture, and a foreign token would just leak. Origins must
  // match exactly — a prefix check would treat :51 as :5174 (PR review).
  const src = buildSrc(url, baseUrl, token)

  return (
    <iframe
      key={src}
      src={src}
      title="memory wiki"
      className={active ? 'h-full w-full border-0 bg-panel' : 'hidden'}
    />
  )
}

/** Route stub — MemoryFrame (root layout) shows over it when active. */
export function MemoryPage(): null {
  return null
}
