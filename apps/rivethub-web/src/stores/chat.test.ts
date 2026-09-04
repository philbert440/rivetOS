// Instant-resume pointer (lastActive): the reducer writes/moves/drops it,
// the lastActiveFor selector node-matches it, and the persist middleware
// round-trips it. Connection store mocked away (it touches
// window/localStorage at import time); localStorage stubbed for persist.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const BASE = 'http://gateway.test'

// createJSONStorage(() => localStorage) runs at store-module evaluation.
// Stub before that import (vi.hoisted runs before ESM imports).
vi.hoisted(() => {
  const m = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } satisfies Storage)
})

vi.mock('./connection.js', () => ({
  isValidGatewayUrl: () => true,
  useConnection: {
    getState: () => ({
      baseUrl: BASE,
      gateway: {
        watchSessions: () => ({ close: () => undefined, send: () => true }),
      },
    }),
  },
}))

afterAll(() => vi.unstubAllGlobals())

const { useChat, lastActiveFor } = await import('./chat.js')

beforeEach(() => {
  useChat.setState({
    messages: {},
    transcripts: {},
    live: {},
    liveTs: {},
    ask: {},
    outbound: {},
    harnessBound: {},
    approvals: {},
    opened: [],
    drafts: [],
    draftCreatedAt: {},
    active: undefined,
    lastActive: undefined,
  })
  localStorage.removeItem('rivethub.chat')
})

describe('lastActive reducer', () => {
  it('setActive writes the resume pointer (key + node) and persists it', () => {
    useChat.getState().setActive('claude-code:abc')
    expect(useChat.getState().lastActive).toEqual({ sessionId: 'claude-code:abc', baseUrl: BASE })
    const raw = localStorage.getItem('rivethub.chat')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '') as {
      state: Record<string, unknown>
      version: number
    }
    expect(parsed.state.lastActive).toEqual({ sessionId: 'claude-code:abc', baseUrl: BASE })
    expect(parsed.version).toBe(1)
    // Only the pointer persists — live socket state never does.
    expect(parsed.state.messages).toBeUndefined()
    expect(parsed.state.active).toBeUndefined()
    expect(parsed.state.opened).toBeUndefined()
  })

  it('deselecting keeps the pointer (it is for resume, not selection)', () => {
    useChat.getState().setActive('claude-code:abc')
    useChat.getState().setActive(undefined)
    expect(useChat.getState().active).toBeUndefined()
    expect(useChat.getState().lastActive?.sessionId).toBe('claude-code:abc')
  })

  it('rekey moves the pointer onto the new key', () => {
    useChat.getState().setActive('bare-uuid')
    useChat.getState().rekey('bare-uuid', 'claude-code:bare-uuid')
    expect(useChat.getState().lastActive?.sessionId).toBe('claude-code:bare-uuid')
  })

  it('rekey of an unrelated key leaves the pointer alone', () => {
    useChat.getState().setActive('claude-code:abc')
    useChat.getState().rekey('someone-else', 'claude-code:someone-else')
    expect(useChat.getState().lastActive?.sessionId).toBe('claude-code:abc')
  })

  it('removeDraft drops a pointer at the discarded draft', () => {
    useChat.getState().addDraft('draft-1')
    useChat.getState().setActive('draft-1')
    expect(useChat.getState().lastActive?.sessionId).toBe('draft-1')
    useChat.getState().removeDraft('draft-1')
    expect(useChat.getState().lastActive).toBeUndefined()
  })

  it('clearLastActive forgets the pointer (stale resume fallback)', () => {
    useChat.getState().setActive('claude-code:abc')
    useChat.getState().clearLastActive()
    expect(useChat.getState().lastActive).toBeUndefined()
    const parsed = JSON.parse(localStorage.getItem('rivethub.chat') ?? '') as {
      state: Record<string, unknown>
    }
    expect(parsed.state.lastActive).toBeUndefined()
  })

  it('persists across a rehydrate (reload resumes the same session)', async () => {
    useChat.getState().setActive('claude-code:abc')
    const raw = localStorage.getItem('rivethub.chat')
    // Simulate a fresh reload: only the persisted slice (lastActive) is on
    // disk; the in-memory store starts blank (active undefined, lastActive
    // undefined) before rehydrate restores the pointer.
    useChat.setState({ lastActive: undefined, active: undefined })
    localStorage.setItem('rivethub.chat', raw ?? '')
    await useChat.persist.rehydrate()
    expect(useChat.getState().lastActive).toEqual({ sessionId: 'claude-code:abc', baseUrl: BASE })
    // The selection itself is NOT restored — resolving it is the launch
    // effect's job (the row may be gone after a reload).
    expect(useChat.getState().active).toBeUndefined()
  })
})

describe('lastActiveFor', () => {
  it('returns the key only for the node it was written on', () => {
    const pointer = { sessionId: 'claude-code:abc', baseUrl: BASE }
    expect(lastActiveFor(pointer, BASE)).toBe('claude-code:abc')
    expect(lastActiveFor(pointer, 'http://other.test')).toBeUndefined()
    expect(lastActiveFor(undefined, BASE)).toBeUndefined()
  })
})
