import './test-dom.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import type { HarnessDescriptor, HarnessId } from '@rivetos/types'
import { urlLabel } from '../../lib/node-name.js'
import { sessionNodeFor } from '../../lib/session-node.js'
import {
  DELETED_PRESET_NOTICE,
  presetHasHarnessFlag,
  recoverDeletedAgentSpawn,
  termSpawnBody,
} from '../../lib/term-spawn.js'
import { useChat } from '../../stores/chat.js'
import { useChatSettings } from '../../stores/chat-settings.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { NewThreadDialog } from './NewThreadDialog.js'
import { SpaceDefaultsDialog } from './SpaceDefaultsDialog.js'
import { offRosterStartNotice } from './new-thread.js'

const roster = vi.hoisted(() => ({
  agents: [] as Array<{
    id: string
    name: string
    harnessId: HarnessId
    model: string
    effort: string
    systemPrompt: string
    sourceNodeBaseUrl: string
    listedBaseUrl: string
    node?: string
    directory?: string
  }>,
  isLoading: false,
}))

vi.mock('../../lib/use-agent-roster.js', () => ({
  useRosterAgents: () => ({ agents: roster.agents, isLoading: roster.isLoading }),
}))

const PRESET = {
  id: 'preset-1',
  name: 'Reviewer',
  harnessId: 'claude-code' as const,
  model: 'm1',
  effort: 'off',
  systemPrompt: 'be brief',
  sourceNodeBaseUrl: 'http://192.168.1.30:8787',
  listedBaseUrl: 'http://192.168.1.30:8787',
  node: 'den-a',
  directory: '/home/rivet/src/rivetOS',
}

const OTHER = {
  ...PRESET,
  id: 'preset-2',
  name: 'Other',
  model: 'm-other',
  effort: 'low',
  sourceNodeBaseUrl: 'http://192.168.1.31:8787',
  listedBaseUrl: 'http://192.168.1.31:8787',
}

let host: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(() => {
  localStorage.removeItem('rivethub.spaces')
  localStorage.removeItem('rivethub.sessionNodes')
  localStorage.removeItem('rivethub.agent.lastSession')
  localStorage.removeItem('rivethub.roster')
  useConnection.setState({ roster: [] })
  useSpaces.setState({ spaces: [], membership: {} })
  useChat.setState({ drafts: [], active: undefined, outbound: {}, opened: [] })
  useChatSettings.setState({ byKey: {} })
  roster.agents = []
  roster.isLoading = false
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  host = undefined
  root = undefined
})

function mount(node: ReactNode): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(node)
  })
}

function rerender(node: ReactNode): void {
  act(() => {
    root?.render(node)
  })
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined
}

function isDisabled(button: Element | undefined): boolean {
  if (!button) return false
  if ((button as { disabled?: boolean }).disabled === true) return true
  return button.hasAttribute('disabled')
}

function setField(selector: string, value: string): void {
  const input = selector.startsWith('#')
    ? document.getElementById(selector.slice(1))
    : document.querySelector(selector)
  if (!input) throw new Error(`missing ${selector}`)
  const field = input as { value: string; _valueTracker?: { setValue: (next: string) => void } }
  field._valueTracker?.setValue('')
  field.value = value
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function editDialog(
  space: ReturnType<typeof useSpaces.getState>['spaces'][number],
  descriptors?: HarnessDescriptor[],
): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(
    QueryClientProvider,
    { client },
    createElement(SpaceDefaultsDialog, { space, descriptors, onClose: () => undefined }),
  )
}

