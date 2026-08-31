import { afterAll, describe, expect, it, vi } from 'vitest'

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
afterAll(() => vi.unstubAllGlobals())

// The connection store touches window at import time and nothing here needs
// a gateway — same mock shape as chat.harness.test.ts.
vi.mock('../stores/connection.js', () => ({
  isValidGatewayUrl: () => true,
  useConnection: {
    getState: () => ({ baseUrl: 'http://gateway.test', gateway: {} }),
  },
}))

const { discardDraft } = await import('./discard-session.js')
const { useChat } = await import('../stores/chat.js')
const { useChatSettings } = await import('../stores/chat-settings.js')
const { useSessionNames } = await import('../stores/session-names.js')
const { useArchived } = await import('../stores/archived.js')
const { getSessionMode, setSessionMode } = await import('./session-mode.js')
const { markSystemPromptSent, wasSystemPromptSent } = await import('./system-prompt-sent.js')
const { getAgentLastSession, setAgentLastSession } = await import('./agent-session.js')

const BASE = 'https://node.example'
const SID = 'draft-uuid-1'
const KEY = `${BASE}::${SID}`

describe('discardDraft', () => {
  it('drops every per-key trace of a draft', () => {
    // seed all the places a draft can leave state
    useChat.getState().addDraft(SID)
    useChat.getState().setActive(SID)
    useChat.getState().addOptimisticUser(SID, 'hello')
    useSessionNames.getState().set(KEY, 'my draft')
    useChatSettings.getState().set(KEY, { agent: 'claude' })
    useArchived.getState().archive(KEY)
    setSessionMode(KEY, 'terminal')
    markSystemPromptSent(SID)
    setAgentLastSession('agent-1', SID, BASE)

    discardDraft(BASE, SID)

    const chat = useChat.getState()
    expect(chat.drafts.includes(SID)).toBe(false)
    expect(chat.opened.includes(SID)).toBe(false)
    expect(chat.active).toBeUndefined()
    expect(chat.messages[SID]).toBeUndefined()
    expect(chat.transcripts[SID]).toBeUndefined()
    expect(useSessionNames.getState().get(KEY)).toBeUndefined()
    expect(useChatSettings.getState().byKey[KEY]).toBeUndefined()
    expect(useArchived.getState().isArchived(KEY)).toBe(false)
    expect(getSessionMode(KEY)).toBe('chat')
    expect(wasSystemPromptSent(SID)).toBe(false)
    expect(getAgentLastSession('agent-1', BASE)).toBeUndefined()
    expect(store.getItem(`rivethub.agent.${SID}`)).toBeNull()
  })

  it('leaves an agent pointer alone when it moved on to a newer session', () => {
    setAgentLastSession('agent-2', SID, BASE)
    setAgentLastSession('agent-2', 'newer-session', BASE, { replace: true })
    // stale bind key left behind on purpose for the test
    store.setItem(`rivethub.agent.${SID}`, 'agent-2')
    useChat.getState().addDraft(SID)

    discardDraft(BASE, SID)

    expect(getAgentLastSession('agent-2', BASE)?.sessionId).toBe('newer-session')
    expect(store.getItem(`rivethub.agent.${SID}`)).toBeNull()
  })

  it('clears the pin only when it still targets the discarded draft', () => {
    setAgentLastSession('agent-3', SID, BASE)
    useChat.getState().addDraft(SID)

    discardDraft(BASE, SID)

    expect(getAgentLastSession('agent-3', BASE)).toBeUndefined()
    expect(store.getItem(`rivethub.agent.${SID}`)).toBeNull()
  })
})
