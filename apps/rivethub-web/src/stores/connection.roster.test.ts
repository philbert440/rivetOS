/**
 * Roster surgery on the connection store — updateNode semantics. The store
 * touches window/localStorage at import, so browser globals are stubbed
 * BEFORE the dynamic import (same reason chat.harness.test mocks the store).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

let useConnection: typeof import('./connection.js')['useConnection']

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('window', { location: { origin: 'http://192.0.2.1:5174' } })
  ;({ useConnection } = await import('./connection.js'))
})

const NODE_A = { name: 'alpha', baseUrl: 'https://192.0.2.10:5174' }
const NODE_B = { name: 'beta', baseUrl: 'https://192.0.2.11:5174' }

describe('updateNode', () => {
  beforeEach(() => {
    // reset roster to a known two-node state
    for (const n of [...useConnection.getState().roster]) {
      useConnection.getState().removeNode(n.baseUrl)
    }
    useConnection.getState().addNode(NODE_A)
    useConnection.getState().addNode(NODE_B)
  })

  it('renames in place, keeping position', () => {
    useConnection.getState().updateNode(NODE_A.baseUrl, { name: 'alpha2', baseUrl: NODE_A.baseUrl })
    const roster = useConnection.getState().roster
    expect(roster.map((n) => n.name)).toEqual(['alpha2', 'beta'])
  })

  it('repoints a row to a new URL', () => {
    useConnection.getState().updateNode(NODE_A.baseUrl, {
      name: 'alpha',
      baseUrl: 'https://192.0.2.12:5174',
    })
    const roster = useConnection.getState().roster
    expect(roster[0]).toEqual({ name: 'alpha', baseUrl: 'https://192.0.2.12:5174' })
    expect(roster).toHaveLength(2)
  })

  it('absorbs a collision with another row instead of duplicating', () => {
    useConnection.getState().updateNode(NODE_A.baseUrl, { name: 'alpha', baseUrl: NODE_B.baseUrl })
    const roster = useConnection.getState().roster
    expect(roster).toHaveLength(1)
    expect(roster[0]).toEqual({ name: 'alpha', baseUrl: NODE_B.baseUrl })
  })

  it('rejects invalid URLs and empty names', () => {
    useConnection.getState().updateNode(NODE_A.baseUrl, { name: 'x', baseUrl: 'ftp://nope' })
    useConnection.getState().updateNode(NODE_A.baseUrl, { name: '  ', baseUrl: NODE_A.baseUrl })
    expect(useConnection.getState().roster).toEqual([NODE_A, NODE_B])
  })

  it('repoints the live connection when the active node is edited', () => {
    useConnection.getState().switchTo(NODE_A.baseUrl)
    useConnection.getState().updateNode(NODE_A.baseUrl, {
      name: 'alpha',
      baseUrl: 'https://192.0.2.13:5174',
    })
    expect(useConnection.getState().baseUrl).toBe('https://192.0.2.13:5174')
    expect(localStorage.getItem('rivethub.baseUrl')).toBe('https://192.0.2.13:5174')
  })

  it('keeps the active connection put when an INACTIVE row is edited onto its URL', () => {
    useConnection.getState().switchTo(NODE_B.baseUrl)
    // alpha edited onto beta's URL — beta (active) is absorbed, but the live
    // connection must not move or churn.
    useConnection.getState().updateNode(NODE_A.baseUrl, { name: 'alpha', baseUrl: NODE_B.baseUrl })
    expect(useConnection.getState().roster).toEqual([{ name: 'alpha', baseUrl: NODE_B.baseUrl }])
    expect(useConnection.getState().baseUrl).toBe(NODE_B.baseUrl)
  })

  it('rename-only on the active node causes zero connection churn', () => {
    useConnection.getState().switchTo(NODE_A.baseUrl)
    const before = useConnection.getState()
    useConnection.getState().updateNode(NODE_A.baseUrl, { name: 'renamed', baseUrl: NODE_A.baseUrl })
    const after = useConnection.getState()
    expect(after.baseUrl).toBe(NODE_A.baseUrl)
    expect(after.gateway).toBe(before.gateway)
    expect(after.transportEpoch).toBe(before.transportEpoch)
  })

  it('ignores edits to unknown rows', () => {
    useConnection.getState().updateNode('https://192.0.2.99:5174', { name: 'x', baseUrl: NODE_A.baseUrl })
    expect(useConnection.getState().roster).toHaveLength(2)
  })
})

describe('switchTo', () => {
  beforeEach(() => {
    for (const n of [...useConnection.getState().roster]) {
      useConnection.getState().removeNode(n.baseUrl)
    }
    useConnection.getState().addNode(NODE_A)
    useConnection.getState().addNode(NODE_B)
  })

  it('returns false when the node is missing from the roster', () => {
    expect(useConnection.getState().switchTo('https://192.0.2.99:5174')).toBe(false)
    expect(useConnection.getState().baseUrl).not.toBe('https://192.0.2.99:5174')
  })

  it('returns true when the switch lands', () => {
    expect(useConnection.getState().switchTo(NODE_A.baseUrl)).toBe(true)
    expect(useConnection.getState().baseUrl).toBe(NODE_A.baseUrl)
  })
})
