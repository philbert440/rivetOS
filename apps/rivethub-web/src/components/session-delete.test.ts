import './spaces-canvas/test-dom.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, type JSX, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayError, type RivetGateway } from '@rivetos/gateway-client'
import type { SessionTrashCandidate } from '@rivetos/types'
import type { ChatItem } from '../lib/harness-chat.js'
import { useArchived } from '../stores/archived.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { useConnection } from '../stores/connection.js'
import { useSessionNames } from '../stores/session-names.js'
import { DrawerItem } from './drawer-item.js'
import { SessionCleanupSheet } from './session-cleanup-sheet.js'
import { DeleteNotice, useSessionDelete, type DeleteTarget } from './session-delete.js'

const BASE = 'https://node.example'
const SID_A = 'claude-code:00000000-0000-4000-8000-00000000000a'
const SID_B = 'claude-code:00000000-0000-4000-8000-00000000000b'
const SID_C = 'claude-code:00000000-0000-4000-8000-00000000000c'

const gw = {
  deleteSession: vi.fn(),
  deleteSessions: vi.fn(),
  trashSessions: vi.fn(),
}

let host: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(() => {
  localStorage.clear()
  gw.deleteSession.mockReset()
  gw.deleteSessions.mockReset()
  gw.trashSessions.mockReset()
  useConnection.setState({ baseUrl: BASE, gateway: gw as unknown as RivetGateway })
  useSessionNames.setState({ byKey: {} })
  useChatSettings.setState({ byKey: {} })
  useArchived.setState({ keys: [] })
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(createElement(QueryClientProvider, { client }, node))
  })
}

/** Settle promises plus react-query's setTimeout(0) notify batching. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  ) as HTMLButtonElement | undefined
}

function click(el: Element | undefined): void {
  if (!el) throw new Error('missing element')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

/** The confirm dialog (the one asking "Delete …?"). */
function confirmDialog(): Element | undefined {
  return [...document.querySelectorAll('[role="dialog"]')].find((d) =>
    d.textContent?.includes('This can'),
  )
}

async function confirmDelete(): Promise<void> {
  const form = confirmDialog()?.querySelector('form')
  if (!form) throw new Error('no confirm dialog')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}

function row(key: string, title: string): ChatItem {
  return { key, kind: 'harness', sessionId: key as ChatItem['sessionId'], title, updatedAt: 1 }
}

/** A drawer row wired the way chat.tsx wires it, plus the notice. */
function DrawerHarness(props: { targets: DeleteTarget[]; item: ChatItem }): JSX.Element {
  const del = useSessionDelete()
  return createElement(
    'div',
    null,
    createElement(DrawerItem, {
      item: props.item,
      active: false,
      archived: false,
      onSelect: () => undefined,
      onArchive: () => undefined,
      onUnarchive: () => undefined,
      onDelete: () => void del.requestDelete(props.targets),
    }),
    createElement(DeleteNotice, { notice: del.notice, onDismiss: del.dismissNotice }),
    del.element,
  )
}

