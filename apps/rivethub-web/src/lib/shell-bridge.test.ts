import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDesktopShell, rivetShell, type RivetShell } from './shell-bridge.js'
import { copyTextToClipboard, hasTauriClipboard, readTextFromClipboard } from './clipboard.js'
import { openExternal } from './open-external.js'

function stubShell(): RivetShell {
  return {
    kind: 'electron',
    mtlsProxyPort: vi.fn(async () => 12345),
    openExternal: vi.fn(async () => undefined),
    clipboardWriteText: vi.fn(async () => undefined),
    clipboardReadText: vi.fn(async () => 'from-shell'),
    sendNotification: vi.fn(async () => undefined),
    setUnread: vi.fn(async () => undefined),
  }
}

function setShell(shell?: RivetShell): void {
  const g = globalThis as { rivetShell?: RivetShell }
  if (shell) g.rivetShell = shell
  else delete g.rivetShell
}

afterEach(() => {
  setShell(undefined)
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('rivetShell detection', () => {
  it('is undefined in a plain browser', () => {
    expect(rivetShell()).toBeUndefined()
    expect(isDesktopShell()).toBe(false)
  })

  it('detects the Electron preload bridge', () => {
    const shell = stubShell()
    setShell(shell)
    expect(rivetShell()).toBe(shell)
    expect(isDesktopShell()).toBe(true)
  })

  it('rejects a partial global without the pipe method', () => {
    setShell({ kind: 'electron' } as unknown as RivetShell)
    expect(rivetShell()).toBeUndefined()
  })

  it('isDesktopShell still detects the Tauri global alone', () => {
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = {}
    expect(isDesktopShell()).toBe(true)
  })
})

describe('consumers prefer rivetShell', () => {
  it('clipboard rides the bridge', async () => {
    const shell = stubShell()
    setShell(shell)
    expect(hasTauriClipboard()).toBe(true)
    await copyTextToClipboard('hello')
    expect(shell.clipboardWriteText).toHaveBeenCalledWith('hello')
    expect(await readTextFromClipboard()).toBe('from-shell')
  })

  it('openExternal rides the bridge and never forwards non-http', () => {
    const shell = stubShell()
    setShell(shell)
    openExternal('https://rivetos.dev')
    expect(shell.openExternal).toHaveBeenCalledWith('https://rivetos.dev')
    openExternal('javascript:alert(1)')
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
  })
})
