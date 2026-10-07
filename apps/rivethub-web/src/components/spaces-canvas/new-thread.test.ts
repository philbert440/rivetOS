import './test-dom.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import { agentForSession, getAgentPin } from '../../lib/agent-session.js'
import type { ChatItem } from '../../lib/harness-chat.js'
import {
  getSessionNodeBinding,
  resolveSessionNode,
  sessionNodeFor,
  setSessionNodeBinding,
} from '../../lib/session-node.js'
import { adoptRegistrySession, storageKey } from '../../lib/session-rekey.js'
import {
  DELETED_PRESET_NOTICE,
  presetHasHarnessFlag,
  recoverDeletedAgentSpawn,
  termSpawnBody,
} from '../../lib/term-spawn.js'
import { useAgentFilter } from '../../stores/agent-filter.js'
import { useChat } from '../../stores/chat.js'
import { useChatSettings } from '../../stores/chat-settings.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { bindSpaceThreadStarter, startNewConversation } from '../../lib/new-conversation.js'
import {
  applyChooser,
  initialThreadFields,
  offRosterStartNotice,
  resolveRosterNode,
  startThreadInSpace,
  canStartThread,
  takeOffRosterNotice,
} from './new-thread.js'
import { buildCanvasRegions } from './canvas-regions.js'
import { defaultAgentChip, directoryBasename } from './space-defaults.js'

beforeEach(() => {
  localStorage.removeItem('rivethub.spaces')
  localStorage.removeItem('rivethub.agent.lastSession')
  localStorage.removeItem('rivethub.sessionNodes')
  localStorage.removeItem('rivethub.roster')
  useConnection.setState({ roster: [] })
  useSpaces.setState({ spaces: [], membership: {} })
  useChat.setState({ drafts: [], active: undefined, outbound: {}, opened: [] })
  useChatSettings.setState({ byKey: {} })
  useAgentFilter.getState().clear()
  bindSpaceThreadStarter(null)
  takeOffRosterNotice()
})

function listOnRoster(baseUrl: string, name: string): void {
  useConnection.getState().addNode({ name, baseUrl })
}

