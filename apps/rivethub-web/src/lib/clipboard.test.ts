import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claimNativeCopy,
  copyTextToClipboard,
  hasTauriClipboard,
  readTextFromClipboard,
  shouldBridgeNativeCopy,
} from './clipboard.js'

type TauriGlobal = {
  clipboardManager?: {
    writeText: (t: string) => Promise<void>
    readText: () => Promise<string>
  }
}

type Internals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function setTauri(manager?: TauriGlobal['clipboardManager'], internals?: Internals): void {
  const g = globalThis as {
    __TAURI__?: TauriGlobal
    __TAURI_INTERNALS__?: Internals
  }
  if (manager) g.__TAURI__ = { clipboardManager: manager }
  else delete g.__TAURI__
  if (internals) g.__TAURI_INTERNALS__ = internals
  else delete g.__TAURI_INTERNALS__
}

afterEach(() => {
  setTauri(undefined, undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('hasTauriClipboard', () => {
  it('is false with no host bridge', () => {
    setTauri(undefined, undefined)
    expect(hasTauriClipboard()).toBe(false)
  })

  it('detects clipboardManager', () => {
    setTauri({
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => ''),
    })
    expect(hasTauriClipboard()).toBe(true)
  })

  it('detects __TAURI_INTERNALS__.invoke', () => {
    setTauri(undefined, { invoke: vi.fn(async () => undefined) })
    expect(hasTauriClipboard()).toBe(true)
  })
})

describe('shouldBridgeNativeCopy / claimNativeCopy', () => {
  it('bridges when Tauri is present', () => {
    expect(shouldBridgeNativeCopy({ hasTauri: true, secureContext: true })).toBe(true)
  })

  it('bridges on non-secure context even without Tauri', () => {
    expect(shouldBridgeNativeCopy({ hasTauri: false, secureContext: false })).toBe(true)
  })

  it('leaves secure browsers alone', () => {
    expect(shouldBridgeNativeCopy({ hasTauri: false, secureContext: true })).toBe(false)
  })

  it('claims selection: setData + preventDefault', () => {
    const setData = vi.fn()
    const preventDefault = vi.fn()
    const claimed = claimNativeCopy(
      'selected-text',
      { setData },
      preventDefault,
      { hasTauri: true, secureContext: true },
    )
    expect(claimed).toBe(true)
    expect(setData).toHaveBeenCalledWith('text/plain', 'selected-text')
    expect(preventDefault).toHaveBeenCalled()
  })

  it('does not claim empty selection', () => {
    const setData = vi.fn()
    const preventDefault = vi.fn()
    expect(
      claimNativeCopy('', { setData }, preventDefault, { hasTauri: true, secureContext: true }),
    ).toBe(false)
    expect(setData).not.toHaveBeenCalled()
  })
})

describe('copyTextToClipboard', () => {
  it('prefers clipboardManager.writeText', async () => {
    const writeText = vi.fn(async () => undefined)
    setTauri({ writeText, readText: vi.fn(async () => '') })
    await copyTextToClipboard('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to plugin invoke when manager is absent', async () => {
    const invoke = vi.fn(async () => undefined)
    setTauri(undefined, { invoke })
    await copyTextToClipboard('via-invoke')
    expect(invoke).toHaveBeenCalledWith('plugin:clipboard-manager|write_text', {
      text: 'via-invoke',
    })
  })

  it('falls back to navigator.clipboard when no Tauri', async () => {
    setTauri(undefined, undefined)
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyTextToClipboard('browser')
    expect(writeText).toHaveBeenCalledWith('browser')
  })

  it('falls through to navigator when manager throws', async () => {
    setTauri({
      writeText: vi.fn(async () => {
        throw new Error('ipc denied')
      }),
      readText: vi.fn(async () => ''),
    })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyTextToClipboard('recover')
    expect(writeText).toHaveBeenCalledWith('recover')
  })
})

describe('readTextFromClipboard', () => {
  it('reads via clipboardManager', async () => {
    setTauri({
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => 'from-manager'),
    })
    await expect(readTextFromClipboard()).resolves.toBe('from-manager')
  })

  it('reads via invoke', async () => {
    setTauri(undefined, {
      invoke: vi.fn(async (cmd) => {
        if (cmd === 'plugin:clipboard-manager|read_text') return 'from-invoke'
        return undefined
      }),
    })
    await expect(readTextFromClipboard()).resolves.toBe('from-invoke')
  })
})
