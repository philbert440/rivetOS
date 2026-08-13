/**
 * Datahub gateway origin helpers for the Memory wiki.
 *
 * The wiki is human-readable memory (summaries → topic pages) and lives on
 * **datahub**, not on the chat node. Hub talks to it via `/api/wiki` on that
 * origin — never by iframes of `/wiki` HTML.
 */

import type { MeshDenNode } from '@rivetos/types'
import { gatewayOrigin, isValidGatewayUrl } from './gateway-url.js'

/** Upgrade stale http:// LAN origins. Loopback stays http for local hooks. */
export function preferHttpsOrigin(origin: string): string {
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:') return origin
    const host = u.hostname.toLowerCase()
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return origin
    u.protocol = 'https:'
    return u.origin
  } catch {
    return origin
  }
}

/**
 * Normalize a user/settings value to a bare gateway origin.
 * Migrates legacy iframe URLs like `http://host/wiki` → `https://host`
 * (LAN). Returns '' for empty/invalid input.
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
    const ok = isValidGatewayUrl(origin) || isValidGatewayUrl(`${origin}/`)
    return ok ? preferHttpsOrigin(origin) : ''
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
  const origin = gatewayOrigin(hit.denUrl)
  return origin ? preferHttpsOrigin(origin) : null
}

/** Convert `[[slug]]` wiki links to in-app markdown links. */
export function wikiLinksToMarkdown(md: string): string {
  return md.replace(/\[\[([a-z0-9-]{1,80})\]\]/g, '[$1](/memory/$1)')
}

/** Stable heading id for in-article anchors / TOC. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

export interface TocEntry {
  level: 2 | 3
  text: string
  id: string
}

/** Extract ## / ### headings for a table of contents. */
export function tocFromMarkdown(md: string): TocEntry[] {
  const out: TocEntry[] = []
  for (const line of md.split('\n')) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const level = m[1].length === 2 ? 2 : 3
    const text = m[2].replace(/#+\s*$/, '').trim()
    if (!text) continue
    out.push({ level, text, id: headingId(text) })
  }
  return out
}

export function stalenessLabel(lastVerified?: string): {
  kind: 'fresh' | 'aging' | 'stale' | 'never'
  label: string
} {
  if (!lastVerified) return { kind: 'never', label: 'never verified' }
  const days = Math.floor((Date.now() - Date.parse(lastVerified)) / 86_400_000)
  if (!Number.isFinite(days)) return { kind: 'never', label: 'never verified' }
  if (days > 30) return { kind: 'stale', label: `${String(days)}d stale` }
  if (days > 7) return { kind: 'aging', label: `${String(days)}d` }
  return { kind: 'fresh', label: 'current' }
}