function rosterUrls(): string[] {
  return useConnection.getState().roster.map((node) => node.baseUrl)
}

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

  it('carries the space default preset that was deleted, but not on an explicit plain draft', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    const kept = applyChooser({
      type: 'prompt',
      prompt: 'hello',
      spaceId,
      baseUrl: base,
      model: 'm2',
      missingPreset: { agentId: 'gone' },
    })
    expect(kept).toBeTruthy()
    if (!kept) return
    expect(useChatSettings.getState().byKey[`${base}::${kept}`]).toMatchObject({
      agentId: 'gone',
      model: 'm2',
    })
    const plain = applyChooser({ type: 'prompt', prompt: 'hello', spaceId, baseUrl: base })
    expect(plain).toBeTruthy()
    if (!plain) return
    expect(useChatSettings.getState().byKey[`${base}::${plain}`]?.agentId).toBeUndefined()
  })

  it('files a chosen remote agent under that node', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.30:8787'
    listOnRoster(remote, 'den-a')
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

  it('plain prompt with a node default binds that node and places membership there', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.40:8787'
    listOnRoster(remote, 'node-b')
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
    expect(useSpaces.getState().spaceOf(`${remote}::${id}`)).toBe(spaceId)
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'low',
      harnessEffort: 'low',
    })
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]?.agentId).toBeUndefined()
    expect(getSessionNodeBinding(id)).toBe(remote)
    expect(sessionNodeFor(id, base, rosterUrls())).toBe(remote)
    expect(agentForSession(id)).toBeUndefined()
  })

  it('falls back to the hub when the explicit node has left the roster', () => {
    const base = useConnection.getState().baseUrl
    const gone = 'http://192.168.1.40:8787'
    const spaceId = useSpaces.getState().addSpace('Home')
    const id = applyChooser({
      type: 'prompt',
      prompt: 'hello',
      spaceId,
      baseUrl: base,
      node: gone,
      model: 'opus',
      effort: 'high',
    })
    expect(id).toBeTruthy()
    if (!id) return
    expect(getSessionNodeBinding(id)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${gone}::${id}`]).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${base}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'high',
      harnessEffort: 'high',
    })
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBe(spaceId)
    expect(useSpaces.getState().spaceOf(`${gone}::${id}`)).toBeUndefined()
    expect(sessionNodeFor(id, base, rosterUrls())).toBe(base)
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
    listOnRoster(PRESET.sourceNodeBaseUrl, 'den-a')
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
    listOnRoster(remote, 'node-b')
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      model: 'opus',
      effort: 'low',
      node: remote,
    })
    const id = startThreadInSpace(spaceId, base, [PRESET])
    expect(id).toBeTruthy()
    if (!id) return
    expect(useSpaces.getState().spaceOf(`${remote}::${id}`)).toBe(spaceId)
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'low',
      harnessEffort: 'low',
    })
    expect(useChatSettings.getState().byKey[`${remote}::${id}`]?.agentId).toBeUndefined()
    expect(getSessionNodeBinding(id)).toBe(remote)
    expect(sessionNodeFor(id, base, rosterUrls())).toBe(remote)
    expect(agentForSession(id)).toBeUndefined()
    expect(takeOffRosterNotice()).toBeUndefined()
  })

  it('keeps a node-only draft in the space after the canonical id is adopted', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.41:8787'
    listOnRoster(remote, 'node-b')
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      model: 'opus',
      effort: 'low',
      node: remote,
    })
    const id = startThreadInSpace(spaceId, base, [])
    expect(id).toBeTruthy()
    if (!id) return
    expect(useSpaces.getState().spaceOf(`${remote}::${id}`)).toBe(spaceId)
    expect(sessionNodeFor(id, base, rosterUrls())).toBe(remote)

    const draft: ChatItem = { key: id, kind: 'draft', title: 'new conversation', updatedAt: 0 }
    const onCanvas = (rows: ChatItem[]): string[] => {
      const region = buildCanvasRegions({
        spaces: useSpaces.getState().spaces,
        rows,
        membership: useSpaces.getState().membership,
        baseUrl: base,
        frozenKeys: null,
      }).find((item) => item.id === spaceId)
      return region?.rows.map((row) => row.key) ?? []
    }
    expect(onCanvas([draft])).toEqual([id])

    const canonical = `claude-code:${id}`
    adoptRegistrySession(base, rosterUrls(), canonical)

    const adopted: ChatItem = {
      key: canonical,
      kind: 'harness',
      title: 'adopted',
      updatedAt: 1,
      harnessId: 'claude-code',
    }
    expect(onCanvas([adopted])).toEqual([canonical])
    expect(useSpaces.getState().spaceOf(`${remote}::${canonical}`)).toBe(spaceId)
    expect(useSpaces.getState().spaceOf(`${remote}::${id}`)).toBeUndefined()
    expect(useSpaces.getState().spaceOf(`${base}::${canonical}`)).toBeUndefined()
    expect(sessionNodeFor(canonical, base, rosterUrls())).toBe(remote)
  })

  it('keeps a hub placement when the session is also bound to another node', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.41:8787'
    listOnRoster(remote, 'node-b')
    const spaceId = useSpaces.getState().addSpace('Home')
    const id = 'hub-placed'
    setSessionNodeBinding(id, remote, base)
    useSpaces.getState().place(`${base}::${id}`, spaceId)
    const row: ChatItem = { key: id, kind: 'legacy', title: 'kept', updatedAt: 0 }
    const region = buildCanvasRegions({
      spaces: useSpaces.getState().spaces,
      rows: [row],
      membership: useSpaces.getState().membership,
      baseUrl: base,
      frozenKeys: null,
    }).find((item) => item.id === spaceId)
    expect(region?.rows.map((item) => item.key)).toEqual([id])
  })

  it('buildCanvasRegions uses the membership map it is given, not the store', () => {
    const base = useConnection.getState().baseUrl
    const home = useSpaces.getState().addSpace('Home')
    const other = useSpaces.getState().addSpace('Other')
    const id = 'snap'
    useSpaces.getState().place(storageKey(base, id), home)
    const item: ChatItem = { key: id, kind: 'legacy', title: 'snap', updatedAt: 0 }
    const regions = buildCanvasRegions({
      spaces: useSpaces.getState().spaces,
      rows: [item],
      membership: { [storageKey(base, id)]: other },
      baseUrl: base,
      frozenKeys: null,
    })
    expect(regions.find((region) => region.id === other)?.rows.map((row) => row.key)).toEqual([id])
    expect(regions.find((region) => region.id === home)?.rows ?? []).toEqual([])
  })

  it('files a bound-off-hub row under the snapshot membership, not the store', () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.41:8787'
    listOnRoster(remote, 'node-b')
    const spaceId = useSpaces.getState().addSpace('Away')
    const id = 'remote-row'
    setSessionNodeBinding(id, remote, base)
    const item: ChatItem = { key: id, kind: 'legacy', title: 'remote', updatedAt: 0 }
    const regions = buildCanvasRegions({
      spaces: useSpaces.getState().spaces,
      rows: [item],
      membership: { [storageKey(remote, id)]: spaceId },
      baseUrl: base,
      frozenKeys: null,
    })
    expect(regions.find((region) => region.id === spaceId)?.rows.map((row) => row.key)).toEqual([
      id,
    ])
  })

  it('does not write a node-only default whose node left the roster', () => {
    const base = useConnection.getState().baseUrl
    const gone = 'http://192.168.1.49:8787'
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      model: 'opus',
      effort: 'high',
      node: gone,
    })
    const id = startThreadInSpace(spaceId, base, [])
    expect(id).toBeTruthy()
    if (!id) return
    expect(getSessionNodeBinding(id)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${gone}::${id}`]).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${base}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'high',
    })
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBe(spaceId)
    expect(sessionNodeFor(id, base, rosterUrls())).toBe(base)
    expect(agentForSession(id)).toBeUndefined()
    expect(takeOffRosterNotice()).toBe(offRosterStartNotice(gone, base))
  })

  it('does not pin a preset whose node left the roster', () => {
    const base = useConnection.getState().baseUrl
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'opus',
      effort: 'high',
    })
    const id = startThreadInSpace(spaceId, base, [PRESET])
    expect(id).toBeTruthy()
    if (!id) return
    expect(getSessionNodeBinding(id)).toBeUndefined()
    expect(agentForSession(id)).toBeUndefined()
    expect(getAgentPin(PRESET.id)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${PRESET.sourceNodeBaseUrl}::${id}`]).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${base}::${id}`]?.agentId).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${base}::${id}`]).toMatchObject({
      model: 'opus',
      effort: 'high',
    })
    expect(useSpaces.getState().spaceOf(`${base}::${id}`)).toBe(spaceId)
    expect(sessionNodeFor(id, base, rosterUrls())).toBe(base)
    expect(takeOffRosterNotice()).toBe(offRosterStartNotice(PRESET.sourceNodeBaseUrl, base))
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

  it('deleted preset starts without that agent and still applies model, effort, and node', async () => {
    const base = useConnection.getState().baseUrl
    const remote = 'http://192.168.1.42:8787'
    listOnRoster(remote, 'node-b')
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
    expect(settings?.agentId).toBe('gone')
    expect(settings?.harnessId).toBe('claude-code')
    expect(settings).toMatchObject({ model: 'opus', effort: 'high', harnessEffort: 'high' })
    expect(getSessionNodeBinding(id)).toBe(remote)
    expect(useSpaces.getState().spaceOf(`${remote}::${id}`)).toBe(spaceId)
    expect(agentForSession(id)).toBeUndefined()
    expect(getAgentPin('gone')).toBeUndefined()
    expect(initialThreadFields(useSpaces.getState().spaces[0]?.defaults, [PRESET]).agentId).toBe('')
    const body = termSpawnBody({
      sessionId: id,
      agentId: settings?.agentId,
      model: settings?.model,
      effort: settings?.effort,
      presetHasHarness: presetHasHarnessFlag(settings),
    })
    expect(body.agentId).toBe('gone')
    const spawned = await recoverDeletedAgentSpawn(async (req) => {
      if (req.agentId) throw new GatewayError(404, 'agent not found', undefined)
      return 'pty'
    }, body)
    expect(spawned.droppedAgentId).toBe(true)
    expect(DELETED_PRESET_NOTICE).toBe('Preset not found on this node; opened without it')
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
  })

  it('directoryBasename is the last path segment', () => {
    expect(directoryBasename('/home/rivet/src/rivetOS/')).toBe('rivetOS')
    expect(directoryBasename('')).toBe('')
  })

  it('shows a directory chip only for a preset that can start', () => {
    expect(defaultAgentChip({ agentId: 'gone' }, [PRESET])).toBeUndefined()
    expect(
      defaultAgentChip({ agentId: PRESET.id }, [{ ...PRESET, sourceNodeBaseUrl: '' }]),
    ).toBeUndefined()
    expect(defaultAgentChip({ agentId: PRESET.id }, [PRESET])).toEqual({
      name: 'Reviewer',
      directoryBase: 'rivetOS',
    })
  })
})

describe('resolveRosterNode', () => {
  it('matches resolveSessionNode for the hub, a listed node, and a removed node', () => {
    const hub = 'http://192.168.1.20:8787'
    const listed = 'http://192.168.1.41:8787'
    const gone = 'http://192.168.1.49:8787'
    const roster = [hub, listed]
    expect(resolveRosterNode(listed, hub, roster).node).toBe(
      resolveSessionNode({ currentBase: hub, rosterUrls: roster, binding: listed }),
    )
    expect(resolveRosterNode(gone, hub, roster)).toEqual({ node: hub, unavailable: gone })
    expect(resolveRosterNode(gone, hub, roster).node).toBe(
      resolveSessionNode({ currentBase: hub, rosterUrls: roster, binding: gone }),
    )
    expect(resolveRosterNode(hub, hub, roster)).toEqual({ node: hub, unavailable: undefined })
    expect(resolveRosterNode(undefined, hub, roster).node).toBe(hub)
  })
})

describe('canStartThread', () => {
  it('refuses until the space defaults are seeded, whatever the caller', () => {
    expect(canStartThread({ prompt: 'ship it', target: 'sp1', seedReady: false })).toBe(false)
    expect(canStartThread({ prompt: 'ship it', target: 'sp1', seedReady: true })).toBe(true)
    expect(canStartThread({ prompt: '   ', target: 'sp1', seedReady: true })).toBe(false)
    expect(canStartThread({ prompt: 'ship it', target: undefined, seedReady: true })).toBe(false)
  })
})
