/**
 * Boot order regression: the persist stores hydrate at import (empty
 * localStorage after a wipe), then hydrateSettingsIfEmpty() restores the
 * shell's settings.json. Without a rehydrate the stores keep defaults and
 * their first write clobbers the restored file.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'

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

const store = memoryStorage()
vi.stubGlobal('localStorage', store)

const file: Record<string, unknown> = {
  'rivethub.spaces': {
    state: {
      spaces: [{ id: 'work', name: 'Work', order: 0, createdAt: 1 }],
      membership: {},
    },
    version: 0,
  },
  'rivethub.preferences': { state: { autoScroll: false }, version: 0 },
  'rivethub.keyBindings': { state: { overrides: { 'new-chat': [] } }, version: 0 },
  'rivethub.theme': 'light',
}
const settingsSet = vi.fn(async (key: string, value: unknown) => {
  file[key] = value
})
vi.stubGlobal('rivetShell', {
  kind: 'electron',
  mtlsProxyPort: async () => 1234,
  openExternal: async () => {},
  clipboardWriteText: async () => {},
  clipboardReadText: async () => '',
  sendNotification: async () => {},
  setUnread: async () => {},
  settingsGetAll: async () => ({ ...file }),
  settingsSet,
})
afterAll(() => vi.unstubAllGlobals())

// Module init: every store hydrates from the (wiped) empty localStorage.
const { hydrateSettingsIfEmpty, installSettingsSync } = await import('./settings-sync.js')
const { rehydrateFileBackedStores } = await import('./settings-rehydrate.js')
const { useSpaces } = await import('../stores/spaces.js')
const { usePreferences } = await import('../stores/preferences.js')
const { useKeyBindings } = await import('../stores/key-bindings.js')
const { useTheme } = await import('../stores/theme.js')

describe('rehydrateFileBackedStores', () => {
  it('picks up the restored file so the first write keeps it', async () => {
    installSettingsSync()
    expect(usePreferences.getState().autoScroll).toBe(true)
    expect(useTheme.getState().preferenceExplicit).toBe(false)

    await hydrateSettingsIfEmpty()
    await rehydrateFileBackedStores()

    expect(useSpaces.getState().spaces.map((s) => s.id)).toEqual(['work'])
    expect(usePreferences.getState().autoScroll).toBe(false)
    expect(useKeyBindings.getState().overrides).toEqual({ 'new-chat': [] })
    // Theme is not a persist store; it re-reads rivethub.theme explicitly.
    expect(useTheme.getState().preference).toBe('light')
    expect(useTheme.getState().preferenceExplicit).toBe(true)

    // A write after boot persists on top of the restored data, not defaults.
    useSpaces.getState().addSpace('Play')
    const spaces = (file['rivethub.spaces'] as { state: { spaces: { name: string }[] } }).state
      .spaces
    expect(spaces.map((s) => s.name)).toEqual(['Work', 'Play'])
    expect(file['rivethub.theme']).toBe('light')
  })
})
