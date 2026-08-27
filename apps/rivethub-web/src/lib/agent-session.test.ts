import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentLastSession,
  getAgentLastSession,
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

describe('agent last-session pointer', () => {
  beforeEach(() => store.clear())

  it('stores and returns the last session per agent', () => {
    expect(getAgentLastSession('a1')).toBeUndefined()
    setAgentLastSession('a1', 'sess-1', 'https://node:5174')
    expect(getAgentLastSession('a1')).toEqual({
      sessionId: 'sess-1',
      nodeBaseUrl: 'https://node:5174',
    })
    expect(localStorage.getItem('rivethub.agent.sess-1')).toBe('a1')
  })

  it('retargets the pointer when a thread is rekeyed', () => {
    setAgentLastSession('a1', 'draft-uuid', 'https://node:5174')
    rekeyAgentLastSessions('draft-uuid', 'claude-code:draft-uuid')
    expect(getAgentLastSession('a1')).toEqual({
      sessionId: 'claude-code:draft-uuid',
      nodeBaseUrl: 'https://node:5174',
    })
    expect(localStorage.getItem('rivethub.agent.draft-uuid')).toBeNull()
    expect(localStorage.getItem('rivethub.agent.claude-code:draft-uuid')).toBe('a1')
  })

  it('ignores a no-op rekey', () => {
    setAgentLastSession('a1', 'sess-1', 'https://node:5174')
    rekeyAgentLastSessions('sess-1', 'sess-1')
    expect(getAgentLastSession('a1')?.sessionId).toBe('sess-1')
  })

  it('drops the last-session pointer and bind key on delete', () => {
    setAgentLastSession('a1', 'sess-1', 'https://node:5174')
    clearAgentLastSession('a1')
    expect(getAgentLastSession('a1')).toBeUndefined()
    expect(localStorage.getItem('rivethub.agent.sess-1')).toBeNull()
  })

  it('retarget leaves no bind behind for the previous session id', () => {
    setAgentLastSession('a1', 'sess-old', 'https://node:5174')
    setAgentLastSession('a1', 'sess-new', 'https://node:5174')
    expect(localStorage.getItem('rivethub.agent.sess-old')).toBeNull()
    expect(localStorage.getItem('rivethub.agent.sess-new')).toBe('a1')
    expect(getAgentLastSession('a1')?.sessionId).toBe('sess-new')
  })
})
