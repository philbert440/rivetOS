/**
 * Connection state: which node's gateway this client talks to, plus the
 * saved roster for the 4h node switcher. Defaults to the origin that served
 * the app (den-server serves us, so same-origin just works tokenless on the
 * LAN).
 *
 * Storage split, deliberate: the roster ({name, baseUrl}[]) and the active
 * baseUrl persist in localStorage; tokens live in sessionStorage keyed per
 * node (never bundled, gone when the tab dies). Switching nodes re-points
 * the RivetGateway — chat/notification stores watch the endpoint identity
 * and reset themselves (per-gateway session ids, #299).
 */

import { create } from 'zustand'
import { RivetGateway } from '@rivetos/gateway-client'

const BASE_KEY = 'rivethub.baseUrl'
const ROSTER_KEY = 'rivethub.roster'
const TOKEN_PREFIX = 'rivethub.token.'

export interface RosterNode {
  name: string
  baseUrl: string
}

interface ConnectionState {
  baseUrl: string
  token?: string
  gateway: RivetGateway
  roster: RosterNode[]
  setConnection: (baseUrl: string, token?: string) => void
  /** Switch to a roster node (its saved token rides along). */
  switchTo: (baseUrl: string) => void
  addNode: (node: RosterNode) => void
  removeNode: (baseUrl: string) => void
}

const normalize = (url: string): string => url.trim().replace(/\/+$/, '')

/** Same guard den-server's denUrlFor applies: http(s) with a host, nothing
 *  else — a poisoned roster/mesh entry must not re-point the app (#304). */
export function isValidGatewayUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== ''
  } catch {
    return false
  }
}

const ROSTER_MAX = 20

function tokenFor(baseUrl: string): string | undefined {
  return sessionStorage.getItem(TOKEN_PREFIX + baseUrl) ?? undefined
}

/** One-time migration: pre-4h stored a single token under
 *  'rivethub.gatewayToken'; adopt it for the active node (#304). */
function migrateLegacyToken(baseUrl: string): void {
  const legacy = sessionStorage.getItem('rivethub.gatewayToken')
  if (legacy && !sessionStorage.getItem(TOKEN_PREFIX + baseUrl)) {
    sessionStorage.setItem(TOKEN_PREFIX + baseUrl, legacy)
  }
  if (legacy) sessionStorage.removeItem('rivethub.gatewayToken')
}

function loadRoster(): RosterNode[] {
  try {
    const raw = localStorage.getItem(ROSTER_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const nodes: RosterNode[] = []
    for (const n of parsed) {
      if (typeof n !== 'object' || n === null) continue
      const { name, baseUrl } = n as RosterNode
      if (typeof name !== 'string' || name.trim() === '') continue
      if (typeof baseUrl !== 'string' || !isValidGatewayUrl(normalize(baseUrl))) continue
      const url = normalize(baseUrl)
      if (seen.has(url)) continue // legacy trailing-slash dupes collapse here
      seen.add(url)
      nodes.push({ name, baseUrl: url })
      if (nodes.length >= ROSTER_MAX) break
    }
    return nodes
  } catch {
    return []
  }
}

function saveRoster(roster: RosterNode[]): void {
  localStorage.setItem(ROSTER_KEY, JSON.stringify(roster))
}

function makeGateway(baseUrl: string, token?: string): RivetGateway {
  return new RivetGateway({ baseUrl, token, authMode: token ? 'bearer' : 'none' })
}

/** The served origin only counts as a gateway when it's http(s) — under the
 *  Tauri desktop shell it's tauri://localhost (no gateway there), so the app
 *  starts unconfigured and prompts for a node (#4j smoke). */
function defaultBaseUrl(): string {
  const stored = localStorage.getItem(BASE_KEY)
  if (stored) return normalize(stored)
  const origin = normalize(window.location.origin)
  return isValidGatewayUrl(origin) ? origin : ''
}

export const useConnection = create<ConnectionState>((set, get) => {
  const baseUrl = defaultBaseUrl()
  if (baseUrl) migrateLegacyToken(baseUrl)
  const token = tokenFor(baseUrl)
  return {
    baseUrl,
    token,
    gateway: makeGateway(baseUrl, token),
    roster: loadRoster(),

    setConnection(rawUrl: string, nextToken?: string): void {
      const nextBaseUrl = normalize(rawUrl)
      localStorage.setItem(BASE_KEY, nextBaseUrl)
      if (nextToken) sessionStorage.setItem(TOKEN_PREFIX + nextBaseUrl, nextToken)
      else sessionStorage.removeItem(TOKEN_PREFIX + nextBaseUrl)
      set({
        baseUrl: nextBaseUrl,
        token: nextToken,
        gateway: makeGateway(nextBaseUrl, nextToken),
      })
    },

    switchTo(rawUrl: string): void {
      const nextBaseUrl = normalize(rawUrl)
      // Defense in depth: only http(s) roster members are switchable — the
      // UI already restricts this, the store enforces it (#304 review).
      if (!isValidGatewayUrl(nextBaseUrl)) return
      if (!get().roster.some((n) => n.baseUrl === nextBaseUrl)) return
      const nextToken = tokenFor(nextBaseUrl)
      localStorage.setItem(BASE_KEY, nextBaseUrl)
      set({
        baseUrl: nextBaseUrl,
        token: nextToken,
        gateway: makeGateway(nextBaseUrl, nextToken),
      })
    },

    addNode(node: RosterNode): void {
      if (!isValidGatewayUrl(normalize(node.baseUrl))) return
      const roster = [
        ...get().roster.filter((n) => normalize(n.baseUrl) !== normalize(node.baseUrl)),
        { name: node.name, baseUrl: normalize(node.baseUrl) },
      ].slice(-ROSTER_MAX)
      saveRoster(roster)
      set({ roster })
    },

    removeNode(rawUrl: string): void {
      const url = normalize(rawUrl)
      const roster = get().roster.filter((n) => normalize(n.baseUrl) !== url)
      saveRoster(roster)
      // Removed node ⇒ its credential goes too (#304 review).
      sessionStorage.removeItem(TOKEN_PREFIX + url)
      set({ roster })
    },
  }
})
