/**
 * Boot order: the connection store module-evals before settings hydrate
 * writes adopted keys into localStorage. Storage-only tests cannot catch
 * a live store left at baseUrl '' / roster [].
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hydrateSettingsIfEmpty } from '../lib/settings-sync.js'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

const ADOPTED = {
  'rivethub.baseUrl': 'https://localhost:5174',
  'rivethub.roster': [{ name: 'rivet-grok', baseUrl: 'https://localhost:5174' }],
}

let useConnection: (typeof import('./connection.js'))['useConnection']

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('window', { location: { origin: 'app://bundle', protocol: 'app:' } })
  ;({ useConnection } = await import('./connection.js'))
})

function electronShell(settings: Record<string, unknown>): void {
  ;(globalThis as { rivetShell: unknown }).rivetShell = {
    kind: 'electron',
    mtlsProxyPort: vi.fn(async () => 1234),
    openExternal: vi.fn(async () => {}),
    clipboardWriteText: vi.fn(async () => {}),
    clipboardReadText: vi.fn(async () => ''),
    sendNotification: vi.fn(async () => {}),
    setUnread: vi.fn(async () => {}),
    settingsGetAll: vi.fn(async () => settings),
  }
}

function resetLiveStore(): void {
  useConnection.getState().setConnection('')
  for (const n of [...useConnection.getState().roster]) {
    useConnection.getState().removeNode(n.baseUrl)
  }
  localStorage.clear()
  sessionStorage.clear()
}

beforeEach(() => {
  resetLiveStore()
})

afterEach(() => {
  delete (globalThis as { rivetShell?: unknown }).rivetShell
  localStorage.clear()
  sessionStorage.clear()
})

describe('hydrateFromStorage boot order', () => {
  it('fills the live store after settings hydrate from adopted keys', async () => {
    expect(useConnection.getState().baseUrl).toBe('')
    expect(useConnection.getState().roster).toEqual([])

    electronShell(ADOPTED)
    await hydrateSettingsIfEmpty()

    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://localhost:5174')
    expect(JSON.parse(localStorage.getItem('rivethub.roster') ?? 'null')).toEqual(
      ADOPTED['rivethub.roster'],
    )
    // Storage is not the store: module init already ran against empty LS.
    expect(useConnection.getState().baseUrl).toBe('')
    expect(useConnection.getState().roster).toEqual([])

    useConnection.getState().hydrateFromStorage()

    expect(useConnection.getState().baseUrl).toBe('https://localhost:5174')
    expect(useConnection.getState().roster).toEqual(ADOPTED['rivethub.roster'])
  })

  it('fills missing connection keys when localStorage already has a theme', async () => {
    localStorage.setItem('rivethub.theme', 'dark')
    electronShell({
      ...ADOPTED,
      'rivethub.theme': 'light',
    })
    await hydrateSettingsIfEmpty()

    expect(localStorage.getItem('rivethub.theme')).toBe('dark')
    expect(useConnection.getState().baseUrl).toBe('')
    expect(useConnection.getState().roster).toEqual([])

    useConnection.getState().hydrateFromStorage()

    expect(useConnection.getState().baseUrl).toBe('https://localhost:5174')
    expect(useConnection.getState().roster).toEqual(ADOPTED['rivethub.roster'])
    expect(localStorage.getItem('rivethub.theme')).toBe('dark')
  })

  it('does not clobber a live baseUrl or roster', () => {
    const live = { name: 'alpha', baseUrl: 'https://192.0.2.10:5174' }
    useConnection.getState().setConnection(live.baseUrl)
    useConnection.getState().addNode(live)
    localStorage.setItem('rivethub.baseUrl', 'https://localhost:5174')
    localStorage.setItem('rivethub.roster', JSON.stringify(ADOPTED['rivethub.roster']))

    useConnection.getState().hydrateFromStorage()

    expect(useConnection.getState().baseUrl).toBe(live.baseUrl)
    expect(useConnection.getState().roster).toEqual([live])
  })
})
