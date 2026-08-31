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
    // Seed two slots the way production leaves them pre-collapse: a raw map
    // write AND the reverse binds every setAgentLastSession writes.
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
    localStorage.setItem('rivethub.agent.sess-b', 'a1')
    expect(collapseAgentSlots('a1', NODE_A)?.sessionId).toBe('sess-a')
    expect(listAgentSessions('a1')).toEqual([{ sessionId: 'sess-a', nodeBaseUrl: NODE_A }])
    // The dropped slot's bind must go with it, or agentForSession('sess-b')
    // keeps resolving a pruned pointer.
    expect(localStorage.getItem('rivethub.agent.sess-b')).toBeNull()
  })

  it('collapse keeps the preferred node even when it is the NEWER slot', () => {
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({
        a1: {
          [NODE_A]: { sessionId: 'sess-a', updatedAt: 9 },
          [NODE_B]: { sessionId: 'sess-b', updatedAt: 1 },
        },
      }),
    )
    localStorage.setItem('rivethub.agent.sess-a', 'a1')
    localStorage.setItem('rivethub.agent.sess-b', 'a1')
    expect(collapseAgentSlots('a1', NODE_A)?.sessionId).toBe('sess-a')
    expect(listAgentSessions('a1')).toEqual([{ sessionId: 'sess-a', nodeBaseUrl: NODE_A }])
    expect(localStorage.getItem('rivethub.agent.sess-b')).toBeNull()
  })

  it('collapse without the preferred node keeps the OLDEST leftover', () => {
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({
        a1: {
          [NODE_A]: { sessionId: 'sess-a', updatedAt: 9 },
          [NODE_B]: { sessionId: 'sess-b', updatedAt: 1 },
        },
      }),
    )
    localStorage.setItem('rivethub.agent.sess-a', 'a1')
    localStorage.setItem('rivethub.agent.sess-b', 'a1')
    expect(collapseAgentSlots('a1', 'https://node-c:5174')?.sessionId).toBe('sess-b')
    expect(listAgentSessions('a1')).toEqual([{ sessionId: 'sess-b', nodeBaseUrl: NODE_B }])
    expect(localStorage.getItem('rivethub.agent.sess-a')).toBeNull()
  })

  it('subscribe notifies only on mutating writes, and stops after unsubscribe', () => {
    const seen: number[] = []
    const unsub = subscribeAgentSessions(() => seen.push(getAgentSessionsVersion()))
    // No notify-on-subscribe: a drawer row must not re-render just for listening.
    expect(seen).toEqual([])
    setAgentLastSession('a1', 'sess-a', NODE_A)
    expect(seen.length).toBe(1)
    // Set-once no-op (a poll refresh hitting an existing pin) must NOT
    // notify — that is what keeps a poll no-op from re-rendering a row under
    // an in-flight click.
    setAgentLastSession('a1', 'sess-b', NODE_A)
    expect(seen.length).toBe(1)
    unsub()
    setAgentLastSession('a1', 'sess-c', NODE_A, { replace: true })
    expect(seen.length).toBe(1)
  })

  it('set-once holds on the SAME node (a stale poll refresh cannot steal a replaced pin)', () => {
    setAgentLastSession('a1', 'sess-old', NODE_A)
    setAgentLastSession('a1', 'sess-new', NODE_A, { replace: true })
    // A poll that still holds the pre-replace id writes without replace.
    setAgentLastSession('a1', 'sess-old', NODE_A)
    expect(getAgentLastSession('a1', NODE_A)?.sessionId).toBe('sess-new')
    expect(agentForSession('sess-new')).toBe('a1')
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

  it('migration persist does NOT bump — reads run in render phase', () => {
    localStorage.setItem(
      'rivethub.agent.lastSession',
      JSON.stringify({ a1: { sessionId: 'legacy-1', nodeBaseUrl: NODE_A } }),
    )
    const seen: number[] = []
    const unsub = subscribeAgentSessions(() => seen.push(getAgentSessionsVersion()))
    const before = getAgentSessionsVersion()
    // listAllAgentPins runs inside ChatPage's render-phase useMemo; firing the
    // migration there must not update the store during render.
    getAgentLastSession('a1', NODE_A)
    expect(getAgentSessionsVersion()).toBe(before)
    expect(seen).toEqual([])
    // A real write still notifies afterwards (the silent path did not wedge
    // the listener set).
    setAgentLastSession('a2', 'sess-x', NODE_A)
    expect(seen.length).toBe(1)
    unsub()
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
