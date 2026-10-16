import './test-dom.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessDescriptor, HarnessId } from '@rivetos/types'
import { urlLabel } from '../../lib/node-name.js'
import { sessionNodeFor } from '../../lib/session-node.js'
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

function editDialog(space: ReturnType<typeof useSpaces.getState>['spaces'][number]): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(
    QueryClientProvider,
    { client },
    createElement(SpaceDefaultsDialog, { space, onClose: () => undefined }),
  )
}

function submitForm(): void {
  const form = document.querySelector('form')
  if (!form) throw new Error('missing form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** Start the card and return the settings it wrote (the card has no
 *  model or effort pickers; these come from the project, else the agent). */
function startedSettings(): Record<string, unknown> | undefined {
  setField('#new-thread-prompt', 'go')
  act(() => {
    buttonNamed('Start')?.click()
  })
  return Object.values(useChatSettings.getState().byKey).at(-1) as
    Record<string, unknown> | undefined
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
  it('keeps project model and effort when the roster is already cached', () => {
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
    // No model or effort pickers on the card.
    expect(document.querySelector('[aria-label^="reasoning effort"]')).toBeNull()
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

  it('keeps project model and effort when the roster is still loading at open', () => {
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
    expect(isDisabled(buttonNamed('Start'))).toBe(true)

    roster.agents = [PRESET]
    roster.isLoading = false
    rerender(threadDialog(spaceId))
    expect(document.querySelector('[aria-label="Agent"]')?.textContent).toContain('Reviewer')
    expect(startedSettings()).toMatchObject({ model: 'm2', effort: 'high' })
  })

  it('re-applies the next project overrides when the agent id does not change', () => {
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
    rerender(threadDialog(second))
    expect(startedSettings()).toMatchObject({ model: 'm3', effort: 'low' })
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

  it("carries the project's deleted preset when the agent is left untouched", () => {
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
    expect(document.body.textContent).toContain('Plain draft')
    expect(document.body.textContent).not.toContain('missing preset was removed')
    setField('#new-thread-prompt', 'hello')
    act(() => {
      buttonNamed('Start')?.click()
    })
    const base = useConnection.getState().baseUrl
    const settings = useChatSettings.getState().byKey[`${base}::${started}`]
    // Round-2 review (gippity B1): the space's own deleted default reaches the
    // spawn recovery and DELETED_PRESET_NOTICE; only an explicit Plain draft
    // pick drops it (covered in new-thread.test.ts).
    expect(settings).toMatchObject({
      agentId: 'gone',
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })
  })

  it('copies the newly picked preset after the project seed', () => {
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
    expect(startedSettings()).toMatchObject({ agentId: OTHER.id, effort: 'low' })
  })

  it('re-applies overrides when the unlocked project selector changes and the agent does not', () => {
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
    const space = document.querySelector('[aria-label="Project"]')
    if (!space) throw new Error('missing project picker')
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
    // OTHER's den is off this roster, so it starts on the hub; effort still copies.
    expect(startedSettings()).toMatchObject({ effort: 'low' })
  })
})

describe('NewThreadDialog workspace', () => {
  function homeWith(
    defaults: Parameters<ReturnType<typeof useSpaces.getState>['setSpaceDefaults']>[1],
  ): string {
    roster.agents = [PRESET]
    roster.isLoading = false
    useConnection.getState().addNode({ name: 'den-a', baseUrl: PRESET.sourceNodeBaseUrl })
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, defaults)
    return spaceId
  }
  function workspaceText(): string {
    return document.querySelector('[data-new-session-workspace]')?.textContent ?? ''
  }

  it("shows the agent's directory and sends none when the project has no directory", () => {
    mount(threadDialog(homeWith({ agentId: PRESET.id, harnessId: 'claude-code' })))
    expect(workspaceText()).toContain(PRESET.directory)
    expect(startedSettings()?.directory).toBeUndefined()
  })

  it("starts in the project's directory over the agent's", () => {
    mount(
      threadDialog(
        homeWith({ agentId: PRESET.id, harnessId: 'claude-code', directory: '/srv/app' }),
      ),
    )
    expect(workspaceText()).toContain('/srv/app')
    expect(workspaceText()).toContain('project')
    expect(startedSettings()).toMatchObject({ agentId: PRESET.id, directory: '/srv/app' })
  })

  it('a folder picked on the card wins for this session only', () => {
    const spaceId = homeWith({
      agentId: PRESET.id,
      harnessId: 'claude-code',
      directory: '/srv/app',
    })
    mount(threadDialog(spaceId))
    const line = document.querySelector('[data-new-session-workspace]')?.querySelector('button')
    if (!line) throw new Error('missing workspace line')
    act(() => (line as HTMLElement).click())
    setField('[aria-label="Workspace folder"]', 'relative/path')
    expect(isDisabled(buttonNamed('Use'))).toBe(true)
    setField('[aria-label="Workspace folder"]', '/tmp/scratch/')
    act(() => buttonNamed('Use')?.click())
    expect(workspaceText()).toContain('/tmp/scratch')
    expect(workspaceText()).toContain('this session')
    expect(startedSettings()).toMatchObject({ directory: '/tmp/scratch' })
    // The project keeps its own directory.
    expect(useSpaces.getState().spaces.find((x) => x.id === spaceId)?.defaults?.directory).toBe(
      '/srv/app',
    )
  })
})

describe('SpaceDefaultsDialog', () => {
  const shellGlobal = globalThis as { rivetShell?: unknown }

  afterEach(() => {
    delete shellGlobal.rivetShell
  })

  function project(): NonNullable<ReturnType<typeof useSpaces.getState>['spaces'][number]> {
    const found = useSpaces.getState().spaces[0]
    if (!found) throw new Error('missing project')
    return found
  }

  /** The required bridge surface plus a folder chooser that answers `picked`. */
  function desktopShell(picked: string | undefined): ReturnType<typeof vi.fn> {
    const pickDirectory = vi.fn(async () => picked)
    const noop = async (): Promise<void> => undefined
    shellGlobal.rivetShell = {
      kind: 'electron',
      mtlsProxyPort: async () => 0,
      openExternal: noop,
      clipboardWriteText: noop,
      clipboardReadText: async () => '',
      sendNotification: noop,
      setUnread: noop,
      pickDirectory,
    }
    return pickDirectory
  }

  it('has no agent, model or effort fields', () => {
    useSpaces.getState().addSpace('Home')
    mount(editDialog(project()))
    expect(document.getElementById('space-agent')).toBeNull()
    expect(document.querySelector('[aria-label^="model:"]')).toBeNull()
    expect(document.querySelector('[aria-label="No default effort"]')).toBeNull()
    expect(document.getElementById('space-directory')).not.toBeNull()
  })

  it('saves name and directory, and drops agent, model and effort the project carried', () => {
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, {
      agentId: PRESET.id,
      harnessId: 'claude-code',
      model: 'm2',
      effort: 'high',
    })
    mount(editDialog(project()))
    setField('[aria-label="Project name"]', 'Renamed')
    setField('#space-directory', '/srv/app/')
    submitForm()
    expect(project().name).toBe('Renamed')
    const saved = project().defaults
    expect(saved?.directory).toBe('/srv/app')
    expect(saved?.agentId).toBeUndefined()
    expect(saved?.harnessId).toBeUndefined()
    expect(saved?.model).toBeUndefined()
    expect(saved?.effort).toBeUndefined()
  })

  it('will not save a relative directory', () => {
    useSpaces.getState().addSpace('Home')
    mount(editDialog(project()))
    setField('#space-directory', 'relative/path')
    expect(isDisabled(buttonNamed('Save'))).toBe(true)
    expect(document.body.textContent).toContain('Use a full path that starts with /')
  })

  it('offers Browse only inside the desktop shell', () => {
    useSpaces.getState().addSpace('Home')
    mount(editDialog(project()))
    expect(document.querySelector('[data-browse-directory]')).toBeNull()
  })

  it('fills the directory from the folder chooser, opening at the current one', async () => {
    const pickDirectory = desktopShell('/home/rivet/code/app')
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, { directory: '/home/rivet' })
    mount(editDialog(project()))
    const browse = document.querySelector('[data-browse-directory]')
    if (!browse) throw new Error('missing Browse')
    await act(async () => {
      ;(browse as HTMLButtonElement).click()
    })
    expect(pickDirectory).toHaveBeenCalledWith('/home/rivet')
    expect((document.getElementById('space-directory') as HTMLInputElement).value).toBe(
      '/home/rivet/code/app',
    )
    submitForm()
    expect(project().defaults?.directory).toBe('/home/rivet/code/app')
  })

  it('keeps the directory when the folder chooser is cancelled', async () => {
    desktopShell(undefined)
    const spaceId = useSpaces.getState().addSpace('Home')
    useSpaces.getState().setSpaceDefaults(spaceId, { directory: '/srv/app' })
    mount(editDialog(project()))
    await act(async () => {
      ;(document.querySelector('[data-browse-directory]') as HTMLButtonElement).click()
    })
    expect((document.getElementById('space-directory') as HTMLInputElement).value).toBe('/srv/app')
  })
})
