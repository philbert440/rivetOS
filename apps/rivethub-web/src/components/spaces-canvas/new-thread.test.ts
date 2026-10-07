import './test-dom.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentForSession, getAgentPin } from '../../lib/agent-session.js'
import { getSessionNodeBinding } from '../../lib/session-node.js'
import { useAgentFilter } from '../../stores/agent-filter.js'
import { useChat } from '../../stores/chat.js'
import { useChatSettings } from '../../stores/chat-settings.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { bindSpaceThreadStarter, startNewConversation } from '../../lib/new-conversation.js'
import { applyChooser, initialThreadFields, startThreadInSpace } from './new-thread.js'
import { directoryBasename } from './space-defaults.js'

beforeEach(() => {
  localStorage.removeItem('rivethub.spaces')
  localStorage.removeItem('rivethub.agent.lastSession')
  localStorage.removeItem('rivethub.sessionNodes')
  useSpaces.setState({ spaces: [], membership: {} })
  useChat.setState({ drafts: [], active: undefined, outbound: {}, opened: [] })
  useChatSettings.setState({ byKey: {} })
  useAgentFilter.getState().clear()
  bindSpaceThreadStarter(null)
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

  it('plain draft stays on the hub when a remote rail agent is selected', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    useAgentFilter.getState().select({
      agentId: 'remote-agent',
      name: 'Remote',
      accent: '#abc',
      startNew: () => {
        throw new Error('plain draft must not call the rail startNew')
      },
    })
    const id = applyChooser({ type: 'prompt', prompt: 'hello', spaceId, baseUrl: base })
    expect(id).toBeTruthy()
    if (!id) return
    const key = `${base}::${id}`
    expect(useSpaces.getState().spaceOf(key)).toBe(spaceId)
    expect(useChatSettings.getState().byKey[key]).toMatchObject({ agent: '', effort: 'medium' })
    expect(getSessionNodeBinding(id)).toBeUndefined()
    expect(getAgentPin('remote-agent')).toBeUndefined()
    expect(agentForSession(id)).toBeUndefined()
  })

  it('files a chosen remote agent under that node', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.30:8787'
    const spaceId = useSpaces.getState().addSpace('Home')
    const id = applyChooser({
      type: 'prompt',
      prompt: 'ship it',
      spaceId,
      baseUrl: base,
      agent: {
        id: 'agent-remote',
        harnessId: 'claude-code',
        model: 'claude-sonnet',
        effort: 'low',
        systemPrompt: '',
        sourceNodeBaseUrl: remote,
      },
    })
    expect(id).toBeTruthy()
    if (!id) return
    const key = `${remote}::${id}`
    expect(useSpaces.getState().spaceOf(key)).toBe(spaceId)
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBeUndefined()
    expect(useChatSettings.getState().byKey[key]).toMatchObject({ agentId: 'agent-remote' })
    expect(useChatSettings.getState().byKey[`${base}::${id}`]).toBeUndefined()
    expect(getSessionNodeBinding(id)).toBe(remote)
    expect(agentForSession(id)).toBe('agent-remote')
  })

  it('refuses an agent that is not on a roster node', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    const before = snap()
    expect(
      applyChooser({
        type: 'prompt',
        prompt: 'hello',
        spaceId,
        baseUrl: base,
        agent: { id: 'off-roster', sourceNodeBaseUrl: '' },
      }),
    ).toBeUndefined()
    expect(useChat.getState().drafts).toEqual([])
    expect(snap()).toEqual(before)
  })

  it('plain prompt with a node default binds that node and keeps membership on the hub', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.40:8787'
    const spaceId = useSpaces.getState().addSpace('Home')
    const id = applyChooser({
      type: 'prompt',
      prompt: 'hello',
      spaceId,
      baseUrl: base,
      node: remote,
      model: 'opus',
      effort: 'low',
    })
    expect(id).toBeTruthy()
    if (!id) return
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBe(spaceId)
    expect(useSpaces.getState().spaceOf(`${remote}::${id}`)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'low',
      harnessEffort: 'low',
    })
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]?.agentId).toBeUndefined()
    expect(getSessionNodeBinding(id)).toBe(remote)
    expect(agentForSession(id)).toBeUndefined()
  })
})

