import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TauriGlobal = {
  core: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }
}

function setTauri(invoke?: TauriGlobal['core']['invoke']): void {
  // transportBase reads globalThis.__TAURI__ (same as every other consumer —
  // in a real renderer window IS globalThis).
  const g = globalThis as { __TAURI__?: TauriGlobal }
  if (invoke) g.__TAURI__ = { core: { invoke } }
  else delete g.__TAURI__
}

// The port cache is module-level, so each test gets a fresh module instance.
async function load(): Promise<typeof import('./mtls-proxy.js')> {
  return import('./mtls-proxy.js')
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  setTauri(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('transportBase', () => {
  it('is a pass-through outside Tauri', async () => {
    setTauri(undefined)
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
  })

  it('passes through on a PARTIAL __TAURI__ (Android shim: no core.invoke)', async () => {
    // The Android WebView shim exposes clipboardManager/opener but no core —
    // an unguarded core.invoke access would throw synchronously out of
    // transportBase and kill every gateway request (review finding, PR #555).
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { clipboardManager: {} }
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
  })

  it('is a pass-through for http bases even inside Tauri', async () => {
    const invoke = vi.fn(async () => 1234)
    setTauri(invoke)
    const { transportBase } = await load()
    await expect(transportBase('http://10.0.0.7:5174')).resolves.toBe('http://10.0.0.7:5174')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('swaps an https base for the loopback pipe and caches it', async () => {
    const invoke = vi.fn(async () => 40001)
    setTauri(invoke)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    // Second resolve reuses the cached port (one invoke) after a liveness probe.
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    expect(invoke).toHaveBeenCalledTimes(1)
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
    const invoke = vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
      if (args.target === 'https://10.0.0.7:5174') return 40001
      throw new Error('no identity for target')
    })
    setTauri(invoke)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    await expect(transportBase('https://10.0.0.9:5174')).resolves.toBe('https://10.0.0.9:5174')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('mtls_proxy_port', { target: 'https://10.0.0.9:5174' })
  })

  it('recovers when the cached pipe was evicted shell-side', async () => {
    // First resolve hands out port 40001; the shell then evicts that listener
    // (proxy.rs cap) — the probe gets ECONNREFUSED — and the re-invoke starts
    // a fresh listener on 40002.
    let port = 40001
    const invoke = vi.fn(async () => port)
    setTauri(invoke)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('40001')) throw new TypeError('fetch failed')
        return new Response(null)
      }),
    )
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40001')
    port = 40002
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40002')
    expect(invoke).toHaveBeenCalledTimes(2)
    // The recovery is cached: further resolves stick to the new port.
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('http://127.0.0.1:40002')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('falls back to the direct base when the shell has no identity, uncached', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => {
      throw new Error('device.crt: no such file')
    })
    setTauri(invoke)
    const { transportBase } = await load()
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
    // Failure is NOT cached: enrolling an identity mid-run must engage on the
    // next resolve without a relaunch.
    await expect(transportBase('https://10.0.0.7:5174')).resolves.toBe('https://10.0.0.7:5174')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
