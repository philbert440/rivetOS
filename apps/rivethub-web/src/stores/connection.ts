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
import { transportBase } from '../lib/mtls-proxy.js'

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
  /**
   * Bumped whenever the gateway is swapped onto a new transport (desktop
   * mTLS pipe resolving) WITHOUT baseUrl changing. Long-lived sockets that
   * reconnect on baseUrl must include this in their deps, or they stay on
   * the pre-pipe gateway (which can never authenticate) for the session.
   */
  transportEpoch: number
  roster: RosterNode[]
  setConnection: (baseUrl: string) => void
  /** Switch to a roster node. */
  switchTo: (baseUrl: string) => void
  addNode: (node: RosterNode) => void
  /**
   * Edit a saved node in place (position kept). If the edit collides with
   * another row's URL, that other row is absorbed — two rows for one
   * endpoint would fork baseUrl-keyed state. Editing the ACTIVE node's URL
   * repoints the live connection.
   */
  updateNode: (oldBaseUrl: string, node: RosterNode) => void
  removeNode: (baseUrl: string) => void
}

const normalize = (url: string): string => url.trim().replace(/\/+$/, '')

const ROSTER_MAX = 20

/** Bearer tokens removed — always returns undefined. */
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

/**
 * Desktop mTLS (#491): swap an https gateway for its loopback identity pipe
 * once the shell resolves one. The direct gateway set synchronously covers
 * the await gap (and stays when the bridge declines — browsers, http nodes).
 */
function upgradeTransport(
  baseUrl: string,
  set: (partial: Partial<ConnectionState>) => void,
  get: () => ConnectionState,
  attempt = 0,
): void {
  void transportBase(baseUrl).then((transport) => {
    if (get().baseUrl !== baseUrl) return // switched nodes while resolving
    if (transport === baseUrl) {
      // Tauri + https with no identity imported yet: keep watching (10 min)
      // so an identity dropped in mid-run engages without a relaunch or a
      // node switch — mirrors the Rust side's no-failure-caching.
      if ('__TAURI__' in window && baseUrl.startsWith('https://') && attempt < 40) {
        setTimeout(() => {
          if (get().baseUrl === baseUrl) upgradeTransport(baseUrl, set, get, attempt + 1)
        }, 15_000)
      }
      return
    }
    set({ gateway: makeGateway(transport), transportEpoch: get().transportEpoch + 1 })
  })
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
  queueMicrotask(() => {
    upgradeTransport(baseUrl, set, get)
  })
  return {
    baseUrl,
    gateway: makeGateway(baseUrl),
    transportEpoch: 0,
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
      upgradeTransport(nextBaseUrl, set, get)
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
      upgradeTransport(nextBaseUrl, set, get)
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

    updateNode(oldBaseUrl: string, node: RosterNode): void {
      const from = normalize(oldBaseUrl)
      const to = normalize(node.baseUrl)
      if (!isValidGatewayUrl(to)) return
      const name = node.name.trim()
      if (!name) return
      const roster = get().roster
      const idx = roster.findIndex((n) => normalize(n.baseUrl) === from)
      if (idx === -1) return
      const next = roster
        // absorb any OTHER row already at the target URL — see interface doc
        .filter((n, i) => i === idx || normalize(n.baseUrl) !== to)
        .map((n) => (normalize(n.baseUrl) === from ? { name, baseUrl: to } : n))
      saveRoster(next)
      set({ roster: next })
      if (get().baseUrl === from && to !== from) {
        localStorage.setItem(BASE_KEY, to)
        rememberRemoteUi(localStorage, to)
        set({ baseUrl: to, gateway: makeGateway(to) })
        upgradeTransport(to, set, get)
      }
    },

    removeNode(rawUrl: string): void {
      const url = normalize(rawUrl)
      const roster = get().roster.filter((n) => normalize(n.baseUrl) !== url)
      saveRoster(roster)
      set({ roster })
    },
  }
})
