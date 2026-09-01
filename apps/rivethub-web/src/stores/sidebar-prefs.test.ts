import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.stubGlobal('localStorage', memoryStorage())
afterAll(() => vi.unstubAllGlobals())

const { useSidebarPrefs } = await import('./sidebar-prefs.js')

describe('sidebar prefs store', () => {
  beforeEach(() => {
    useSidebarPrefs.setState({ conversationsCollapsed: false })
    localStorage.removeItem('rivethub.sidebar')
  })

  it('defaults to expanded', () => {
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
  })

  it('sets collapsed', () => {
    useSidebarPrefs.getState().setConversationsCollapsed(true)
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(true)
    useSidebarPrefs.getState().setConversationsCollapsed(false)
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
  })

  it('persists collapsed and rehydrates', async () => {
    useSidebarPrefs.getState().setConversationsCollapsed(true)
    const raw = localStorage.getItem('rivethub.sidebar')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw ?? '').state.conversationsCollapsed).toBe(true)

    // setState would persist `false` over the blob; restore it to simulate a reload.
    useSidebarPrefs.setState({ conversationsCollapsed: false })
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
    localStorage.setItem('rivethub.sidebar', raw ?? '')

    await useSidebarPrefs.persist.rehydrate()
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(true)
  })
})