const PRESET = {
  id: 'preset-1',
  name: 'Reviewer',
  harnessId: 'claude-code' as const,
  model: 'claude-sonnet',
  effort: 'medium',
  systemPrompt: 'be brief',
  sourceNodeBaseUrl: 'http://192.168.1.30:8787',
  node: 'den-a',
  directory: '/home/rivet/src/rivetOS',
}

describe('new thread in a space', () => {
  it('preset default writes the rail fields and binds the preset node', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      model: 'opus',
      effort: 'high',
      harnessId: 'claude-code',
    })
    const startNew = (): void => {
      throw new Error('space default must win over the rail')
    }
    useAgentFilter.getState().select({
      agentId: 'rail-agent',
      name: 'Rail',
      accent: '#abc',
      startNew,
    })
    const id = startThreadInSpace(spaceId, base, [PRESET])
    expect(id).toBeTruthy()
    if (!id) return
    const key = `${PRESET.sourceNodeBaseUrl}::${id}`
    expect(useSpaces.getState().spaceOf(key)).toBe(spaceId)
    expect(useChatSettings.getState().byKey[key]).toMatchObject({
      agent: 'claude',
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'opus',
      effort: 'high',
      harnessEffort: 'high',
      systemPrompt: 'be brief',
    })
    expect(getSessionNodeBinding(id)).toBe(PRESET.sourceNodeBaseUrl)
    expect(agentForSession(id)).toBe(PRESET.id)
    expect(getAgentPin(PRESET.id)?.sessionId).toBe(id)
  })

  it('model and effort only bind an explicit node and do not pin an agent', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.41:8787'
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      model: 'opus',
      effort: 'low',
      node: remote,
    })
    const id = startThreadInSpace(spaceId, base, [PRESET])
    expect(id).toBeTruthy()
    if (!id) return
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBe(spaceId)
    expect(useSpaces.getState().spaceOf(`${remote}::${id}`)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'low',
      harnessEffort: 'low',
    })
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]?.agentId).toBeUndefined()
    expect(getSessionNodeBinding(id)).toBe(remote)
    expect(agentForSession(id)).toBeUndefined()
  })

  it('no defaults places the draft and writes no settings or node binding', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    const bareBefore = { ...useChatSettings.getState().byKey }
    const id = startThreadInSpace(spaceId, base, [PRESET])
    expect(id).toBeTruthy()
    if (!id) return
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBe(spaceId)
    expect(useChatSettings.getState().byKey).toEqual(bareBefore)
    expect(useChatSettings.getState().byKey[`${base}::${id}`]).toBeUndefined()
    expect(getSessionNodeBinding(id)).toBeUndefined()
    expect(agentForSession(id)).toBeUndefined()
  })

  it('deleted preset starts without that agent and still applies model, effort, and node', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.42:8787'
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: 'gone',
      harnessId: 'claude-code',
      model: 'opus',
      effort: 'high',
      node: remote,
    })
    const id = startThreadInSpace(spaceId, base, [PRESET])
    expect(id).toBeTruthy()
    if (!id) return
    const settings = useChatSettings.getState().byKey[`${remote}::${id}`]
    expect(settings?.agentId).toBeUndefined()
    expect(settings?.harnessId).toBeUndefined()
    expect(settings).toMatchObject({ model: 'opus', effort: 'high', harnessEffort: 'high' })
    expect(getSessionNodeBinding(id)).toBe(remote)
    expect(agentForSession(id)).toBeUndefined()
    expect(getAgentPin('gone')).toBeUndefined()
    expect(initialThreadFields(useSpaces.getState().spaces[0]?.defaults, [PRESET]).agentId).toBe('')
  })

  it('space defaults beat a selected rail agent; outside a space the rail still runs', () => {
    const startNew = vi.fn()
    useAgentFilter.getState().select({
      agentId: 'rail-agent',
      name: 'Rail',
      accent: '#abc',
      startNew,
    })
    expect(startNewConversation()).toBeUndefined()
    expect(startNew).toHaveBeenCalledOnce()

    startNew.mockClear()
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, { model: 'opus', effort: 'low' })
    bindSpaceThreadStarter(() => startThreadInSpace(spaceId, base, []))
    const id = startNewConversation()
    expect(startNew).not.toHaveBeenCalled()
    expect(id).toBeTruthy()
    if (!id) return
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBe(spaceId)
    expect(useChatSettings.getState().byKey[`${base}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'low',
    })
    expect(directoryBasename('/home/rivet/src/rivetOS/')).toBe('rivetOS')
  })
})
