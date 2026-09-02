import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RivetShell } from './shell-bridge.js'
import type { OmarchySnapshot } from '../stores/theme.js'
import { parseOmarchyColors } from './omarchy-theme.js'

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

const osakaJadeToml = [
  'mode = "dark"',
  'accent = "#509475"',
  'selection = "#32473b"',
  'background = "#111c18"',
  'foreground = "#c1c497"',
  'red = "#ff5345"',
  'yellow = "#459451"',
  'green = "#549e6a"',
  'cyan = "#2dd5b7"',
  'blue = "#509475"',
  'magenta = "#d2689c"',
].join('\n')

function fakeStore(initial: OmarchySnapshot | null = null) {
  let omarchy = initial
  const setOmarchy = vi.fn((v: OmarchySnapshot | null) => {
    omarchy = v
  })
  return {
    setOmarchy,
    getState: () => ({ omarchy, setOmarchy }),
  }
}

type ConfigRow = {
  kind: 'omarchy' | 'ghostty' | 'alacritty' | 'kitty' | 'windows-terminal'
  path: string
  text: string
  includes: Record<string, string>
  themeName?: string
  colorsToml?: string
}

function fakeShell(configs: ConfigRow[]): Pick<RivetShell, 'readTerminalConfigs'> {
  return {
    readTerminalConfigs: vi.fn(async () => configs),
  }
}

describe('syncOmarchyTheme', () => {
  let syncOmarchyTheme: (typeof import('./omarchy-sync.js'))['syncOmarchyTheme']
  let installOmarchySync: (typeof import('./omarchy-sync.js'))['installOmarchySync']

  beforeAll(async () => {
    ;({ syncOmarchyTheme, installOmarchySync } = await import('./omarchy-sync.js'))
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { rivetShell?: unknown }).rivetShell
  })

  it('sets colors from the omarchy entry', async () => {
    const store = fakeStore()
    const shell = fakeShell([
      {
        kind: 'omarchy',
        path: '/theme/alacritty.toml',
        text: '',
        includes: {},
        themeName: 'osaka-jade',
        colorsToml: osakaJadeToml,
      },
    ])
    expect(await syncOmarchyTheme(shell as RivetShell, store)).toBe(true)
    expect(store.setOmarchy).toHaveBeenCalledTimes(1)
    const snap = store.getState().omarchy
    expect(snap?.name).toBe('osaka-jade')
    expect(snap?.colors).toEqual(parseOmarchyColors(osakaJadeToml))
  })

  it('skips when the bridge or colors.toml is absent', async () => {
    const store = fakeStore()
    expect(await syncOmarchyTheme({} as RivetShell, store)).toBe(false)
    expect(
      await syncOmarchyTheme(
        fakeShell([{ kind: 'ghostty', path: '/g', text: '', includes: {} }]) as RivetShell,
        store,
      ),
    ).toBe(false)
    expect(
      await syncOmarchyTheme(
        fakeShell([
          { kind: 'omarchy', path: '/t', text: 'x', includes: {}, themeName: 'x' },
        ]) as RivetShell,
        store,
      ),
    ).toBe(false)
    expect(store.setOmarchy).not.toHaveBeenCalled()
  })

  it('dedupes an unchanged snapshot', async () => {
    const colors = parseOmarchyColors(osakaJadeToml)!
    const store = fakeStore({ name: 'osaka-jade', colors })
    const shell = fakeShell([
      {
        kind: 'omarchy',
        path: '/theme/alacritty.toml',
        text: '',
        includes: {},
        themeName: 'osaka-jade',
        colorsToml: osakaJadeToml,
      },
    ])
    expect(await syncOmarchyTheme(shell as RivetShell, store)).toBe(true)
    expect(store.setOmarchy).not.toHaveBeenCalled()
  })

  it('throttles focus to ≥ 2s', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => [
      {
        kind: 'omarchy' as const,
        path: '/theme/colors.toml',
        text: '',
        includes: {},
        themeName: 'osaka-jade',
        colorsToml: osakaJadeToml,
      },
    ])
    const shell: RivetShell = {
      kind: 'electron',
      mtlsProxyPort: async () => 1,
      openExternal: async () => undefined,
      clipboardWriteText: async () => undefined,
      clipboardReadText: async () => '',
      sendNotification: async () => undefined,
      setUnread: async () => undefined,
      readTerminalConfigs: read,
    }
    ;(globalThis as { rivetShell?: RivetShell }).rivetShell = shell

    const listeners: Array<() => void> = []
    const win = {
      addEventListener(_type: string, listener: () => void): void {
        listeners.push(listener)
      },
    }
    installOmarchySync(win)
    await Promise.resolve()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)

    listeners.forEach((fn) => fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)

    listeners.forEach((fn) => fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(2000)
    listeners.forEach((fn) => fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(3)
  })
})
