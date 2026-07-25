/**
 * Datahub gateway origin helpers for the Memory wiki.
 *
 * The wiki is human-readable memory (summaries → topic pages) and lives on
 * **datahub**, not on the chat node. Hub talks to it via `/api/wiki` on that
 * origin — never by iframes of `/wiki` HTML.
 */

import type { MeshDenNode } from '@rivetos/types'
import { gatewayOrigin, isValidGatewayUrl } from './gateway-url.js'

/**
 * Normalize a user/settings value to a bare gateway origin.
 * Migrates legacy iframe URLs like `http://host/wiki` → `http://host`.
 * Returns '' for empty/invalid input.
 */
export function normalizeWikiBase(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    // Allow trailing slashes; strip them before URL parse edge cases
    const u = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    if (u.username || u.password) return ''
    // Origin only — drop /wiki or any other path/query/hash
    const origin = u.origin
    return isValidGatewayUrl(origin) || isValidGatewayUrl(`${origin}/`) ? origin : ''
  } catch {
    return ''
  }
}

export function isValidWikiBase(url: string): boolean {
  return normalizeWikiBase(url) !== ''
}

/**
 * Pick the datahub node from a mesh den roster (name/id match).
 * Returns origin or null.
 */
export function datahubBaseFromMesh(nodes: readonly MeshDenNode[]): string | null {
  const hit = nodes.find((n) => {
    const id = n.id.toLowerCase()
    const name = n.name.toLowerCase()
    return id === 'datahub' || name === 'datahub' || name.includes('datahub')
  })
  if (!hit) return null
  return gatewayOrigin(hit.denUrl)
}

/** Convert `[[slug]]` wiki links to in-app markdown links. */
export function wikiLinksToMarkdown(md: string): string {
  return md.replace(/\[\[([a-z0-9-]{1,80})\]\]/g, '[$1](/memory/$1)')
}
