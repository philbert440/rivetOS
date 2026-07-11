/**
 * Memory — the mesh memory wiki, embedded. The wiki is server-rendered by
 * the gateway that owns the memory index (one node serves it for the whole
 * mesh), so this page is a full-bleed iframe, same pattern as the den
 * viewer: an explicit wiki URL from Settings wins, otherwise the active
 * node's /wiki.
 */

import { type JSX } from 'react'
import { useConnection } from '../stores/connection.js'
import { useWikiSettings } from '../stores/wiki-settings.js'

export function MemoryPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const wikiUrl = useWikiSettings((s) => s.wikiUrl)

  const url = wikiUrl || (baseUrl ? `${baseUrl}/wiki` : '')
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-dim">
        Set a wiki URL (or connect a node) in Settings to browse memory.
      </div>
    )
  }

  // ?token= only helps when the wiki is served by the active (token-gated)
  // gateway; iframes can't carry a bearer header. A standalone wiki node is
  // tokenless by posture, and a foreign token would just leak.
  const sameGateway = baseUrl && url.startsWith(baseUrl)
  const src = token && sameGateway ? `${url}?token=${encodeURIComponent(token)}` : url

  return (
    <iframe key={src} src={src} title="memory wiki" className="h-full w-full border-0 bg-panel" />
  )
}
