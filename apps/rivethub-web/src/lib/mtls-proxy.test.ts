import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RivetShell } from './shell-bridge.js'

/** Full-shape rivetShell stub — only mtlsProxyPort matters here; the rest
 *  exist so shell-bridge's all-methods-or-nothing check passes. */
function setShell(mtlsProxyPort?: (target: string) => Promise<number>): void {
  const g = globalThis as { rivetShell?: RivetShell }
  if (!mtlsProxyPort) {
    delete g.rivetShell
    return
  }
  g.rivetShell = {
    kind: 'test',
    mtlsProxyPort,
    openExternal: async () => undefined,
    clipboardWriteText: async () => undefined,
    clipboardReadText: async () => '',
    sendNotification: async () => undefined,
    setUnread: async () => undefined,
  }
}

// The port cache is module-level, so each test gets a fresh module instance.
async function load(): Promise<typeof import('./mtls-proxy.js')> {
  return import('./mtls-proxy.js')
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  setShell(undefined)
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('transportBase', () => {
  it('is a pass-through outside a shell', async () => {
    setShell(undefined)
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
  })

  it('passes through under the Android shim (__TAURI__ without a pipe)', async () => {
    // The Android WebView shim exposes clipboardManager/opener only — it has
    // no loopback pipe, and its presence must not disturb the https
    // pass-through (review finding, PR #555).
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { clipboardManager: {} }
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
  })

  it('is a pass-through for http bases even inside the shell', async () => {
    const port = vi.fn(async () => 1234)
    setShell(port)
    const { transportBase } = await load()
    await expect(transportBase('http://10.0.0.7:5174')).resolves.toBe('http://10.0.0.7:5174')
    expect(port).not.toHaveBeenCalled()
  })

  it('swaps an https base for the loopback pipe and caches it', async () => {
    const port = vi.fn(async () => 40001)
    setShell(port)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    // Second resolve reuses the cached port (one shell call) after a liveness probe.
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    expect(port).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:40001',
      expect.objectContaining({ mode: 'no-cors' }),
    )
  })

  it('resolves per target — a second base never rides the first pipe', async () => {
    // Settings "Test connection" probes an arbitrary typed origin through
    // gatewayFor/transportBase. The pipe map must key on the base it is
    // GIVEN: a base the shell refuses falls back to that same base, never
    // to another (enrolled) node's transport — a wrong URL must not
    // false-pass against the saved node.
    const port = vi.fn(async (target: string) => {
      if (target === 'https://10.0.0.7:5174') return 40001
      throw new Error('no identity for target')
    })
    setShell(port)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    await expect(transportBase('https://10.0.0.9:5174')).resolves.toBe('https://10.0.0.9:5174')
    expect(port).toHaveBeenCalledTimes(2)
    expect(port).toHaveBeenLastCalledWith('https://10.0.0.9:5174')
  })

  it('recovers when the cached pipe was evicted shell-side', async () => {
    // First resolve hands out port 40001; the shell then evicts that listener
    // — the probe gets ECONNREFUSED — and the re-request starts a fresh
    // listener on 40002.
    let portNum = 40001
    const port = vi.fn(async () => portNum)
    setShell(port)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('40001')) throw new TypeError('fetch failed')
        return new Response(null)
      }),
    )
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    portNum = 40002
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40002')
    expect(port).toHaveBeenCalledTimes(2)
    // The recovery is cached: further resolves stick to the new port.
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40002')
    expect(port).toHaveBeenCalledTimes(2)
  })

  it('falls back to the direct base when the shell has no identity, uncached', async () => {
    const port = vi.fn(async (): Promise<number> => {
      throw new Error('device.crt: no such file')
    })
    setShell(port)
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
    // Failure is NOT cached: enrolling an identity mid-run must engage on the
    // next resolve without a relaunch.
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
    expect(port).toHaveBeenCalledTimes(2)
  })
})
