import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeSelectionText,
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
  it('bridges a Tauri-shaped host without rivetShell (WebKitGTK / Android shim)', () => {
    expect(shouldBridgeNativeCopy({ hasShell: false, hasTauri: true })).toBe(true)
  })

  it('leaves the Electron shell alone — Chromium native copy is the one writer', () => {
    expect(shouldBridgeNativeCopy({ hasShell: true, hasTauri: true })).toBe(false)
    expect(shouldBridgeNativeCopy({ hasShell: true, hasTauri: false })).toBe(false)
  })

  it('leaves plain browsers alone regardless of secure context', () => {
    expect(shouldBridgeNativeCopy({ hasShell: false, hasTauri: false })).toBe(false)
  })

  it('claims a selection on a bridged host with preventDefault only', () => {
    const preventDefault = vi.fn()
    const claimed = claimNativeCopy('selected-text', preventDefault, {
      hasShell: false,
      hasTauri: true,
    })
    expect(claimed).toBe(true)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('does not claim under rivetShell', () => {
    const preventDefault = vi.fn()
    expect(claimNativeCopy('selected-text', preventDefault, { hasShell: true, hasTauri: true })).toBe(
      false,
    )
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('does not claim empty selection', () => {
    const preventDefault = vi.fn()
    expect(claimNativeCopy('', preventDefault, { hasShell: false, hasTauri: true })).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('does not claim in a plain browser (no host IPC at all)', () => {
    const preventDefault = vi.fn()
    expect(claimNativeCopy('selected-text', preventDefault, { hasShell: false, hasTauri: false })).toBe(
      false,
    )
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

describe('bridgeSelectionText', () => {
  const doc = (activeElement: unknown): Pick<Document, 'activeElement'> =>
    ({ activeElement }) as Pick<Document, 'activeElement'>

  it('slices the focused textarea selection when the DOM selection is empty', () => {
    expect(
      bridgeSelectionText(
        doc({ tagName: 'TEXTAREA', value: 'hello world', selectionStart: 6, selectionEnd: 11 }),
      ),
    ).toBe('world')
  })

  it('slices text-like inputs', () => {
    expect(
      bridgeSelectionText(
        doc({ tagName: 'INPUT', type: 'text', value: 'abcdef', selectionStart: 1, selectionEnd: 3 }),
      ),
    ).toBe('bc')
  })

  it('never claims a password field', () => {
    expect(
      bridgeSelectionText(
        doc({
          tagName: 'INPUT',
          type: 'password',
          value: 'hunter2',
          selectionStart: 0,
          selectionEnd: 7,
        }),
      ),
    ).toBe('')
  })

  it('returns empty for collapsed ranges and non-field elements', () => {
    expect(
      bridgeSelectionText(
        doc({ tagName: 'TEXTAREA', value: 'abc', selectionStart: 2, selectionEnd: 2 }),
      ),
    ).toBe('')
    expect(bridgeSelectionText(doc({ tagName: 'DIV' }))).toBe('')
    expect(bridgeSelectionText(doc(null))).toBe('')
  })
})

describe('write serialization', () => {
  it('keeps issue order under a slow first write — clipboard ends on the newest copy', async () => {
    const written: string[] = []
    let releaseA: (() => void) | undefined
    const writeText = vi.fn((t: string) => {
      written.push(t)
      if (t === 'A') return new Promise<void>((resolve) => (releaseA = resolve))
      return Promise.resolve()
    })
    setTauri({ writeText, readText: vi.fn(async () => '') })

    const a = copyTextToClipboard('A')
    const b = copyTextToClipboard('B')
    // B must not be issued while A is in flight.
    expect(written).toEqual(['A'])
    releaseA?.()
    await a
    await b
    // A settled late, then B issued — final clipboard content is B.
    expect(written).toEqual(['A', 'B'])
  })

  it('drops a queued write superseded before it was issued', async () => {
    const written: string[] = []
    let releaseA: (() => void) | undefined
    const writeText = vi.fn((t: string) => {
      written.push(t)
      if (t === 'A') return new Promise<void>((resolve) => (releaseA = resolve))
      return Promise.resolve()
    })
    setTauri({ writeText, readText: vi.fn(async () => '') })

    const a = copyTextToClipboard('A')
    const b = copyTextToClipboard('B') // queued
    const c = copyTextToClipboard('C') // supersedes B before issue
    releaseA?.()
    await Promise.all([a, b, c])
    // B was never handed to the host — exactly one effective queued write.
    expect(written).toEqual(['A', 'C'])
  })

  it('propagates a write failure so bridge callers can log it', async () => {
    setTauri({
      writeText: vi.fn(async () => {
        throw new Error('ipc denied')
      }),
      readText: vi.fn(async () => ''),
    })
    // No navigator.clipboard and no DOM in this environment — every
    // fallback is exhausted and the caller must see the rejection.
    vi.stubGlobal('navigator', {})
    await expect(copyTextToClipboard('lost')).rejects.toThrow()
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
