import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// createJSONStorage(() => localStorage) runs at store-module evaluation.
// Stub before that import (vi.hoisted runs before ESM imports).
vi.hoisted(() => {
  const m = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } satisfies Storage)
})

afterAll(() => vi.unstubAllGlobals())

const { useSidebarPrefs } = await import('./sidebar-prefs.js')

describe('sidebar prefs store', () => {
  beforeEach(() => {
    useSidebarPrefs.setState({
      conversationsCollapsed: false,
      railCollapsed: false,
      drawerOpen: false,
      historyOpen: false,
    })
    localStorage.removeItem('rivethub.sidebar')
  })

  it('defaults to both expanded', () => {
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
    expect(useSidebarPrefs.getState().railCollapsed).toBe(false)
    expect(useSidebarPrefs.getState().drawerOpen).toBe(false)
    expect(useSidebarPrefs.getState().historyOpen).toBe(false)
  })

  it('sets drawerOpen without persisting it', () => {
    useSidebarPrefs.getState().setDrawerOpen(true)
    expect(useSidebarPrefs.getState().drawerOpen).toBe(true)
    const raw = localStorage.getItem('rivethub.sidebar')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '') as { state: Record<string, unknown> }
    expect(parsed.state.drawerOpen).toBeUndefined()
    useSidebarPrefs.getState().setDrawerOpen(false)
    expect(useSidebarPrefs.getState().drawerOpen).toBe(false)
  })

  it('sets historyOpen without persisting it', () => {
    useSidebarPrefs.getState().setHistoryOpen(true)
    expect(useSidebarPrefs.getState().historyOpen).toBe(true)
    const raw = localStorage.getItem('rivethub.sidebar')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '') as { state: Record<string, unknown> }
    expect(parsed.state.historyOpen).toBeUndefined()
    useSidebarPrefs.getState().setHistoryOpen(false)
    expect(useSidebarPrefs.getState().historyOpen).toBe(false)
  })

  it('rehydrate ignores historyOpen in the blob', async () => {
    expect(useSidebarPrefs.getState().historyOpen).toBe(false)
    localStorage.setItem(
      'rivethub.sidebar',
      JSON.stringify({
        state: { conversationsCollapsed: false, railCollapsed: false, historyOpen: true },
        version: 2,
      }),
    )
    await useSidebarPrefs.persist.rehydrate()
    expect(useSidebarPrefs.getState().historyOpen).toBe(false)
  })

  it('rehydrate ignores drawerOpen in the blob', async () => {
    expect(useSidebarPrefs.getState().drawerOpen).toBe(false)
    localStorage.setItem(
      'rivethub.sidebar',
      JSON.stringify({
        state: { conversationsCollapsed: false, railCollapsed: false, drawerOpen: true },
        version: 2,
      }),
    )
    await useSidebarPrefs.persist.rehydrate()
    expect(useSidebarPrefs.getState().drawerOpen).toBe(false)
  })

  it('sets conversationsCollapsed', () => {
    useSidebarPrefs.getState().setConversationsCollapsed(true)
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(true)
    useSidebarPrefs.getState().setConversationsCollapsed(false)
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
  })

  it('sets railCollapsed', () => {
    useSidebarPrefs.getState().setRailCollapsed(true)
    expect(useSidebarPrefs.getState().railCollapsed).toBe(true)
    useSidebarPrefs.getState().setRailCollapsed(false)
    expect(useSidebarPrefs.getState().railCollapsed).toBe(false)
  })

  it('openConversation re-shows the pane', () => {
    useSidebarPrefs.getState().setConversationsCollapsed(true)
    useSidebarPrefs.getState().setRailCollapsed(true)
    useSidebarPrefs.getState().openConversation()
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
    // Rail collapse is independent — opening a thread does not expand the rail.
    expect(useSidebarPrefs.getState().railCollapsed).toBe(true)
  })

  it('persists both flags and rehydrates', async () => {
    useSidebarPrefs.getState().setConversationsCollapsed(true)
    useSidebarPrefs.getState().setRailCollapsed(true)
    const raw = localStorage.getItem('rivethub.sidebar')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '') as {
      state: {
        conversationsCollapsed: boolean
        railCollapsed: boolean
      }
      version: number
    }
    expect(parsed.state.conversationsCollapsed).toBe(true)
    expect(parsed.state.railCollapsed).toBe(true)
    expect(parsed.version).toBe(2)

    // setState would persist `false` over the blob; restore it to simulate a reload.
    useSidebarPrefs.setState({ conversationsCollapsed: false, railCollapsed: false })
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
    expect(useSidebarPrefs.getState().railCollapsed).toBe(false)
    localStorage.setItem('rivethub.sidebar', raw ?? '')

    await useSidebarPrefs.persist.rehydrate()
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(true)
    expect(useSidebarPrefs.getState().railCollapsed).toBe(true)
  })

  it('v1 blob with conversationsCollapsed true rehydrates to false', async () => {
    localStorage.setItem(
      'rivethub.sidebar',
      JSON.stringify({
        state: { conversationsCollapsed: true, railCollapsed: true },
        version: 1,
      }),
    )
    await useSidebarPrefs.persist.rehydrate()
    // #628 list-disclosure must not hide the pane after the meaning change.
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(false)
    expect(useSidebarPrefs.getState().railCollapsed).toBe(true)
  })

  it('v2 blob keeps conversationsCollapsed', async () => {
    localStorage.setItem(
      'rivethub.sidebar',
      JSON.stringify({
        state: { conversationsCollapsed: true, railCollapsed: false },
        version: 2,
      }),
    )
    await useSidebarPrefs.persist.rehydrate()
    expect(useSidebarPrefs.getState().conversationsCollapsed).toBe(true)
    expect(useSidebarPrefs.getState().railCollapsed).toBe(false)
  })
})
