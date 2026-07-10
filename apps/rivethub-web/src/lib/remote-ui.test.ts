import { describe, it, expect } from 'vitest'
import {
  isBundledOrigin,
  rememberRemoteUi,
  shouldRedirect,
  storedRemoteUi,
} from './remote-ui.js'

function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage
}

describe('isBundledOrigin', () => {
  it('tauri origins are bundled; http gateway origins are not', () => {
    expect(isBundledOrigin('tauri://localhost', 'tauri:')).toBe(true)
    // windows shell serves the dist over http://tauri.localhost — a legit
    // http origin, but still the bundled app
    expect(isBundledOrigin('http://tauri.localhost', 'http:')).toBe(true)
    expect(isBundledOrigin('http://192.168.1.10:5174', 'http:')).toBe(false)
  })
})

describe('storedRemoteUi / rememberRemoteUi', () => {
  it('round-trips a valid origin and strips trailing slashes', () => {
    const s = memStorage()
    rememberRemoteUi(s, 'http://192.168.1.10:5174/')
    expect(storedRemoteUi(s)).toBe('http://192.168.1.10:5174')
  })

  it('rejects junk (poisoned storage never becomes a nav target)', () => {
    expect(storedRemoteUi(memStorage({ 'rivethub.remoteUi': 'tauri://localhost' }))).toBeUndefined()
    expect(
      storedRemoteUi(memStorage({ 'rivethub.remoteUi': 'javascript:alert(1)' })),
    ).toBeUndefined()
    expect(storedRemoteUi(memStorage())).toBeUndefined()
    const s = memStorage()
    rememberRemoteUi(s, 'javascript:alert(1)')
    expect(storedRemoteUi(s)).toBeUndefined()
  })
})

describe('shouldRedirect', () => {
  const base = {
    bundled: true,
    localOverride: false,
    target: 'http://192.168.1.10:5174',
    probeOk: true,
  }
  it('redirects only when bundled + target + probe ok + no override', () => {
    expect(shouldRedirect(base)).toBe(true)
    expect(shouldRedirect({ ...base, bundled: false })).toBe(false)
    expect(shouldRedirect({ ...base, localOverride: true })).toBe(false)
    expect(shouldRedirect({ ...base, target: undefined })).toBe(false)
    expect(shouldRedirect({ ...base, probeOk: false })).toBe(false)
  })
})
