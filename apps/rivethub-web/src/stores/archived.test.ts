import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.stubGlobal('localStorage', memoryStorage())
afterAll(() => vi.unstubAllGlobals())

const { useArchived } = await import('./archived.js')

describe('archived conversations store', () => {
  beforeEach(() => useArchived.setState({ keys: [] }))

  it('archives, reports, and unarchives', () => {
    const s = useArchived.getState()
    s.archive('node::a')
    expect(useArchived.getState().isArchived('node::a')).toBe(true)
    expect(useArchived.getState().isArchived('node::b')).toBe(false)
    useArchived.getState().unarchive('node::a')
    expect(useArchived.getState().isArchived('node::a')).toBe(false)
  })

  it('dedupes a re-archive and bumps it to most recent', () => {
    const s = useArchived.getState()
    s.archive('node::a')
    s.archive('node::b')
    s.archive('node::a')
    expect(useArchived.getState().keys).toEqual(['node::b', 'node::a'])
  })

  it('unarchive of a missing key is a no-op', () => {
    const before = useArchived.getState().keys
    useArchived.getState().unarchive('node::nope')
    expect(useArchived.getState().keys).toBe(before)
  })

  it('caps at 1000 by evicting the longest-archived', () => {
    for (let i = 0; i < 1001; i++) useArchived.getState().archive(`node::s${String(i)}`)
    const keys = useArchived.getState().keys
    expect(keys).toHaveLength(1000)
    expect(keys.includes('node::s0')).toBe(false)
    expect(keys.at(-1)).toBe('node::s1000')
  })
})
