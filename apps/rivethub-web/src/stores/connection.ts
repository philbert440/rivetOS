/**
 * Connection state: which node's gateway this client talks to, plus the
 * saved roster for the node switcher. Defaults to the origin that served
 * the app when that origin is http(s).
 *
 * Auth is Rivet CA device client certificates (mTLS). Browsers present the
 * enrolled device cert from the OS/browser store — there is no bearer token.
 * Unenrolled devices cannot complete the TLS handshake on a correctly
 * configured node.
 *
 * Storage: roster + active baseUrl in localStorage. Legacy rivethub.token.*
 * sessionStorage keys are cleared on setConnection.
 */

import { create } from 'zustand'
import { RivetGateway } from '@rivetos/gateway-client'
import { isValidGatewayUrl } from '../lib/gateway-url.js'
import { rememberRemoteUi } from '../lib/remote-ui.js'

export { isValidGatewayUrl } from '../lib/gateway-url.js'

const BASE_KEY = 'rivethub.baseUrl'
const ROSTER_KEY = 'rivethub.roster'
const TOKEN_PREFIX = 'rivethub.token.'

export interface RosterNode {
  name: string
  baseUrl: string
}

interface ConnectionState {
  baseUrl: string
  gateway: RivetGateway
  roster: RosterNode[]
  setConnection: (baseUrl: string) => void
  /** Switch to a roster node. */
  switchTo: (baseUrl: string) => void
  addNode: (node: RosterNode) => void
  removeNode: (baseUrl: string) => void
}

const normalize = (url: string): string => url.trim().replace(/\/+$/, '')

const ROSTER_MAX = 20

/** @deprecated Bearer tokens removed — always undefined. */
export function tokenFor(_baseUrl: string): string | undefined {
  return undefined
}

function scrubLegacyTokens(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k?.startsWith(TOKEN_PREFIX) || k === 'rivethub.gatewayToken') {
        sessionStorage.removeItem(k)
      }
    }
  } catch {
    /* private mode */
  }
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
      if (seen.has(url)) continue
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

function makeGateway(baseUrl: string): RivetGateway {
  return new RivetGateway({ baseUrl, authMode: 'mtls' })
}

function defaultBaseUrl(): string {
  const stored = localStorage.getItem(BASE_KEY)
  if (stored) {
    const s = normalize(stored)
    return isValidGatewayUrl(s) ? s : ''
  }
  const origin = normalize(window.location.origin)
  return isValidGatewayUrl(origin) ? origin : ''
}

export const useConnection = create<ConnectionState>((set, get) => {
  const baseUrl = defaultBaseUrl()
  scrubLegacyTokens()
  return {
    baseUrl,
    gateway: makeGateway(baseUrl),
    roster: loadRoster(),

    setConnection(rawUrl: string): void {
      const nextBaseUrl = normalize(rawUrl)
      localStorage.setItem(BASE_KEY, nextBaseUrl)
      scrubLegacyTokens()
      if (isValidGatewayUrl(nextBaseUrl)) rememberRemoteUi(localStorage, nextBaseUrl)
      set({
        baseUrl: nextBaseUrl,
        gateway: makeGateway(nextBaseUrl),
      })
    },

    switchTo(rawUrl: string): void {
      const nextBaseUrl = normalize(rawUrl)
      if (!isValidGatewayUrl(nextBaseUrl)) return
      if (!get().roster.some((n) => n.baseUrl === nextBaseUrl)) return
      localStorage.setItem(BASE_KEY, nextBaseUrl)
      if (isValidGatewayUrl(nextBaseUrl)) rememberRemoteUi(localStorage, nextBaseUrl)
      set({
        baseUrl: nextBaseUrl,
        gateway: makeGateway(nextBaseUrl),
      })
    },

    addNode(node: RosterNode): void {
      if (!isValidGatewayUrl(normalize(node.baseUrl))) return
      const url = normalize(node.baseUrl)
      const existing = get().roster.find((n) => normalize(n.baseUrl) === url)
      const roster = [
        ...get().roster.filter((n) => normalize(n.baseUrl) !== url),
        { name: existing?.name ?? node.name, baseUrl: url },
      ].slice(-ROSTER_MAX)
      saveRoster(roster)
      set({ roster })
    },

    removeNode(rawUrl: string): void {
      const url = normalize(rawUrl)
      const roster = get().roster.filter((n) => normalize(n.baseUrl) !== url)
      saveRoster(roster)
      set({ roster })
    },
  }
})
