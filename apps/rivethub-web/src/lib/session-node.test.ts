import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionNodeBinding,
  getSessionNodeBinding,
  rekeySessionNodeBinding,
  resolveSessionNode,
  setSessionNodeBinding,
} from './session-node.js'

const NODE_A = 'https://192.0.2.10:5174'
const NODE_B = 'https://192.0.2.20:5174'

describe('session node bindings', () => {
  let store: Storage

  beforeEach(() => {
    const data = new Map<string, string>()
    store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    } as Storage
    vi.stubGlobal('localStorage', store)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sets, gets and clears a binding', () => {
    setSessionNodeBinding('s1', NODE_A)
    expect(getSessionNodeBinding('s1')).toBe(NODE_A)
    clearSessionNodeBinding('s1')
    expect(getSessionNodeBinding('s1')).toBeUndefined()
  })

  it('re-binding moves the key to the LRU tail so it survives overflow', () => {
    for (let i = 0; i < 200; i++) setSessionNodeBinding(`s${String(i)}`, NODE_A)
    setSessionNodeBinding('s0', NODE_B) // touch — s0 must now be newest
    setSessionNodeBinding('overflow', NODE_A)
    expect(getSessionNodeBinding('s0')).toBe(NODE_B)
    expect(getSessionNodeBinding('s1')).toBeUndefined() // true oldest evicted
  })

  it('rekeys a binding onto the canonical id without clobbering an existing one', () => {
    setSessionNodeBinding('draft-1', NODE_A)
    rekeySessionNodeBinding('draft-1', 'claude-code:draft-1')
    expect(getSessionNodeBinding('draft-1')).toBeUndefined()
    expect(getSessionNodeBinding('claude-code:draft-1')).toBe(NODE_A)

    setSessionNodeBinding('draft-2', NODE_B)
    rekeySessionNodeBinding('draft-2', 'claude-code:draft-1') // collision: keep existing
    expect(getSessionNodeBinding('claude-code:draft-1')).toBe(NODE_A)
  })
})

describe('resolveSessionNode', () => {
  const base = { currentBase: NODE_A, rosterUrls: [NODE_A, NODE_B] }

  it('pointer wins over binding; both beat the current node', () => {
    expect(resolveSessionNode({ ...base, pointerNode: NODE_B, binding: NODE_A })).toBe(NODE_B)
    expect(resolveSessionNode({ ...base, binding: NODE_B })).toBe(NODE_B)
    expect(resolveSessionNode(base)).toBe(NODE_A)
  })

  it('an off-roster candidate falls back to the current node with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(resolveSessionNode({ ...base, pointerNode: 'https://192.0.2.99:5174' })).toBe(NODE_A)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('a candidate equal to the current node short-circuits validation', () => {
    expect(
      resolveSessionNode({ currentBase: NODE_A, rosterUrls: [], pointerNode: NODE_A }),
    ).toBe(NODE_A)
  })
})
