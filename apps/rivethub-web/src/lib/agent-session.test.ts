import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentForSession,
  clearAgentLastSession,
  clearAgentSessionPointer,
  collapseAgentSlots,
  getAgentLastSession,
  getAgentPin,
  getAgentSessionsVersion,
  listAgentSessions,
  rekeyAgentLastSessions,
  setAgentLastSession,
  subscribeAgentSessions,
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
  afterEach(() => vi.restoreAllMocks())

  it('stores and returns the last session per (agent, node)', () => {
    expect(getAgentLastSession('a1', NODE_A)).toBeUndefined()
    setAgentLastSession('a1', 'sess-1', NODE_A)
    expect(getAgentLastSession('a1', NODE_A)).toEqual({
      sessionId: 'sess-1',
      nodeBaseUrl: NODE_A,
    })
    expect(getAgentLastSession('a1', NODE_B)).toBeUndefined()
    expect(localStorage.getItem('rivethub.agent.sess-1')).toBe('a1')
    expect(agentForSession('sess-1')).toBe('a1')
  })

  it('set-once: a second write without replace does not steal the pin', () => {
    setAgentLastSession('a1', 'sess-a', NODE_A)
    setAgentLastSession('a1', 'sess-b', NODE_B)
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('sess-a')
    expect(getAgentLastSession('a1', NODE_B)).toBeUndefined()
    expect(getAgentPin('a1')).toEqual({ sessionId: 'sess-a', nodeBaseUrl: NODE_A })
  })

  it('replace drops other slots and writes the new pin', () => {
    setAgentLastSession('a1', 'sess-a', NODE_A)
    setAgentLastSession('a1', 'sess-b', NODE_B, { replace: true })
    expect(getAgentLastSession('a1', NODE_A)).toBeUndefined()
    expect(getAgentPin('a1')).toEqual({ sessionId: 'sess-b', nodeBaseUrl: NODE_B })
    expect(localStorage.getItem('rivethub.agent.sess-a')).toBeNull()
    expect(localStorage.getItem('rivethub.agent.sess-b')).toBe('a1')
  })

  it('collapse keeps the preferred node, else the oldest', () => {
    // Seed two slots via replace then a raw map write (pre-collapse leftover).
    setAgentLastSession('a1', 'sess-a', NODE_A)
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({
        a1: {
          [NODE_A]: { sessionId: 'sess-a', updatedAt: 1 },
          [NODE_B]: { sessionId: 'sess-b', updatedAt: 9 },
        },
      }),
    )
    expect(collapseAgentSlots('a1', NODE_A)?.sessionId).toBe('sess-a')
    expect(listAgentSessions('a1')).toEqual([{ sessionId: 'sess-a', nodeBaseUrl: NODE_A }])
  })

  it('subscribe fires on writes', () => {
    const seen: number[] = []
    const unsub = subscribeAgentSessions(() => seen.push(getAgentSessionsVersion()))
    setAgentLastSession('a1', 'sess-a', NODE_A)
    expect(seen.length).toBeGreaterThan(0)
    unsub()
  })

  it('lists the single pin', () => {
    setAgentLastSession('a1', 'sess-old', NODE_A)
    expect(listAgentSessions('a1')).toEqual([{ sessionId: 'sess-old', nodeBaseUrl: NODE_A }])
  })

  it('migrates the legacy single-pointer shape on read — for its node ONLY', () => {
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({ a1: { sessionId: 'legacy-1', nodeBaseUrl: NODE_A } }),
    )
    expect(getAgentLastSession('a1', NODE_A)).toEqual({
      sessionId: 'legacy-1',
      nodeBaseUrl: NODE_A,
    })
    // The keep-on-current-node invariant: no fallback to "any pointer".
    expect(getAgentLastSession('a1', NODE_B)).toBeUndefined()
    expect(listAgentSessions('a1')).toEqual([{ sessionId: 'legacy-1', nodeBaseUrl: NODE_A }])
    // Set-once: a later write without replace must not steal the migrated pin.
    setAgentLastSession('a1', 'sess-b', NODE_B)
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('legacy-1')
    expect(getAgentLastSession('a1', NODE_B)).toBeUndefined()
  })

  it('persists a fired migration on first read', () => {
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({ a1: { sessionId: 'legacy-1', nodeBaseUrl: NODE_A } }),
    )
    getAgentLastSession('a1', NODE_A)
    const persisted: unknown = JSON.parse(localStorage.getItem('rivethub.agent.lastSession') ?? '')
    expect(persisted).toEqual({ a1: { [NODE_A]: { sessionId: 'legacy-1' } } })
  })

  it('reads a mixed blob — one agent legacy, another already per-node', () => {
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({
        a1: { sessionId: 'legacy-1', nodeBaseUrl: NODE_A },
        a2: { [NODE_B]: { sessionId: 'sess-b', updatedAt: 5 } },
      }),
    )
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('legacy-1')
    expect(getAgentLastSession('a2', NODE_B)?.sessionId).toBe('sess-b')
    expect(getAgentLastSession('a2', NODE_A)).toBeUndefined()
  })

  it('retargets the rekeyed session in place', () => {
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

  it('prunes a pointer with its bind key', () => {
    setAgentLastSession('a1', 'sess-a', NODE_A)
    clearAgentSessionPointer('a1', NODE_A, 'sess-a')
    expect(getAgentLastSession('a1', NODE_A)).toBeUndefined()
    expect(localStorage.getItem('rivethub.agent.sess-a')).toBeNull()
  })

  it('prune is compare-and-delete: a stale id never wipes a newer pointer', () => {
    setAgentLastSession('a1', 'sess-old', NODE_A)
    setAgentLastSession('a1', 'sess-new', NODE_A, { replace: true })
    clearAgentSessionPointer('a1', NODE_A, 'sess-old')
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('sess-new')
    expect(localStorage.getItem('rivethub.agent.sess-new')).toBe('a1')
  })

  it('drops the pin and bind key on delete', () => {
    setAgentLastSession('a1', 'sess-a', NODE_A)
    clearAgentLastSession('a1')
    expect(getAgentLastSession('a1', NODE_A)).toBeUndefined()
    expect(listAgentSessions('a1')).toEqual([])
    expect(localStorage.getItem('rivethub.agent.sess-a')).toBeNull()
  })

  it('replacing the pin leaves no bind behind for the previous session id', () => {
    setAgentLastSession('a1', 'sess-old', NODE_A)
    setAgentLastSession('a1', 'sess-new', NODE_A, { replace: true })
    expect(localStorage.getItem('rivethub.agent.sess-old')).toBeNull()
    expect(localStorage.getItem('rivethub.agent.sess-new')).toBe('a1')
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('sess-new')
  })
})
