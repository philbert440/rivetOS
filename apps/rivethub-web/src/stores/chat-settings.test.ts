import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { useChatSettings } = await import('./chat-settings.js')

describe('chat settings recency cap', () => {
  beforeEach(() => {
    useChatSettings.setState({ byKey: {} })
  })

  it('keeps a just-touched oldest key and evicts the second-oldest', () => {
    for (let i = 0; i < 200; i++) {
      useChatSettings.getState().set(`k${i}`, { agent: 'claude' })
    }
    useChatSettings.getState().set('k0', { effort: 'high' })
    useChatSettings.getState().set('k200', { agent: 'grok' })
    const byKey = useChatSettings.getState().byKey
    expect(Object.keys(byKey)).toHaveLength(200)
    expect(byKey.k0?.effort).toBe('high')
    expect(byKey.k1).toBeUndefined()
    expect(byKey.k200?.agent).toBe('grok')
    expect(byKey.k199).toBeDefined()
  })
})
