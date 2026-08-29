import { describe, it, expect } from 'vitest'
import { isBundledOrigin, rememberRemoteUi, storedRemoteUi } from './remote-ui.js'

function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage
}

describe('isBundledOrigin', () => {
  it('shell origins are bundled; http gateway origins are not', () => {
    // electron shell serves the dist over its app:// scheme
    expect(isBundledOrigin('app://bundle', 'app:')).toBe(true)
    expect(isBundledOrigin('http://192.168.1.10:5174', 'http:')).toBe(false)
    // fallback: non-gateway custom schemes still count as bundled
    expect(isBundledOrigin('file://', 'file:')).toBe(true)
  })
})

describe('storedRemoteUi / rememberRemoteUi', () => {
  it('round-trips a valid origin and strips trailing slashes', () => {
    const s = memStorage()
    rememberRemoteUi(s, 'http://192.168.1.10:5174/')
    expect(storedRemoteUi(s)).toBe('http://192.168.1.10:5174')
  })

  it('rejects junk (poisoned storage never becomes a nav target)', () => {
    expect(
      storedRemoteUi(memStorage({ 'rivethub.remoteUi': 'javascript:alert(1)' })),
    ).toBeUndefined()
    expect(storedRemoteUi(memStorage())).toBeUndefined()
    const s = memStorage()
    rememberRemoteUi(s, 'javascript:alert(1)')
    expect(storedRemoteUi(s)).toBeUndefined()
  })
})
