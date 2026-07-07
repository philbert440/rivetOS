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

function tokenFor(baseUrl: string): string | undefined {
  return sessionStorage.getItem(TOKEN_PREFIX + baseUrl) ?? undefined
}

function loadRoster(): RosterNode[] {
  try {
    const raw = localStorage.getItem(ROSTER_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (n): n is RosterNode =>
        typeof n === 'object' &&
        n !== null &&
        typeof (n as RosterNode).name === 'string' &&
        typeof (n as RosterNode).baseUrl === 'string',
    )
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

export const useConnection = create<ConnectionState>((set, get) => {
  const baseUrl = normalize(localStorage.getItem(BASE_KEY) ?? window.location.origin)
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
      const nextToken = tokenFor(nextBaseUrl)
      localStorage.setItem(BASE_KEY, nextBaseUrl)
      set({
        baseUrl: nextBaseUrl,
        token: nextToken,
        gateway: makeGateway(nextBaseUrl, nextToken),
      })
    },

    addNode(node: RosterNode): void {
      const roster = [
        ...get().roster.filter((n) => normalize(n.baseUrl) !== normalize(node.baseUrl)),
        { name: node.name, baseUrl: normalize(node.baseUrl) },
      ]
      saveRoster(roster)
      set({ roster })
    },

    removeNode(rawUrl: string): void {
      const roster = get().roster.filter((n) => normalize(n.baseUrl) !== normalize(rawUrl))
      saveRoster(roster)
      set({ roster })
    },
  }
})
