import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionNodeBinding,
  getSessionNodeBinding,
  rekeySessionNodeBinding,
  resolveSessionNode,
  setSessionNodeBinding,
  touchSessionNodeBinding,
} from './session-node.js'

const NODE_A = 'https://192.0.2.10:5174'
const NODE_B = 'https://192.0.2.20:5174'
const HOME = 'https://192.0.2.1:5174'

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
    setSessionNodeBinding('s1', NODE_A, HOME)
    expect(getSessionNodeBinding('s1')).toBe(NODE_A)
    clearSessionNodeBinding('s1')
    expect(getSessionNodeBinding('s1')).toBeUndefined()
  })

  it('binding to the current node clears instead of storing (cross-node only)', () => {
    setSessionNodeBinding('s1', NODE_A, HOME)
    setSessionNodeBinding('s1', HOME, HOME)
    expect(getSessionNodeBinding('s1')).toBeUndefined()
    expect(store.getItem('rivethub.sessionNodes')).not.toContain(HOME)
  })

  it('reads are PEEKS — a bulk enumerate cannot rescue a stale entry from eviction', () => {
    setSessionNodeBinding('stale', NODE_A, HOME)
    for (let i = 0; i < 150; i++) setSessionNodeBinding(`s${String(i)}`, NODE_B, HOME)
    // a list/badge pass reading every id must not refresh recency
    expect(getSessionNodeBinding('stale')).toBe(NODE_A)
    for (let i = 150; i < 349; i++) setSessionNodeBinding(`s${String(i)}`, NODE_B, HOME)
    expect(getSessionNodeBinding('stale')).toBeUndefined()
  })

  it('an explicit TOUCH (the open thread) survives 200 newer writes', () => {
    setSessionNodeBinding('open-session', NODE_A, HOME)
    for (let i = 0; i < 150; i++) setSessionNodeBinding(`s${String(i)}`, NODE_B, HOME)
    touchSessionNodeBinding('open-session') // the session view's mount refresh
    for (let i = 150; i < 349; i++) setSessionNodeBinding(`s${String(i)}`, NODE_B, HOME)
    expect(getSessionNodeBinding('open-session')).toBe(NODE_A)
    expect(getSessionNodeBinding('s0')).toBeUndefined() // untouched oldest evicted
  })

  it('rekeys onto the canonical id, last write winning a destination collision', () => {
    setSessionNodeBinding('draft-1', NODE_A, HOME)
    rekeySessionNodeBinding('draft-1', 'claude-code:draft-1')
    expect(getSessionNodeBinding('draft-1')).toBeUndefined()
    expect(getSessionNodeBinding('claude-code:draft-1')).toBe(NODE_A)

    // The adoption is the live event: it replaces a leftover destination.
    setSessionNodeBinding('draft-2', NODE_B, HOME)
    rekeySessionNodeBinding('draft-2', 'claude-code:draft-1')
    expect(getSessionNodeBinding('claude-code:draft-1')).toBe(NODE_B)
    expect(getSessionNodeBinding('draft-2')).toBeUndefined()
  })
})

describe('resolveSessionNode', () => {
  const base = { currentBase: NODE_A, rosterUrls: [NODE_A, NODE_B] }

  it('pointer wins over binding; both beat the current node', () => {
    expect(resolveSessionNode({ ...base, pointerNode: NODE_B, binding: NODE_A })).toBe(NODE_B)
    expect(resolveSessionNode({ ...base, binding: NODE_B })).toBe(NODE_B)
    expect(resolveSessionNode(base)).toBe(NODE_A)
  })

  it('an off-roster BINDING falls back, warns, and reports for clearing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onInvalidBinding = vi.fn()
    expect(
      resolveSessionNode({ ...base, binding: 'https://192.0.2.99:5174', onInvalidBinding }),
    ).toBe(NODE_A)
    expect(onInvalidBinding).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('an off-roster POINTER falls back without touching the binding hook', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onInvalidBinding = vi.fn()
    expect(
      resolveSessionNode({ ...base, pointerNode: 'https://192.0.2.99:5174', onInvalidBinding }),
    ).toBe(NODE_A)
    expect(onInvalidBinding).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('an off-roster BINDING is reported even when a valid pointer wins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onInvalidBinding = vi.fn()
    expect(
      resolveSessionNode({
        ...base,
        pointerNode: NODE_B,
        binding: 'https://192.0.2.99:5174',
        onInvalidBinding,
      }),
    ).toBe(NODE_B)
    expect(onInvalidBinding).toHaveBeenCalledOnce() // rot cleared behind the win
    warn.mockRestore()
  })

  it('a candidate equal to the current node short-circuits validation', () => {
    expect(resolveSessionNode({ currentBase: NODE_A, rosterUrls: [], pointerNode: NODE_A })).toBe(
      NODE_A,
    )
  })
})
