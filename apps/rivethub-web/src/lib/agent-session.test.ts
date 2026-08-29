import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentLastSession,
  getAgentLastSession,
  listAgentSessions,
  rekeyAgentLastSessions,
  setAgentLastSession,
} from './agent-session.js'

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

const NODE_A = 'https://node-a:5174'
const NODE_B = 'https://node-b:5174'

describe('agent last-session pointer', () => {
  beforeEach(() => store.clear())

  it('stores and returns the last session per (agent, node)', () => {
    expect(getAgentLastSession('a1', NODE_A)).toBeUndefined()
    setAgentLastSession('a1', 'sess-1', NODE_A)
    expect(getAgentLastSession('a1', NODE_A)).toEqual({
      sessionId: 'sess-1',
      nodeBaseUrl: NODE_A,
    })
    expect(getAgentLastSession('a1', NODE_B)).toBeUndefined()
    expect(localStorage.getItem('rivethub.agent.sess-1')).toBe('a1')
  })

  it('keeps independent pointers per node for one agent', () => {
    setAgentLastSession('a1', 'sess-a', NODE_A)
    setAgentLastSession('a1', 'sess-b', NODE_B)
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('sess-a')
    expect(getAgentLastSession('a1', NODE_B)?.sessionId).toBe('sess-b')
    expect(listAgentSessions('a1')).toEqual(
      expect.arrayContaining([
        { sessionId: 'sess-a', nodeBaseUrl: NODE_A },
        { sessionId: 'sess-b', nodeBaseUrl: NODE_B },
      ]),
    )
  })

  it('migrates the legacy single-pointer shape on read', () => {
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({ a1: { sessionId: 'legacy-1', nodeBaseUrl: NODE_A } }),
    )
    expect(getAgentLastSession('a1', NODE_A)).toEqual({
      sessionId: 'legacy-1',
      nodeBaseUrl: NODE_A,
    })
    expect(listAgentSessions('a1')).toEqual([{ sessionId: 'legacy-1', nodeBaseUrl: NODE_A }])
    // A write persists the per-node shape without losing the migrated row.
    setAgentLastSession('a1', 'sess-b', NODE_B)
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('legacy-1')
    expect(getAgentLastSession('a1', NODE_B)?.sessionId).toBe('sess-b')
  })

  it('retargets pointers on every node when a thread is rekeyed', () => {
    setAgentLastSession('a1', 'draft-uuid', NODE_A)
    rekeyAgentLastSessions('draft-uuid', 'claude-code:draft-uuid')
    expect(getAgentLastSession('a1', NODE_A)).toEqual({
      sessionId: 'claude-code:draft-uuid',
      nodeBaseUrl: NODE_A,
    })
    expect(localStorage.getItem('rivethub.agent.draft-uuid')).toBeNull()
    expect(localStorage.getItem('rivethub.agent.claude-code:draft-uuid')).toBe('a1')
  })

  it('ignores a no-op rekey', () => {
    setAgentLastSession('a1', 'sess-1', NODE_A)
    rekeyAgentLastSessions('sess-1', 'sess-1')
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('sess-1')
  })

  it('drops every node pointer and bind key on delete', () => {
    setAgentLastSession('a1', 'sess-a', NODE_A)
    setAgentLastSession('a1', 'sess-b', NODE_B)
    clearAgentLastSession('a1')
    expect(getAgentLastSession('a1', NODE_A)).toBeUndefined()
    expect(listAgentSessions('a1')).toEqual([])
    expect(localStorage.getItem('rivethub.agent.sess-a')).toBeNull()
    expect(localStorage.getItem('rivethub.agent.sess-b')).toBeNull()
  })

  it('replacing a node pointer leaves no bind behind for the previous session id', () => {
    setAgentLastSession('a1', 'sess-old', NODE_A)
    setAgentLastSession('a1', 'sess-new', NODE_A)
    expect(localStorage.getItem('rivethub.agent.sess-old')).toBeNull()
    expect(localStorage.getItem('rivethub.agent.sess-new')).toBe('a1')
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('sess-new')
  })
})
