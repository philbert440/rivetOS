import './test-dom.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentFilter } from '../../stores/agent-filter.js'
import { useChat } from '../../stores/chat.js'
import { useChatSettings } from '../../stores/chat-settings.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { applyChooser } from './new-thread.js'

beforeEach(() => {
  localStorage.removeItem('rivethub.spaces')
  useSpaces.setState({ spaces: [], membership: {} })
  useChat.setState({ drafts: [], active: undefined, outbound: {} })
  useChatSettings.setState({ byKey: {} })
  useAgentFilter.getState().clear()
})

function snap(): {
  membership: Record<string, string>
  drafts: string[]
  outbound: unknown
  settings: unknown
} {
  return {
    membership: { ...useSpaces.getState().membership },
    drafts: [...useChat.getState().drafts],
    outbound: { ...useChat.getState().outbound },
    settings: { ...useChatSettings.getState().byKey },
  }
}

describe('applyChooser', () => {
  it('prompt path writes settings, membership, and one queued turn', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    const id = applyChooser({
      type: 'prompt',
      prompt: 'do the thing',
      spaceId,
      baseUrl: base,
      agent: {
        id: 'agent-1',
        harnessId: 'claude-code',
        model: 'claude-sonnet',
        effort: 'medium',
        systemPrompt: '',
        sourceNodeBaseUrl: base,
      },
      model: 'chosen-model',
      effort: 'high',
    })
    expect(id).toBeTruthy()
    if (!id) return
    const key = `${base}::${id}`
    expect(useSpaces.getState().spaceOf(key)).toBe(spaceId)
    expect(useChatSettings.getState().byKey[key]).toMatchObject({
      model: 'chosen-model',
      effort: 'high',
      harnessEffort: 'high',
      agentId: 'agent-1',
    })
    expect(useChat.getState().drafts).toContain(id)
    expect(useChat.getState().outbound[id]).toHaveLength(1)
    expect(useChat.getState().outbound[id]?.[0]?.text).toBe('do the thing')
  })

  it('history path places the row and opens it', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    const key = `${base}::row-1`
    const opened: string[] = []
    const id = applyChooser({
      type: 'history',
      rowKey: key,
      spaceId,
      sessionId: 'row-1',
      open: (sessionId) => {
        opened.push(sessionId)
      },
    })
    expect(id).toBe('row-1')
    expect(opened).toEqual(['row-1'])
    expect(useSpaces.getState().spaceOf(key)).toBe(spaceId)
  })

  it('cancel, a blank prompt, and an unknown space write nothing', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    const before = snap()
    expect(applyChooser({ type: 'cancel' })).toBeUndefined()
    expect(snap()).toEqual(before)
    expect(applyChooser({ type: 'prompt', prompt: '   ', spaceId, baseUrl: base })).toBeUndefined()
    expect(snap()).toEqual(before)
    expect(
      applyChooser({ type: 'prompt', prompt: 'hello', spaceId: 'missing', baseUrl: base }),
    ).toBeUndefined()
    expect(snap()).toEqual(before)
  })
})
