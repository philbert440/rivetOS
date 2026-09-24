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

const { useChatSettings, mergeChatSettings } = await import('./chat-settings.js')

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

describe('agentId', () => {
  it('clears agentId when the agent or harness changes, like model', () => {
    const current = {
      agent: 'claude',
      effort: 'medium' as const,
      harnessId: 'claude-code' as const,
      model: 'opus',
      agentId: 'preset-1',
    }
    expect(mergeChatSettings(current, { agent: 'grok' }).agentId).toBeUndefined()
    expect(mergeChatSettings(current, { harnessId: 'grok-build' }).agentId).toBeUndefined()
    expect(mergeChatSettings(current, { agent: 'claude' }).agentId).toBe('preset-1')
    expect(mergeChatSettings(current, { model: 'haiku' }).agentId).toBe('preset-1')
    // The same patch may stamp a new preset id; that value wins over the clear.
    expect(mergeChatSettings(current, { agent: 'grok', agentId: 'preset-2' }).agentId).toBe(
      'preset-2',
    )
    expect(mergeChatSettings(current, { agent: 'grok', agentId: 'preset-2' }).model).toBeUndefined()
  })
})