describe('single delete', () => {
  it('confirms first, says what is removed and kept, and cancel sends nothing', async () => {
    useSessionNames.getState().set(`${BASE}::${SID_A}`, 'keep me')
    mount(
      createElement(DrawerHarness, {
        item: row(SID_A, 'Fix the build'),
        targets: [{ session: SID_A, label: 'keep me' }],
      }),
    )
    click(buttonNamed('delete session…'))
    const text = confirmDialog()?.textContent ?? ''
    expect(text).toContain('Delete “keep me”?')
    expect(text).toContain('removed from memory')
    expect(text).toContain('transcript on disk is kept')

    click(buttonNamed('Cancel'))
    await flush()
    expect(confirmDialog()).toBeUndefined()
    expect(gw.deleteSession).not.toHaveBeenCalled()
    expect(useSessionNames.getState().get(`${BASE}::${SID_A}`)).toBe('keep me')
  })

  it('deletes after confirm and clears the local traces', async () => {
    gw.deleteSession.mockResolvedValue({
      ok: true,
      session: SID_A,
      conversations: 1,
      messages: 3,
      summaries: 0,
    })
    useSessionNames.getState().set(`${BASE}::${SID_A}`, 'old name')
    useChatSettings.getState().set(`${BASE}::${SID_A}`, { agent: 'claude' })
    useArchived.getState().archive(`${BASE}::${SID_A}`)
    mount(
      createElement(DrawerHarness, {
        item: row(SID_A, 'Fix the build'),
        targets: [{ session: SID_A, label: 'old name' }],
      }),
    )
    click(buttonNamed('delete session…'))
    await confirmDelete()

    expect(gw.deleteSession).toHaveBeenCalledWith(SID_A)
    expect(gw.deleteSessions).not.toHaveBeenCalled()
    expect(useSessionNames.getState().get(`${BASE}::${SID_A}`)).toBeUndefined()
    expect(useChatSettings.getState().byKey[`${BASE}::${SID_A}`]).toBeUndefined()
    expect(useArchived.getState().isArchived(`${BASE}::${SID_A}`)).toBe(false)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Deleted “old name”.')
  })

  it('a live session (409) is reported and nothing local is removed', async () => {
    gw.deleteSession.mockRejectedValue(new GatewayError(409, 'session is live', undefined))
    useSessionNames.getState().set(`${BASE}::${SID_A}`, 'running one')
    mount(
      createElement(DrawerHarness, {
        item: row(SID_A, 'Fix the build'),
        targets: [{ session: SID_A, label: 'running one' }],
      }),
    )
    click(buttonNamed('delete session…'))
    await confirmDelete()

    expect(useSessionNames.getState().get(`${BASE}::${SID_A}`)).toBe('running one')
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      '“running one” is running, so it was left alone.',
    )
  })

  it('a 404 keeps local state and says nothing was removed', async () => {
    gw.deleteSession.mockRejectedValue(new GatewayError(404, 'not found', undefined))
    useSessionNames.getState().set(`${BASE}::${SID_A}`, 'ghost')
    mount(
      createElement(DrawerHarness, {
        item: row(SID_A, 'x'),
        targets: [{ session: SID_A, label: 'ghost' }],
      }),
    )
    click(buttonNamed('delete session…'))
    await confirmDelete()
    expect(useSessionNames.getState().get(`${BASE}::${SID_A}`)).toBe('ghost')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('nothing was removed')
  })
})

