/**
 * Tests for settings-sync.ts — localStorage hydration and write-through
 * to the Electron shell's settings.json.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

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

beforeAll(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

describe('hydrateSettingsIfEmpty', () => {
  let hydrateSettingsIfEmpty: typeof import('./settings-sync.js')['hydrateSettingsIfEmpty']
  let mockShell: {
    kind: 'electron'
    mtlsProxyPort: () => Promise<number>
    openExternal: () => Promise<void>
    clipboardWriteText: () => Promise<void>
    clipboardReadText: () => Promise<string>
    sendNotification: () => Promise<void>
    setUnread: () => Promise<void>
    settingsGetAll?: () => Promise<Record<string, unknown>>
  }
  let originalRivetShell: unknown

  beforeAll(async () => {
    ;({ hydrateSettingsIfEmpty } = await import('./settings-sync.js'))
  })

  beforeEach(() => {
    // Mock the shell bridge with required methods (for shell-bridge validation)
    mockShell = {
      kind: 'electron',
      mtlsProxyPort: vi.fn(async () => 1234),
      openExternal: vi.fn(async () => {}),
      clipboardWriteText: vi.fn(async () => {}),
      clipboardReadText: vi.fn(async () => ''),
      sendNotification: vi.fn(async () => {}),
      setUnread: vi.fn(async () => {}),
    }
    originalRivetShell = (globalThis as { rivetShell?: unknown }).rivetShell
    ;(globalThis as { rivetShell: unknown }).rivetShell = mockShell

    // Clear localStorage
    localStorage.clear()
  })

  afterEach(() => {
    ;(globalThis as { rivetShell?: unknown }).rivetShell = originalRivetShell
    localStorage.clear()
  })

  it('hydrates from shell when localStorage is empty', async () => {
    mockShell.settingsGetAll = vi.fn(async () => ({
      'rivethub.baseUrl': 'https://restored.com',
      'rivethub.theme': 'dark',
    }))

    await hydrateSettingsIfEmpty()

    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://restored.com')
    expect(localStorage.getItem('rivethub.theme')).toBe('dark')
  })

  it('does not hydrate when both localStorage and file have settings', async () => {
    localStorage.setItem('rivethub.baseUrl', 'https://existing.com')

    mockShell.settingsGetAll = vi.fn(async () => ({
      'rivethub.baseUrl': 'https://restored.com',
    }))

    await hydrateSettingsIfEmpty()

    // Existing value is preserved (not overwritten)
    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://existing.com')
    // Shell was called to check if file has keys
    expect(mockShell.settingsGetAll).toHaveBeenCalled()
  })

  it('hydrates even if a migrated flag is set in the shell', async () => {
    // The shell file has a migrated flag, but localStorage is empty
    mockShell.settingsGetAll = vi.fn(async () => ({
      'rivethub.baseUrl': 'https://restored.com',
      'rivethub._migrated': true,
    }))

    await hydrateSettingsIfEmpty()

    // The file is the source of truth; the flag does not block restore
    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://restored.com')
  })

  it('no-ops when shell API is unavailable', async () => {
    ;(globalThis as { rivetShell?: unknown }).rivetShell = undefined

    await hydrateSettingsIfEmpty()

    // No crash, localStorage stays empty
    expect(localStorage.getItem('rivethub.baseUrl')).toBeNull()
  })

  it('handles shell API failure gracefully', async () => {
    mockShell.settingsGetAll = vi.fn(async () => {
      throw new Error('shell API failed')
    })

    await hydrateSettingsIfEmpty()

    // No crash, localStorage stays empty
    expect(localStorage.getItem('rivethub.baseUrl')).toBeNull()
  })

  it('seeds settings.json from localStorage when file is empty but localStorage has keys', async () => {
    // User has localStorage keys (manual restore or first run with existing data)
    localStorage.setItem('rivethub.baseUrl', 'https://existing.com')
    localStorage.setItem('rivethub.theme', 'dark')

    mockShell.settingsGetAll = vi.fn(async () => ({})) // File is empty
    mockShell.settingsSetAll = vi.fn(async () => {})

    await hydrateSettingsIfEmpty()

    // File was seeded from localStorage
    expect(mockShell.settingsSetAll).toHaveBeenCalledWith({
      'rivethub.baseUrl': 'https://existing.com',
      'rivethub.theme': 'dark',
    })
    // localStorage was NOT changed
    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://existing.com')
  })

  it('hydrates from file when localStorage is empty but file has keys', async () => {
    mockShell.settingsGetAll = vi.fn(async () => ({
      'rivethub.baseUrl': 'https://fromfile.com',
      'rivethub.theme': 'light',
    }))

    await hydrateSettingsIfEmpty()

    // localStorage was hydrated from file
    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://fromfile.com')
    expect(localStorage.getItem('rivethub.theme')).toBe('light')
  })

  it('no-ops when both localStorage and file have keys', async () => {
    localStorage.setItem('rivethub.baseUrl', 'https://local.com')
    mockShell.settingsGetAll = vi.fn(async () => ({
      'rivethub.baseUrl': 'https://file.com',
    }))
    mockShell.settingsSetAll = vi.fn(async () => {})

    await hydrateSettingsIfEmpty()

    // Neither was changed
    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://local.com')
    expect(mockShell.settingsSetAll).not.toHaveBeenCalled()
  })

  it('no-ops when both localStorage and file are empty', async () => {
    mockShell.settingsGetAll = vi.fn(async () => ({}))
    mockShell.settingsSetAll = vi.fn(async () => {})

    await hydrateSettingsIfEmpty()

    // Nothing happened
    expect(localStorage.getItem('rivethub.baseUrl')).toBeNull()
    expect(mockShell.settingsSetAll).not.toHaveBeenCalled()
  })
})

describe('installSettingsSync', () => {
  let installSettingsSync: typeof import('./settings-sync.js')['installSettingsSync']
  let mockShell: {
    kind: 'electron'
    mtlsProxyPort: () => Promise<number>
    openExternal: () => Promise<void>
    clipboardWriteText: () => Promise<void>
    clipboardReadText: () => Promise<string>
    sendNotification: () => Promise<void>
    setUnread: () => Promise<void>
    settingsSet?: (key: string, value: unknown) => Promise<void>
    settingsRemove?: (key: string) => Promise<void>
  }
  let originalRivetShell: unknown
  let originalSetItem: typeof localStorage.setItem
  let originalRemoveItem: typeof localStorage.removeItem

  beforeAll(async () => {
    ;({ installSettingsSync } = await import('./settings-sync.js'))
  })

  beforeEach(() => {
    mockShell = {
      kind: 'electron',
      mtlsProxyPort: vi.fn(async () => 1234),
      openExternal: vi.fn(async () => {}),
      clipboardWriteText: vi.fn(async () => {}),
      clipboardReadText: vi.fn(async () => ''),
      sendNotification: vi.fn(async () => {}),
      setUnread: vi.fn(async () => {}),
      settingsSet: vi.fn(async () => {}),
      settingsRemove: vi.fn(async () => {}),
    }
    originalRivetShell = (globalThis as { rivetShell?: unknown }).rivetShell
    ;(globalThis as { rivetShell: unknown }).rivetShell = mockShell

    // Save original localStorage methods
    originalSetItem = localStorage.setItem.bind(localStorage)
    originalRemoveItem = localStorage.removeItem.bind(localStorage)

    localStorage.clear()
  })

  afterEach(() => {
    ;(globalThis as { rivetShell?: unknown }).rivetShell = originalRivetShell

    // Restore original localStorage methods
    localStorage.setItem = originalSetItem
    localStorage.removeItem = originalRemoveItem

    localStorage.clear()
  })

  it('persists rivethub.* writes to the shell', () => {
    installSettingsSync()

    localStorage.setItem('rivethub.baseUrl', 'https://test.com')

    // Shell was called
    expect(mockShell.settingsSet).toHaveBeenCalledWith('rivethub.baseUrl', 'https://test.com')
  })

  it('persists rivethub.agent.* writes to the shell', () => {
    installSettingsSync()

    const sessionData = JSON.stringify({ sessionId: '123', timestamp: 456 })
    localStorage.setItem('rivethub.agent.lastSession', sessionData)

    // Shell was called with parsed JSON
    expect(mockShell.settingsSet).toHaveBeenCalledWith('rivethub.agent.lastSession', {
      sessionId: '123',
      timestamp: 456,
    })
  })

  it('does not persist non-rivethub keys to the shell', () => {
    installSettingsSync()

    localStorage.setItem('some.other.key', 'value')

    // Shell was NOT called
    expect(mockShell.settingsSet).not.toHaveBeenCalled()
  })

  it('persists removes to the shell', () => {
    installSettingsSync()

    localStorage.removeItem('rivethub.baseUrl')

    // Shell was called
    expect(mockShell.settingsRemove).toHaveBeenCalledWith('rivethub.baseUrl')
  })

  it('does not persist non-rivethub removes to the shell', () => {
    installSettingsSync()

    localStorage.removeItem('some.other.key')

    // Shell was NOT called
    expect(mockShell.settingsRemove).not.toHaveBeenCalled()
  })

  it('no-ops when shell API is unavailable', () => {
    ;(globalThis as { rivetShell?: unknown }).rivetShell = undefined

    installSettingsSync()

    // No crash, writes still work locally
    localStorage.setItem('rivethub.baseUrl', 'https://test.com')
    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://test.com')
  })
})
