import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentForSession,
  getAgentPin,
  listAgentSessions,
  setAgentLastSession,
} from './agent-session.js'
import { getSessionNodeBinding, sessionNodeFor, setSessionNodeBinding } from './session-node.js'
import { migrateSessionKey, storageKey } from './session-rekey.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { useSessionNames } from '../stores/session-names.js'

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

const HUB = 'https://hub:5174'
const NODE_B = 'https://node-b:5174'
const ROSTER = [HUB, NODE_B]

describe('migrateSessionKey', () => {
  beforeEach(() => {
    store.clear()
    useSessionNames.setState({ byKey: {} })
    useChatSettings.setState({ byKey: {} })
  })

  // B1 (PR #597 review): the Remote404 success path — GET 404, list-scan hits
  // a claimed id, useChat.rekey() returns true — runs migrateSessionKey and
  // NOTHING else. If the agent pin or the node binding stayed on the old id,
  // the next poll would resolve the dead id and snap the thread back.
  it('retargets the agent pin and node binding, so a later poll cannot snap back', () => {
    // Agent pinned to the old id on its home node; the open thread bound there.
    setAgentLastSession('a1', 'old-id', NODE_B)
    setSessionNodeBinding('old-id', NODE_B, HUB)
    useSessionNames.getState().set(storageKey(NODE_B, 'old-id'), 'my thread')
    useChatSettings.getState().set(storageKey(NODE_B, 'old-id'), { agent: 'claude' })

    migrateSessionKey(HUB, ROSTER, 'old-id', 'claude-code:new-id')

    // Pin + reverse bind point at the new id; nothing remains on the old one.
    expect(getAgentPin('a1')).toEqual({
      sessionId: 'claude-code:new-id',
      nodeBaseUrl: NODE_B,
      updatedAt: expect.any(Number),
    })
    expect(agentForSession('claude-code:new-id')).toBe('a1')
    expect(agentForSession('old-id')).toBeUndefined()
    expect(getSessionNodeBinding('claude-code:new-id')).toBe(NODE_B)
    expect(getSessionNodeBinding('old-id')).toBeUndefined()

    // A subsequent poll tick resolves the NEW id — no snap-back.
    expect(listAgentSessions('a1')[0]?.sessionId).toBe('claude-code:new-id')
    expect(sessionNodeFor('claude-code:new-id', HUB, ROSTER)).toBe(NODE_B)

    // Per-thread persisted state moved with the key, nothing left behind.
    expect(useSessionNames.getState().byKey[storageKey(NODE_B, 'claude-code:new-id')]).toBe(
      'my thread',
    )
    expect(useSessionNames.getState().byKey[storageKey(NODE_B, 'old-id')]).toBeUndefined()
    expect(useChatSettings.getState().byKey[storageKey(NODE_B, 'claude-code:new-id')]?.agent).toBe(
      'claude',
    )
    expect(useChatSettings.getState().byKey[storageKey(NODE_B, 'old-id')]).toBeUndefined()
  })

  it('does not clobber a surviving destination name or settings', () => {
    setAgentLastSession('a1', 'old-id', NODE_B)
    setSessionNodeBinding('old-id', NODE_B, HUB)
    useSessionNames.getState().set(storageKey(NODE_B, 'old-id'), 'retired name')
    useSessionNames.getState().set(storageKey(NODE_B, 'claude-code:new-id'), 'survivor name')
    useChatSettings.getState().set(storageKey(NODE_B, 'claude-code:new-id'), { agent: 'grok' })

    migrateSessionKey(HUB, ROSTER, 'old-id', 'claude-code:new-id')

    expect(useSessionNames.getState().byKey[storageKey(NODE_B, 'claude-code:new-id')]).toBe(
      'survivor name',
    )
    expect(useChatSettings.getState().byKey[storageKey(NODE_B, 'claude-code:new-id')]?.agent).toBe(
      'grok',
    )
    // The retired key is cleared even on collision — a half-migrated key would
    // resurrect through the read fallback on a later id reuse.
    expect(useSessionNames.getState().byKey[storageKey(NODE_B, 'old-id')]).toBeUndefined()
  })
})