describe('multi-select delete', () => {
  it('select mode turns rows into checkboxes and hides the row actions', () => {
    const onToggle = vi.fn()
    const onSelect = vi.fn()
    mount(
      createElement(
        'div',
        null,
        createElement(DrawerItem, {
          item: row(SID_A, 'A'),
          active: false,
          archived: false,
          onSelect,
          onArchive: () => undefined,
          onUnarchive: () => undefined,
          onDelete: () => undefined,
          select: { checked: false, onToggle },
        }),
        createElement(DrawerItem, {
          item: { key: 'draft-1', kind: 'draft', title: 'new session', updatedAt: 0 },
          active: false,
          archived: false,
          onSelect,
          onArchive: () => undefined,
          onUnarchive: () => undefined,
          select: { checked: false, disabled: true, onToggle },
        }),
      ),
    )
    expect(buttonNamed('delete session…')).toBeUndefined()
    expect(buttonNamed('rename session')).toBeUndefined()
    click(buttonNamed('select A'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    // Clicking the row body toggles too, and never opens the session.
    click(buttonNamed('A'))
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(onSelect).not.toHaveBeenCalled()
    // The draft's checkbox is disabled.
    click(buttonNamed('select new session'))
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('one confirm deletes N through the bulk endpoint and keeps per-item failures', async () => {
    gw.deleteSessions.mockResolvedValue({
      results: [
        { session: SID_A, ok: true, conversations: 1, messages: 2, summaries: 0 },
        { session: SID_B, ok: false, error: 'session is live' },
        { session: SID_C, ok: false, error: 'not found' },
      ],
    })
    for (const [sid, name] of [
      [SID_A, 'alpha'],
      [SID_B, 'beta'],
      [SID_C, 'gamma'],
    ] as const) {
      useSessionNames.getState().set(`${BASE}::${sid}`, name)
    }
    mount(
      createElement(DrawerHarness, {
        item: row(SID_A, 'A'),
        targets: [
          { session: SID_A, label: 'alpha' },
          { session: SID_B, label: 'beta' },
          { session: SID_C, label: 'gamma' },
        ],
      }),
    )
    click(buttonNamed('delete session…'))
    const text = confirmDialog()?.textContent ?? ''
    expect(text).toContain('Delete 3 sessions (“alpha”, “beta”, “gamma”)?')
    expect(buttonNamed('Delete 3')).toBeDefined()
    await confirmDelete()

    expect(gw.deleteSessions).toHaveBeenCalledTimes(1)
    expect(gw.deleteSessions).toHaveBeenCalledWith([SID_A, SID_B, SID_C])
    expect(useSessionNames.getState().get(`${BASE}::${SID_A}`)).toBeUndefined()
    expect(useSessionNames.getState().get(`${BASE}::${SID_B}`)).toBe('beta')
    expect(useSessionNames.getState().get(`${BASE}::${SID_C}`)).toBe('gamma')
    const notice = document.querySelector('[role="status"]')?.textContent ?? ''
    expect(notice).toContain('Deleted 1 session.')
    expect(notice).toContain('“beta” is running')
    expect(notice).toContain('“gamma” was not found')
  })
})

function candidate(
  session: string,
  over: Partial<SessionTrashCandidate> = {},
): SessionTrashCandidate {
  return {
    session,
    harness: 'claude-code',
    title: null,
    updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    reason: 'empty',
    userTurns: 0,
    reply: null,
    ...over,
  }
}

function candidateBox(session: string): Element | undefined {
  return [...document.querySelectorAll('[role="checkbox"]')].find(
    (el) => el.getAttribute('data-session') === session,
  )
}

describe('clean-up review', () => {
  it('drops renamed rows, preselects nothing, and deletes only the picked ones', async () => {
    gw.trashSessions.mockResolvedValue({
      candidates: [
        candidate(SID_A, { title: 'hi', reason: 'one-word-reply', userTurns: 1, reply: 'Hello!' }),
        candidate(SID_B),
        candidate(SID_C),
      ],
    })
    useSessionNames.getState().set(`${BASE}::${SID_C}`, 'my keeper')
    gw.deleteSessions.mockResolvedValue({
      results: [{ session: SID_A, ok: false, error: 'session is live' }],
    })
    mount(createElement(SessionCleanupSheet, { open: true, onClose: () => undefined }))
    await flush()

    expect(candidateBox(SID_A)).toBeDefined()
    expect(candidateBox(SID_B)).toBeDefined()
    expect(candidateBox(SID_C)).toBeUndefined() // renamed locally → never offered
    expect(document.body.textContent).toContain('one-word reply')
    expect(document.body.textContent).toContain('reply: “Hello!”')
    expect(candidateBox(SID_A)?.getAttribute('aria-checked')).toBe('false')
    const deleteBtn = buttonNamed('Delete selected')
    expect(deleteBtn?.hasAttribute('disabled') || deleteBtn?.disabled).toBe(true)

    click(candidateBox(SID_A))
    click(buttonNamed('Delete selected (1)'))
    await flush()
    expect(confirmDialog()?.textContent).toContain('Delete “hi”?')
    // Single pick still goes through one confirm, then the single endpoint.
    gw.deleteSession.mockRejectedValue(new GatewayError(409, 'session is live', undefined))
    await confirmDelete()

    expect(gw.deleteSession).toHaveBeenCalledWith(SID_A)
    expect(gw.deleteSessions).not.toHaveBeenCalled()
    // The live one stays listed with its reason.
    expect(candidateBox(SID_A)?.textContent).toContain('running — left alone')
  })

  it('bulk-deletes several picks and hides the deleted rows', async () => {
    gw.trashSessions.mockResolvedValue({ candidates: [candidate(SID_A), candidate(SID_B)] })
    gw.deleteSessions.mockResolvedValue({
      results: [
        { session: SID_A, ok: true, conversations: 0, messages: 0, summaries: 0 },
        { session: SID_B, ok: true, conversations: 1, messages: 1, summaries: 0 },
      ],
    })
    mount(createElement(SessionCleanupSheet, { open: true, onClose: () => undefined }))
    await flush()
    click(buttonNamed('Select all'))
    click(buttonNamed('Delete selected (2)'))
    await flush()
    await confirmDelete()
    expect(gw.deleteSessions).toHaveBeenCalledWith([SID_A, SID_B])
    expect(candidateBox(SID_A)).toBeUndefined()
    expect(candidateBox(SID_B)).toBeUndefined()
  })

  it('shows the empty state', async () => {
    gw.trashSessions.mockResolvedValue({ candidates: [] })
    mount(createElement(SessionCleanupSheet, { open: true, onClose: () => undefined }))
    await flush()
    expect(document.body.textContent).toContain('Nothing to clean up.')
  })

  it('says "not supported" on an older gateway instead of erroring', async () => {
    gw.trashSessions.mockRejectedValue(new GatewayError(404, 'gateway 404', undefined))
    const onUnsupported = vi.fn()
    mount(
      createElement(SessionCleanupSheet, { open: true, onClose: () => undefined, onUnsupported }),
    )
    await flush()
    expect(document.body.textContent).toContain('Clean up is not supported by this gateway.')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(onUnsupported).toHaveBeenCalled()
  })
})
