/**
 * Connection state: which node's gateway this client talks to. Defaults to
 * the origin that served the app (den-server serves us, so same-origin just
 * works tokenless on the LAN). The 4h node switcher grows a roster here;
 * for now it's a single endpoint + optional bearer token.
 *
 * Token lives in sessionStorage (never bundled, gone when the tab dies);
 * baseUrl override persists in localStorage.
 */

import { create } from 'zustand'
import { RivetGateway } from '@rivetos/gateway-client'

const BASE_KEY = 'rivethub.baseUrl'
const TOKEN_KEY = 'rivethub.gatewayToken'

interface ConnectionState {
  baseUrl: string
  token?: string
  gateway: RivetGateway
  setConnection: (baseUrl: string, token?: string) => void
}

function defaultBaseUrl(): string {
  const stored = localStorage.getItem(BASE_KEY)
  if (stored) return stored
  return window.location.origin
}

function makeGateway(baseUrl: string, token?: string): RivetGateway {
  return new RivetGateway({ baseUrl, token, authMode: token ? 'bearer' : 'none' })
}

export const useConnection = create<ConnectionState>((set) => {
  const baseUrl = defaultBaseUrl()
  const token = sessionStorage.getItem(TOKEN_KEY) ?? undefined
  return {
    baseUrl,
    token,
    gateway: makeGateway(baseUrl, token),
    setConnection(nextBaseUrl: string, nextToken?: string): void {
      localStorage.setItem(BASE_KEY, nextBaseUrl)
      if (nextToken) sessionStorage.setItem(TOKEN_KEY, nextToken)
      else sessionStorage.removeItem(TOKEN_KEY)
      set({
        baseUrl: nextBaseUrl,
        token: nextToken,
        gateway: makeGateway(nextBaseUrl, nextToken),
      })
    },
  }
})