function submitForm(): void {
  const form = document.querySelector('form')
  if (!form) throw new Error('missing form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function threadDialog(
  spaceId: string | undefined,
  onStarted: (id: string) => void = () => undefined,
): ReactNode {
  const spaces = useSpaces.getState().spaces.map((space) => ({
    id: space.id,
    name: space.name,
    defaults: space.defaults,
  }))
  return createElement(NewThreadDialog, {
    spaceId,
    spaces,
    onClose: () => undefined,
    onStarted,
    onPickHistory: () => undefined,
  })
}

describe('NewThreadDialog seeding', () => {
  it('keeps space model and effort when the roster is already cached', () => {
    roster.agents = [PRESET]
    roster.isLoading = false
    useConnection.getState().addNode({ name: 'den-a', baseUrl: PRESET.sourceNodeBaseUrl })
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      model: 'm2',
      effort: 'high',
      harnessId: 'claude-code',
    })
    let started = ''
    mount(
      threadDialog(spaceId, (id) => {
        started = id
      }),
    )
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: Off"]')).toBeNull()
    expect(document.querySelector('[aria-label="Agent"]')?.textContent).toContain('Reviewer')
    setField('#new-thread-prompt', 'ship it')
    const start = buttonNamed('Start')
    expect(isDisabled(start)).toBe(false)
    act(() => {
      start?.click()
    })
    expect(started).toBeTruthy()
    const key = `${PRESET.sourceNodeBaseUrl}::${started}`
    expect(useChatSettings.getState().byKey[key]).toMatchObject({
      agentId: PRESET.id,
      model: 'm2',
      effort: 'high',
      harnessEffort: 'high',
    })
  })

  it('keeps space model and effort when the roster is still loading at open', () => {
    roster.agents = []
    roster.isLoading = true
    useConnection.getState().addNode({ name: 'den-a', baseUrl: PRESET.sourceNodeBaseUrl })
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      model: 'm2',
      effort: 'high',
      harnessId: 'claude-code',
    })
    mount(threadDialog(spaceId))
    expect(document.querySelector('[aria-label="reasoning effort: Off"]')).toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).toBeNull()
    expect(isDisabled(buttonNamed('Start'))).toBe(true)

    roster.agents = [PRESET]
    roster.isLoading = false
    rerender(threadDialog(spaceId))
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: Off"]')).toBeNull()
    expect(document.querySelector('[aria-label="Agent"]')?.textContent).toContain('Reviewer')
    setField('#new-thread-prompt', 'ship it')
    expect(isDisabled(buttonNamed('Start'))).toBe(false)
  })

  it('re-applies the next space overrides when the agent id does not change', () => {
    roster.agents = [PRESET]
    roster.isLoading = false
    const first = useSpaces.getState().addSpace('Alpha')
    const second = useSpaces.getState().addSpace('Beta')
    useSpaces.getState().setSpaceDefaults(first, {
      agentId: PRESET.id,
      model: 'm2',
      effort: 'high',
      harnessId: 'claude-code',
    })
    useSpaces.getState().setSpaceDefaults(second, {
      agentId: PRESET.id,
      model: 'm3',
      effort: 'low',
      harnessId: 'claude-code',
    })
    mount(threadDialog(first))
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).not.toBeNull()
    rerender(threadDialog(second))
    expect(document.querySelector('[aria-label="reasoning effort: Low"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: Off"]')).toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).toBeNull()
  })

  it('says when the saved node is off the roster and starts on the hub', () => {
    roster.agents = []
    roster.isLoading = false
    const base = useConnection.getState().baseUrl
    const gone = 'http://192.168.1.99:8787'
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      model: 'm2',
      effort: 'high',
      node: gone,
    })
    let started = ''
    mount(
      threadDialog(spaceId, (id) => {
        started = id
      }),
    )
    const notice = offRosterStartNotice(gone, base)
    expect(notice).toBe(`${urlLabel(gone)} is not in your roster — starting on ${urlLabel(base)}`)
    expect(document.body.textContent).toContain(notice)
    setField('#new-thread-prompt', 'hello')
    act(() => {
      buttonNamed('Start')?.click()
    })
    expect(started).toBeTruthy()
    expect(useChatSettings.getState().byKey[`${gone}::${started}`]).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${base}::${started}`]).toMatchObject({
      model: 'm2',
      effort: 'high',
    })
    expect(useSpaces.getState().spaceOf(`${base}::${started}`)).toBe(spaceId)
    expect(
      sessionNodeFor(
        started,
        base,
        useConnection.getState().roster.map((node) => node.baseUrl),
      ),
    ).toBe(base)
  })

  it('carries a deleted preset id so spawn recovery raises the existing notice', async () => {
    roster.agents = [PRESET]
    roster.isLoading = false
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: 'gone',
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })
    let started = ''
    mount(
      threadDialog(spaceId, (id) => {
        started = id
      }),
    )
    expect(document.body.textContent).not.toContain('missing preset was removed')
    setField('#new-thread-prompt', 'hello')
    act(() => {
      buttonNamed('Start')?.click()
    })
    const base = useConnection.getState().baseUrl
    const settings = useChatSettings.getState().byKey[`${base}::${started}`]
    expect(settings?.agentId).toBe('gone')
    expect(settings?.harnessId).toBe('claude-code')
    const body = termSpawnBody({
      sessionId: started,
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

  it('copies the newly picked preset after the space seed', () => {
    roster.agents = [PRESET, OTHER]
    roster.isLoading = false
    useConnection.getState().addNode({ name: 'den-a', baseUrl: PRESET.sourceNodeBaseUrl })
    useConnection.getState().addNode({ name: 'den-b', baseUrl: OTHER.sourceNodeBaseUrl })
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      model: 'm2',
      effort: 'high',
      harnessId: 'claude-code',
    })
    mount(threadDialog(spaceId))
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).not.toBeNull()
    const agent = document.querySelector('[aria-label="Agent"]')
    if (!agent) throw new Error('missing agent picker')
    act(() => {
      agent.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const other = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Other',
    )
    expect(other).toBeTruthy()
    act(() => {
      other?.click()
    })
    expect(document.querySelector('[aria-label="reasoning effort: Low"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).toBeNull()
  })

  it('re-applies overrides when the unlocked space selector changes and the agent does not', () => {
    roster.agents = [PRESET, OTHER]
    roster.isLoading = false
    const first = useSpaces.getState().addSpace('Alpha')
    const second = useSpaces.getState().addSpace('Beta')
    useSpaces.getState().setSpaceDefaults(first, {
      agentId: PRESET.id,
      model: 'm2',
      effort: 'high',
      harnessId: 'claude-code',
    })
    useSpaces.getState().setSpaceDefaults(second, {
      agentId: PRESET.id,
      model: 'm3',
      effort: 'medium',
      harnessId: 'claude-code',
    })
    mount(threadDialog(undefined))
    expect(document.querySelector('[aria-label="reasoning effort: High"]')).not.toBeNull()
    const space = document.querySelector('[aria-label="Space"]')
    if (!space) throw new Error('missing space picker')
    act(() => {
      space.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const beta = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Beta',
    )
    expect(beta).toBeTruthy()
    act(() => {
      beta?.click()
    })
    expect(document.querySelector('[aria-label="reasoning effort: Medium"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: Off"]')).toBeNull()
    const agent = document.querySelector('[aria-label="Agent"]')
    if (!agent) throw new Error('missing agent picker')
    act(() => {
      agent.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const other = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Other',
    )
    expect(other).toBeTruthy()
    act(() => {
      other?.click()
    })
    expect(document.querySelector('[aria-label="reasoning effort: Low"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="reasoning effort: Medium"]')).toBeNull()
  })
})

describe('SpaceDefaultsDialog save while the roster loads', () => {
  it('does not clear a stored preset on Save or Enter before the roster resolves', () => {
    roster.agents = []
    roster.isLoading = true
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })
    const space = (): NonNullable<ReturnType<typeof useSpaces.getState>['spaces'][number]> => {
      const found = useSpaces.getState().spaces.find((row) => row.id === spaceId)
      if (!found) throw new Error('missing space')
      return found
    }
    mount(
      createElement(SpaceDefaultsDialog, {
        space: space(),
        onClose: () => undefined,
      }),
    )
    expect(isDisabled(buttonNamed('Save'))).toBe(true)
    setField('[aria-label="Space name"]', 'Renamed')
    act(() => {
      buttonNamed('Save')?.click()
    })
    submitForm()
    expect(space().name).toBe('Home')
    expect(space().defaults).toMatchObject({
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })

    roster.agents = [PRESET]
    roster.isLoading = false
    rerender(
      createElement(SpaceDefaultsDialog, {
        space: space(),
        onClose: () => undefined,
      }),
    )
    expect(isDisabled(buttonNamed('Save'))).toBe(false)
    submitForm()
    expect(space().name).toBe('Renamed')
    expect(space().defaults).toMatchObject({
      agentId: PRESET.id,
      harnessId: 'claude-code',
    })
  })

  it('clears a stored model the newly chosen harness does not offer', () => {
    const codex = {
      ...OTHER,
      id: 'preset-codex',
      name: 'Codex',
      harnessId: 'codex' as const,
      model: 'a',
    }
    roster.agents = [PRESET, codex]
    roster.isLoading = false
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })
    const descriptors: HarnessDescriptor[] = [
      {
        harnessId: 'claude-code',
        capabilities: {
          interrupt: true,
          resume: true,
          approvals: false,
          liveStream: true,
          listSessions: true,
          launchModel: true,
          models: [
            { id: 'm1', label: 'M1' },
            { id: 'm2', label: 'M2' },
          ],
        },
      },
      {
        harnessId: 'codex',
        capabilities: {
          interrupt: true,
          resume: true,
          approvals: false,
          liveStream: true,
          listSessions: true,
          launchModel: true,
          models: [{ id: 'a', label: 'Model A' }],
        },
      },
    ]
    const space = useSpaces.getState().spaces[0]
    if (!space) throw new Error('missing space')
    mount(createElement(SpaceDefaultsDialog, { space, descriptors, onClose: () => undefined }))
    expect(document.querySelector('[aria-label="model: M2"]')).not.toBeNull()
    const agent = document.querySelector('[aria-label="Agent"]')
    if (!agent) throw new Error('missing agent picker')
    act(() => {
      agent.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const picked = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Codex',
    )
    expect(picked).toBeTruthy()
    act(() => {
      picked?.click()
    })
    expect(document.querySelector('[aria-label="model: None"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="model: M2"]')).toBeNull()
    submitForm()
    expect(useSpaces.getState().spaces[0]?.defaults).toMatchObject({
      agentId: codex.id,
      harnessId: 'codex',
    })
    expect(useSpaces.getState().spaces[0]?.defaults?.model).toBeUndefined()
  })

  it('keeps the stored preset when the roster is already cached', () => {
    roster.agents = [PRESET]
    roster.isLoading = false
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'm2',
    })
    const space = useSpaces.getState().spaces[0]
    if (!space) throw new Error('missing space')
    mount(createElement(SpaceDefaultsDialog, { space, onClose: () => undefined }))
    expect(isDisabled(buttonNamed('Save'))).toBe(false)
    submitForm()
    expect(useSpaces.getState().spaces[0]?.defaults?.agentId).toBe(PRESET.id)
    expect(useSpaces.getState().spaces[0]?.defaults?.harnessId).toBe('claude-code')
  })

  it('shows a missing preset and Clear drops it', () => {
    roster.agents = [PRESET]
    roster.isLoading = false
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: 'gone',
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })
    const space = useSpaces.getState().spaces[0]
    if (!space) throw new Error('missing space')
    mount(editDialog(space))
    expect(document.body.textContent).toContain('(missing preset)')
    const clear = document.querySelector('[aria-label="Clear missing preset"]')
    if (!clear) throw new Error('missing clear')
    act(() => {
      ;(clear as HTMLButtonElement).click()
    })
    expect(document.body.textContent).not.toContain('(missing preset)')
    submitForm()
    expect(useSpaces.getState().spaces[0]?.defaults?.agentId).toBeUndefined()
    expect(useSpaces.getState().spaces[0]?.defaults?.harnessId).toBeUndefined()
    expect(useSpaces.getState().spaces[0]?.defaults?.model).toBe('m2')
  })

  it('clears agent, model, and effort when each field is set to none', () => {
    roster.agents = [PRESET]
    roster.isLoading = false
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })
    const descriptors: HarnessDescriptor[] = [
      {
        harnessId: 'claude-code',
        capabilities: {
          interrupt: true,
          resume: true,
          approvals: false,
          liveStream: true,
          listSessions: true,
          launchModel: true,
          models: [{ id: 'm2', label: 'M2' }],
        },
      },
    ]
    const space = useSpaces.getState().spaces[0]
    if (!space) throw new Error('missing space')
    mount(editDialog(space, descriptors))
    const model = document.querySelector('[aria-label="model: M2"]')
    if (!model) throw new Error('missing model picker')
    act(() => {
      model.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const noneModel = [...document.querySelectorAll('button')].find(
      (button) =>
        button.textContent?.trim() === 'None' &&
        button.getAttribute('aria-label') !== 'No default effort',
    )
    expect(noneModel).toBeTruthy()
    act(() => {
      noneModel?.click()
    })
    expect(document.querySelector('[aria-label="model: None"]')).not.toBeNull()
    const effortNone = document.querySelector('[aria-label="No default effort"]')
    if (!effortNone) throw new Error('missing effort none')
    act(() => {
      ;(effortNone as HTMLButtonElement).click()
    })
    const agent = document.querySelector('[aria-label="Agent"]')
    if (!agent) throw new Error('missing agent picker')
    act(() => {
      agent.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const agentHeader = [...document.querySelectorAll('div')].find(
      (el) => el.children.length === 0 && el.textContent === 'Agent',
    )
    const agentMenu = agentHeader?.parentElement?.parentElement
    const noneAgent = agentMenu
      ? [...agentMenu.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'None',
        )
      : undefined
    expect(noneAgent).toBeTruthy()
    act(() => {
      noneAgent?.click()
    })
    submitForm()
    const saved = useSpaces.getState().spaces[0]?.defaults
    expect(saved?.agentId).toBeUndefined()
    expect(saved?.harnessId).toBeUndefined()
    expect(saved?.model).toBeUndefined()
    expect(saved?.effort).toBeUndefined()
  })
})
