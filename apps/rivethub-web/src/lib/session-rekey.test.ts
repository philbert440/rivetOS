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

const store = memoryStorage()
vi.stubGlobal('localStorage', store)
vi.stubGlobal('sessionStorage', memoryStorage())
// connection.ts reads this at import, before it would touch `window`.
store.setItem('rivethub.baseUrl', 'http://192.168.1.20:8787')

const { agentForSession, getAgentPin, listAgentSessions, setAgentLastSession } =
  await import('./agent-session.js')
const { getSessionNodeBinding, sessionNodeFor, setSessionNodeBinding } =
  await import('./session-node.js')
const { adoptRegistrySession, migrateSessionKey, storageKey } = await import('./session-rekey.js')
const { useChat } = await import('../stores/chat.js')
const { useChatSettings } = await import('../stores/chat-settings.js')
const { useSessionNames } = await import('../stores/session-names.js')
const { useSpaces } = await import('../stores/spaces.js')

const HUB = 'https://hub:5174'
const NODE_B = 'https://node-b:5174'
const ROSTER = [HUB, NODE_B]

function resetChat(): void {
  useChat.setState({
    replyAcceptance: {},
    messages: {},
    transcripts: {},
    live: {},
    liveTs: {},
    ask: {},
    outbound: {},
    sessionAliases: {},
    harnessBound: {},
    approvals: {},
    agentStatus: {},
    prompts: {},
    liveSource: {},
    liveFloor: {},
    opened: [],
    drafts: [],
    draftCreatedAt: {},
    active: undefined,
    lastActive: undefined,
  })
}

describe('migrateSessionKey', () => {
  beforeEach(() => {
    store.clear()
    useSessionNames.setState({ byKey: {} })
    useChatSettings.setState({ byKey: {} })
    useSpaces.setState({ spaces: [], membership: {} })
    resetChat()
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

describe('adoptRegistrySession', () => {
  beforeEach(() => {
    store.clear()
    useSessionNames.setState({ byKey: {} })
    useChatSettings.setState({ byKey: {} })
    useSpaces.setState({ spaces: [], membership: {} })
    resetChat()
  })

  it('adopts a placed hub draft into the same space', () => {
    const bare = 'draft-bare-1'
    const canonical = `claude-code:${bare}`
    const space = useSpaces.getState().addSpace('Home')
    useChat.getState().addDraft(bare)
    useSpaces.getState().place(storageKey(HUB, bare), space)

    adoptRegistrySession(HUB, ROSTER, canonical)

    expect(useSpaces.getState().spaceOf(storageKey(HUB, canonical))).toBe(space)
    expect(useSpaces.getState().spaceOf(storageKey(HUB, bare))).toBeUndefined()
    expect(useChat.getState().opened).toContain(canonical)
    expect(useChat.getState().opened).not.toContain(bare)
  })

  it('adopts a remote-pinned draft on that node, not the hub', () => {
    const bare = 'draft-bare-remote'
    const canonical = `claude-code:${bare}`
    const space = useSpaces.getState().addSpace('Home')
    setAgentLastSession('a1', bare, NODE_B)
    setSessionNodeBinding(bare, NODE_B, HUB)
    useChat.getState().addDraft(bare)
    useSpaces.getState().place(storageKey(NODE_B, bare), space)

    adoptRegistrySession(HUB, ROSTER, canonical)

    expect(useSpaces.getState().spaceOf(storageKey(NODE_B, canonical))).toBe(space)
    expect(useSpaces.getState().spaceOf(storageKey(HUB, canonical))).toBeUndefined()
    expect(useSpaces.getState().spaceOf(storageKey(NODE_B, bare))).toBeUndefined()
    expect(sessionNodeFor(canonical, HUB, ROSTER)).toBe(NODE_B)
  })

  it('rotates a placed thread onto the successor key', () => {
    const previous = 'claude-code:native-old'
    const canonical = 'claude-code:native-new'
    const space = useSpaces.getState().addSpace('Home')
    useChat.getState().addDraft(previous)
    useSpaces.getState().place(storageKey(HUB, previous), space)

    adoptRegistrySession(HUB, ROSTER, canonical, previous)

    expect(useSpaces.getState().spaceOf(storageKey(HUB, canonical))).toBe(space)
    expect(useSpaces.getState().spaceOf(storageKey(HUB, previous))).toBeUndefined()
  })

  it('does not move membership when the chat records refuse to merge', () => {
    const bare = 'draft-bare-collide'
    const canonical = `claude-code:${bare}`
    const space = useSpaces.getState().addSpace('Home')
    useChat.getState().addOptimisticUser(canonical, 'already live')
    useChat.getState().addDraft(bare)
    useSpaces.getState().place(storageKey(HUB, bare), space)

    adoptRegistrySession(HUB, ROSTER, canonical)

    expect(useSpaces.getState().spaceOf(storageKey(HUB, bare))).toBe(space)
    expect(useSpaces.getState().spaceOf(storageKey(HUB, canonical))).toBeUndefined()
  })

  it('keeps a destination that is already placed and drops the draft', () => {
    const bare = 'draft-bare-both'
    const canonical = `claude-code:${bare}`
    const draftSpace = useSpaces.getState().addSpace('Drafts')
    const liveSpace = useSpaces.getState().addSpace('Live')
    useChat.getState().addDraft(bare)
    useSpaces.getState().place(storageKey(HUB, bare), draftSpace)
    useSpaces.getState().place(storageKey(HUB, canonical), liveSpace)

    adoptRegistrySession(HUB, ROSTER, canonical)

    expect(useSpaces.getState().spaceOf(storageKey(HUB, canonical))).toBe(liveSpace)
    expect(useSpaces.getState().spaceOf(storageKey(HUB, bare))).toBeUndefined()
  })
})
