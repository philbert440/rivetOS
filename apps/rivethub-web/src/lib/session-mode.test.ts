import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSessionMode, getSessionMode, setSessionMode } from './session-mode.js'

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
afterAll(() => vi.unstubAllGlobals())

describe('per-thread view mode', () => {
  beforeEach(() => store.clear())

  it('defaults a never-seen thread to chat', () => {
    expect(getSessionMode('node::s1')).toBe('chat')
  })

  it('honors a caller fallback for never-seen threads', () => {
    expect(getSessionMode('node::tui', 'terminal')).toBe('terminal')
    setSessionMode('node::tui', 'chat')
    expect(getSessionMode('node::tui', 'terminal')).toBe('chat')
  })

  it('remembers the last view per thread', () => {
    setSessionMode('node::s1', 'terminal')
    setSessionMode('node::s2', 'den')
    expect(getSessionMode('node::s1')).toBe('terminal')
    expect(getSessionMode('node::s2')).toBe('den')
    expect(getSessionMode('node::s3')).toBe('chat')
  })

  it('falls back on garbage', () => {
    store.setItem('rivethub.sessionModes', 'not json')
    expect(getSessionMode('node::s1')).toBe('chat')
    store.setItem('rivethub.sessionModes', JSON.stringify({ 'node::s1': 'bogus' }))
    expect(getSessionMode('node::s1', 'terminal')).toBe('terminal')
  })

  it('clears a single entry', () => {
    setSessionMode('node::s1', 'den')
    clearSessionMode('node::s1')
    expect(getSessionMode('node::s1')).toBe('chat')
  })

  it('evicts least-recently-TOUCHED on overflow, not first-inserted', () => {
    for (let i = 0; i < 500; i++) setSessionMode(`node::s${String(i)}`, 'terminal')
    // Touch the oldest key, then overflow by one: s0 must survive because the
    // touch bumped it to the tail; the new oldest (s1) is what gets evicted.
    setSessionMode('node::s0', 'den')
    setSessionMode('node::s500', 'terminal')
    const map = JSON.parse(store.getItem('rivethub.sessionModes') ?? '{}') as Record<
      string,
      string
    >
    expect(Object.keys(map).length).toBeLessThanOrEqual(500)
    expect(getSessionMode('node::s0')).toBe('den')
    expect(map['node::s1']).toBeUndefined()
    expect(getSessionMode('node::s500')).toBe('terminal')
  })
})
