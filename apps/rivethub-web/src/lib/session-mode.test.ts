import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionMode, setSessionMode } from './session-mode.js'

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

describe('per-thread view mode', () => {
  beforeEach(() => store.clear())

  it('defaults a never-seen thread to chat', () => {
    expect(getSessionMode('node::s1')).toBe('chat')
  })

  it('remembers the last view per thread', () => {
    setSessionMode('node::s1', 'terminal')
    setSessionMode('node::s2', 'den')
    expect(getSessionMode('node::s1')).toBe('terminal')
    expect(getSessionMode('node::s2')).toBe('den')
    expect(getSessionMode('node::s3')).toBe('chat')
  })

  it('falls back to chat on garbage', () => {
    store.setItem('rivethub.sessionModes', 'not json')
    expect(getSessionMode('node::s1')).toBe('chat')
    store.setItem('rivethub.sessionModes', JSON.stringify({ 'node::s1': 'bogus' }))
    expect(getSessionMode('node::s1')).toBe('chat')
  })

  it('caps stored entries', () => {
    for (let i = 0; i < 520; i++) setSessionMode(`node::s${String(i)}`, 'terminal')
    const map = JSON.parse(store.getItem('rivethub.sessionModes') ?? '{}') as Record<
      string,
      string
    >
    expect(Object.keys(map).length).toBeLessThanOrEqual(500)
    expect(getSessionMode('node::s519')).toBe('terminal')
  })
})
