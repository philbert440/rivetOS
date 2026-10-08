import './test-dom.js'
import { createElement, StrictMode, useEffect, useRef, type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { HarnessDescriptor, SessionId } from '@rivetos/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gatewayFor } = vi.hoisted(() => ({
  gatewayFor: vi.fn(),
}))

vi.mock('../../lib/agent-gateway.js', () => ({
  gatewayFor: (base: string) => gatewayFor(base),
}))

vi.mock('../../lib/harness-attach.js', () => ({
  attachHarnessSession: vi.fn(() => ({ close: vi.fn(), resync: vi.fn(), sync: vi.fn() })),
}))

vi.mock('../transcript.js', () => ({
  Transcript: () => null,
}))

import type { ChatItem } from '../../lib/harness-chat.js'
import { attachHarnessSession } from '../../lib/harness-attach.js'
import { clearSessionNodeBinding, setSessionNodeBinding } from '../../lib/session-node.js'
import { storageKey } from '../../lib/session-rekey.js'
import { MINI_BACKFILL_DEBOUNCE_MS, MINI_BACKFILL_MAX_WAIT_MS } from './ThreadMini.js'
import { resetSessionStreams } from '../../lib/use-session-stream.js'
import { useAgentFilter } from '../../stores/agent-filter.js'
import { useArchived } from '../../stores/archived.js'
import { useChat } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { canvasKeyClaims, performCanvasEffect, reduceCanvasCommand } from './canvas-input.js'
import { SpacesCanvas } from './SpacesCanvas.js'
import { ThreadMini } from './ThreadMini.js'
import { useCamera } from './use-camera.js'

const CLAUDE: HarnessDescriptor = {
  harnessId: 'claude-code',
  capabilities: {
    interrupt: true,
    resume: true,
    approvals: false,
    liveStream: true,
    listSessions: true,
  },
}

function idleGateway(tag: string) {
  return {
    tag,
    getHarnessSession: () => Promise.reject(new Error('unused')),
    harnesses: () => Promise.resolve({ harnesses: [] as HarnessDescriptor[] }),
    sessionMessages: () => Promise.resolve({ messages: [] }),
    harnessSessions: () => Promise.resolve({ sessions: [] }),
    watchHarnessSession: () => ({ close: () => undefined }),
  }
}

gatewayFor.mockImplementation((base: string) => Promise.resolve(idleGateway(base)))

function harnessRow(native: string): ChatItem {
  const key = `claude-code:${native}` as SessionId
  return {
    key,
    kind: 'harness',
    title: native,
    sessionId: key,
    harnessId: 'claude-code',
    updatedAt: 1,
    status: 'idle',
  }
}

beforeEach(() => {
  localStorage.removeItem('rivethub.spaces')
  useSpaces.setState({ spaces: [], membership: {} })
  useArchived.setState({ keys: [] })
  useAgentFilter.getState().clear()
})

function placeOnHome(keys: readonly string[]): string {
  const id = useSpaces.getState().addSpace('Home')
  const base = useConnection.getState().baseUrl
  for (const key of keys) useSpaces.getState().place(storageKey(base, key), id)
  return id
}

function row(key: string, title: string, status?: ChatItem['status']): ChatItem {
  return { key, kind: 'legacy', title, updatedAt: 1, status }
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
}

function markup(node: ReactNode): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: client() }, node))
}

function pointerClick(el: Element): void {
  const init = { bubbles: true, cancelable: true, clientX: 8, clientY: 8, pointerId: 1 }
  el.dispatchEvent(new PointerEvent('pointerdown', init))
  el.dispatchEvent(new PointerEvent('pointerup', init))
}

const FLY_CLOCK = {
  toFake: [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'Date',
    'performance',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ],
} as const

describe('SpacesCanvas', () => {
  it('renders no tiles when no space exists yet', () => {
    const html = markup(
      createElement(SpacesCanvas, {
        rows: [row('a', 'Alpha', 'idle'), row('b', 'Beta', 'active')],
        onOpen: () => undefined,
        renderThread: () => null,
      }),
    )
    expect(html).not.toContain('data-tile=')
    expect(html).not.toContain('Unplaced')
    expect(html).toContain('No spaces yet. Threads live in History.')
    expect(html).toContain('+ New space')
    expect(html).toContain('data-altitude="everything"')
    expect(html).not.toContain('data-face="mini"')
    expect(html).not.toContain('id="conversations-pane"')
  })

  it('selecting and Enter calls onOpen', () => {
    const onOpen = vi.fn()
    const tiles = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 990, y: 0 },
    ]
    const selected = reduceCanvasCommand(
      { altitude: 'everything', selectedId: 'a' },
      { nav: 'right' },
      tiles,
    )
    expect(selected).toEqual({ type: 'select', id: 'b' })
    const opened = reduceCanvasCommand(
      { altitude: 'everything', selectedId: 'b' },
      { nav: 'open' },
      tiles,
    )
    performCanvasEffect(opened, {
      open: onOpen,
      select: () => undefined,
      go: () => undefined,
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('b')
    expect(canvasKeyClaims('thread', null, 'open')).toBe(false)
    expect(canvasKeyClaims('space', null, 'open')).toBe(true)
    expect(canvasKeyClaims('thread', null, null, 'next-waiting')).toBe(false)
    expect(canvasKeyClaims('space', null, null, 'next-waiting')).toBe(true)
    expect(canvasKeyClaims('everything', null, null, 'next-waiting')).toBe(true)
    expect(canvasKeyClaims('thread', null, null, 'mru')).toBe(true)
  })
})

describe('SpacesCanvas mount', () => {
  let root: Root | undefined
  let host: HTMLElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
    resetSessionStreams()
    useChat.setState({
      sessionAliases: {},
      opened: [],
      drafts: [],
      messages: {},
      transcripts: {},
      harnessBound: {},
      live: {},
      outbound: {},
      active: undefined,
      sessionsDirty: 0,
    })
    gatewayFor.mockReset()
    gatewayFor.mockImplementation((base: string) => Promise.resolve(idleGateway(base)))
    vi.mocked(attachHarnessSession).mockReset()
    vi.mocked(attachHarnessSession).mockImplementation(() => ({
      close: vi.fn(),
      resync: vi.fn(),
      sync: vi.fn(),
    }))
    vi.useRealTimers()
  })

  function mount(
    rows: ChatItem[],
    onOpen: (id: string) => void,
    initial?: {
      activeId?: string
      blockedIds?: ReadonlySet<string>
      blockedReady?: boolean
      strict?: boolean
      descriptors?: HarnessDescriptor[]
      renderThread?: (id: string) => ReactNode
    },
  ) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const query = client()
    let opts = initial ?? {}
    const render = (
      next: ChatItem[],
      patch?:
        | string
        | {
            activeId?: string
            blockedIds?: ReadonlySet<string>
            blockedReady?: boolean
          },
    ): void => {
      if (typeof patch === 'string') opts = { ...opts, activeId: patch }
      else if (patch) opts = { ...opts, ...patch }
      const canvas = createElement(
        QueryClientProvider,
        { client: query },
        createElement(SpacesCanvas, {
          rows: next,
          activeId: opts.activeId,
          blockedIds: opts.blockedIds,
          blockedReady: opts.blockedReady,
          descriptors: opts.descriptors,
          onOpen,
          renderThread:
            opts.renderThread ??
            ((id: string) => createElement('div', { 'data-active-session': id }, id)),
        }),
      )
      root?.render(opts.strict ? createElement(StrictMode, null, canvas) : canvas)
    }
    act(() => {
      render(rows)
    })
    return { render }
  }

  function press(init: KeyboardEventInit): KeyboardEvent {
    document.body.focus()
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    act(() => {
      window.dispatchEvent(event)
    })
    return event
  }

  function cancelDialog(): void {
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel',
    )
    if (!cancel) throw new Error('missing cancel')
    act(() => {
      cancel.click()
    })
  }

  it('click selects a card and the next click opens it', () => {
    const onOpen = vi.fn()
    placeOnHome(['a', 'b'])
    mount([row('a', 'Alpha', 'idle'), row('b', 'Beta', 'active')], onOpen)
    expect(host?.querySelector('[data-tile="a"]')?.className).toContain('st-idle')
    expect(host?.querySelector('[data-tile="b"]')?.className).toContain('st-working')
    expect(host?.querySelector('[data-face="card"]')).not.toBeNull()
    expect(host?.querySelector('[data-face="mini"]')).toBeNull()
    expect(host?.querySelector('#conversations-pane')).toBeNull()
    expect(host?.textContent).toContain('Home')
    expect(host?.textContent).not.toContain('Unplaced')
    expect(host?.textContent).toContain('1 active · 0 waiting on you')
    expect(host?.textContent).toContain('idle')
    expect(host?.textContent).toContain('working')
    const face = host?.querySelector('[data-face="card"]')
    expect(face?.style.getPropertyValue('--cs')).toContain('var(--inv')
    const hit = host?.querySelector('[data-tile-hit="b"]')
    if (!hit) throw new Error('missing tile')
    act(() => {
      pointerClick(hit)
    })
    expect(host?.querySelector('[data-tile="b"]')?.getAttribute('data-selected')).toBe('true')
    expect(onOpen).not.toHaveBeenCalled()
    act(() => {
      pointerClick(hit)
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('b')
  })

  it('Enter on body opens and Enter on a dock button does not', () => {
    const onOpen = vi.fn()
    placeOnHome(['a', 'b'])
    mount([row('a', 'Alpha'), row('b', 'Beta')], onOpen)
    document.body.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('a')
    onOpen.mockClear()
    const button = host?.querySelector('[data-hud]')?.querySelector('button')
    if (!button) throw new Error('missing dock button')
    if (button instanceof HTMLElement) button.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('lands one thread after rows reorder mid-fly, and Ctrl+Space leaves it', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onOpen = vi.fn()
    placeOnHome(['a', 'b'])
    const { render } = mount([row('a', 'Alpha'), row('b', 'Beta')], onOpen)
    const hit = host?.querySelector('[data-tile-hit="a"]')
    if (!hit) throw new Error('missing tile')
    act(() => {
      pointerClick(hit)
    })
    act(() => {
      render([row('b', 'Beta'), row('a', 'Alpha')])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    const sessions = host?.querySelectorAll('[data-active-session]') ?? []
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.getAttribute('data-active-session')).toBe('a')
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true }),
      )
    })
    expect(host?.querySelector('[data-active-session]')).toBeNull()
  })

  it('keeps keyboard nav after a pointer selects a tile', () => {
    const onOpen = vi.fn()
    placeOnHome(['a', 'b', 'c', 'd'])
    mount([row('a', 'Alpha'), row('b', 'Beta'), row('c', 'Gamma'), row('d', 'Delta')], onOpen)
    const hit = host?.querySelector('[data-tile-hit="c"]')
    if (!(hit instanceof HTMLElement)) throw new Error('missing tile')
    act(() => {
      pointerClick(hit)
    })
    expect(host?.querySelector('[data-tile="c"]')?.getAttribute('data-selected')).toBe('true')
    expect(document.activeElement).toBe(hit)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onOpen).not.toHaveBeenCalled()
    expect(host?.querySelector('[data-tile="d"]')?.getAttribute('data-selected')).toBe('true')
  })

  it('Enter on a focused location button activates it and the canvas does not claim it', () => {
    const onOpen = vi.fn()
    placeOnHome(['a', 'b'])
    mount([row('a', 'Alpha'), row('b', 'Beta')], onOpen)
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('everything')
    const crumb = host?.querySelector('[aria-label="Location"]')?.querySelectorAll('button')[1]
    if (!(crumb instanceof HTMLElement)) throw new Error('missing space crumb')
    expect(crumb.textContent).toBe('Home')
    crumb.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpen).not.toHaveBeenCalled()
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('space')
  })

  it('keeps the open thread mounted across a draft rekey and admits a new row', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onOpen = vi.fn()
    const home = placeOnHome(['draft-1'])
    const base = useConnection.getState().baseUrl
    const { render } = mount([row('draft-1', 'Draft')], onOpen)
    const hit = host?.querySelector('[data-tile-hit="draft-1"]')
    if (!hit) throw new Error('missing tile')
    act(() => {
      pointerClick(hit)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(host?.querySelector('[data-active-session]')?.getAttribute('data-active-session')).toBe(
      'draft-1',
    )
    act(() => {
      // migrateSessionKey moves membership alongside the chat rekey.
      useSpaces.getState().rekey(storageKey(base, 'draft-1'), storageKey(base, 'canon-1'))
      useChat.getState().rekey('draft-1', 'canon-1')
      render([row('canon-1', 'Canon')], 'canon-1')
    })
    expect(host?.querySelector('[data-tile="canon-1"]')).not.toBeNull()
    expect(host?.querySelector('[data-active-session]')?.getAttribute('data-active-session')).toBe(
      'canon-1',
    )
    act(() => {
      useSpaces.getState().place(storageKey(base, 'new-1'), home)
      render([row('canon-1', 'Canon'), row('new-1', 'Newcomer')], 'canon-1')
    })
    const added = host?.querySelector('[data-tile-hit="new-1"]')
    expect(added).not.toBeNull()
    if (!added) throw new Error('missing new tile')
    act(() => {
      pointerClick(added)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(host?.querySelector('[data-active-session]')?.getAttribute('data-active-session')).toBe(
      'new-1',
    )
  })

  it('does not restart the fly when the opening tile is opened again', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onOpen = vi.fn()
    placeOnHome(['a', 'b'])
    mount([row('a', 'Alpha'), row('b', 'Beta')], onOpen)
    const hit = host?.querySelector('[data-tile-hit="a"]')
    if (!hit) throw new Error('missing tile')
    act(() => {
      pointerClick(hit)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    act(() => {
      hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(host?.querySelector('[data-active-session]')?.getAttribute('data-active-session')).toBe(
      'a',
    )
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('lands once under StrictMode when a thread is already active', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onOpen = vi.fn()
    placeOnHome(['a', 'b'])
    mount([row('a', 'Alpha'), row('b', 'Beta')], onOpen, { activeId: 'a', strict: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    const sessions = host?.querySelectorAll('[data-active-session]') ?? []
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.getAttribute('data-active-session')).toBe('a')
  })

  it('uses the local gateway after selection moves off a remote session', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const remoteBase = 'http://192.168.1.30:8787'
    const remoteId = harnessRow('remote-1')
    const localId = harnessRow('local-1')
    const remoteGateway = {
      ...idleGateway('remote'),
      getHarnessSession: () =>
        Promise.resolve({
          sessionId: remoteId.sessionId,
          harnessId: 'claude-code',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:05:00.000Z',
          status: 'idle',
          title: 'Remote',
        }),
      harnesses: () => Promise.resolve({ harnesses: [CLAUDE] }),
    }
    gatewayFor.mockImplementation((base: string) =>
      Promise.resolve(base === remoteBase ? remoteGateway : idleGateway(base)),
    )
    const seen: unknown[] = []
    vi.mocked(attachHarnessSession).mockImplementation((opts) => {
      seen.push(opts.gateway)
      return { close: vi.fn(), resync: vi.fn(), sync: vi.fn() }
    })
    useConnection.getState().addNode({ name: 'other', baseUrl: remoteBase })
    setSessionNodeBinding(remoteId.key, remoteBase, useConnection.getState().baseUrl)
    const onOpen = vi.fn()
    placeOnHome([remoteId.key, localId.key])
    try {
      mount([remoteId, localId], onOpen, { descriptors: [CLAUDE] })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20)
      })
      expect(seen.at(-1)).toBe(remoteGateway)
      const hit = host?.querySelector('[data-tile-hit="claude-code:local-1"]')
      if (!hit) throw new Error('missing local tile')
      act(() => {
        pointerClick(hit)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20)
      })
      expect(seen.at(-1)).toBe(useConnection.getState().gateway)
    } finally {
      act(() => {
        root?.unmount()
      })
      root = undefined
      clearSessionNodeBinding(remoteId.key)
      useConnection.getState().removeNode(remoteBase)
    }
  })

  it('keeps the opening lease attached when more than the warm cap is parked', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const closes = new Map<string, ReturnType<typeof vi.fn>[]>()
    vi.mocked(attachHarnessSession).mockImplementation((opts) => {
      const close = vi.fn()
      const list = closes.get(opts.sessionId) ?? []
      list.push(close)
      closes.set(opts.sessionId, list)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const rows = Array.from({ length: 30 }, (_, i) => harnessRow(`n${String(i)}`))
    const target = rows[0]?.key
    if (!target) throw new Error('missing row')
    const onOpen = vi.fn()
    placeOnHome(rows.map((item) => item.key))
    mount(rows, onOpen, { descriptors: [CLAUDE] })
    const space = host?.querySelector('[data-alt="space"]')
    if (!(space instanceof HTMLElement)) throw new Error('missing space')
    act(() => {
      space.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const hit = host?.querySelector(`[data-tile-hit="${target}"]`)
    if (!hit) throw new Error('missing tile')
    act(() => {
      pointerClick(hit)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(closes.get(target)).toHaveLength(1)
    expect(closes.get(target)?.[0]).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('holds the opening lease when the store selects a thread', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const closes = new Map<string, ReturnType<typeof vi.fn>[]>()
    vi.mocked(attachHarnessSession).mockImplementation((opts) => {
      const close = vi.fn()
      const list = closes.get(opts.sessionId) ?? []
      list.push(close)
      closes.set(opts.sessionId, list)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const rows = Array.from({ length: 30 }, (_, i) => harnessRow(`n${String(i)}`))
    const target = rows[0]?.key
    if (!target) throw new Error('missing row')
    const onOpen = vi.fn()
    placeOnHome(rows.map((item) => item.key))
    const { render } = mount(rows, onOpen, { descriptors: [CLAUDE] })
    const space = host?.querySelector('[data-alt="space"]')
    if (!(space instanceof HTMLElement)) throw new Error('missing space')
    act(() => {
      space.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(closes.get(target)?.length).toBeGreaterThan(0)
    act(() => {
      render(rows, target)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(closes.get(target)).toHaveLength(1)
    expect(closes.get(target)?.[0]).not.toHaveBeenCalled()
  })

  it('does not remount the open thread when its row is rekeyed', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    let mounts = 0
    let unmounts = 0
    function Probe(props: { id: string }): ReactNode {
      useEffect(() => {
        mounts += 1
        return () => {
          unmounts += 1
        }
      }, [])
      return createElement('div', { 'data-active-session': props.id })
    }
    const onOpen = vi.fn()
    placeOnHome(['draft-1'])
    const base = useConnection.getState().baseUrl
    const { render } = mount([row('draft-1', 'Draft')], onOpen, {
      renderThread: (id) => createElement(Probe, { key: id, id }),
    })
    const hit = host?.querySelector('[data-tile-hit="draft-1"]')
    if (!hit) throw new Error('missing tile')
    act(() => {
      pointerClick(hit)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)
    act(() => {
      useSpaces.getState().rekey(storageKey(base, 'draft-1'), storageKey(base, 'canon-1'))
      useChat.getState().rekey('draft-1', 'canon-1')
      render([row('canon-1', 'Canon')], 'canon-1')
    })
    expect(unmounts).toBe(0)
    expect(mounts).toBe(1)
    expect(host?.querySelector('[data-active-session]')?.getAttribute('data-active-session')).toBe(
      'canon-1',
    )
  })

  it('holds the mini lease after its node binding is evicted', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const remoteBase = 'http://192.168.1.30:8787'
    const remoteRow = harnessRow('remote-1')
    const remoteGateway = {
      ...idleGateway('remote'),
      getHarnessSession: () =>
        Promise.resolve({
          sessionId: remoteRow.sessionId,
          harnessId: 'claude-code',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:05:00.000Z',
          status: 'idle',
          title: 'Remote',
        }),
      harnesses: () => Promise.resolve({ harnesses: [CLAUDE] }),
    }
    gatewayFor.mockImplementation((base: string) =>
      Promise.resolve(base === remoteBase ? remoteGateway : idleGateway(base)),
    )
    const attaches: Array<{ gateway: unknown }> = []
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const resyncs: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation((opts) => {
      attaches.push({ gateway: opts.gateway })
      const close = vi.fn()
      const resync = vi.fn()
      closes.push(close)
      resyncs.push(resync)
      return { close, resync, sync: vi.fn() }
    })
    useConnection.getState().addNode({ name: 'other', baseUrl: remoteBase })
    setSessionNodeBinding(remoteRow.key, remoteBase, useConnection.getState().baseUrl)
    const onOpen = vi.fn()
    placeOnHome([remoteRow.key])
    try {
      mount([remoteRow], onOpen, { descriptors: [CLAUDE] })
      const space = host?.querySelector('[data-alt="space"]')
      if (!(space instanceof HTMLElement)) throw new Error('missing space')
      act(() => {
        space.click()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(host?.querySelector('[data-face="mini"]')).not.toBeNull()
      expect(attaches).toHaveLength(1)
      expect(attaches[0]?.gateway).toBe(remoteGateway)
      clearSessionNodeBinding(remoteRow.key)
      const hit = host?.querySelector(`[data-tile-hit="${remoteRow.key}"]`)
      if (!hit) throw new Error('missing tile')
      act(() => {
        pointerClick(hit)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(attaches).toHaveLength(1)
      expect(attaches[0]?.gateway).toBe(remoteGateway)
      expect(closes[0]).not.toHaveBeenCalled()
      expect(resyncs[0]).not.toHaveBeenCalled()
      expect(onOpen).toHaveBeenCalledWith(remoteRow.key)
    } finally {
      act(() => {
        root?.unmount()
      })
      root = undefined
      clearSessionNodeBinding(remoteRow.key)
      useConnection.getState().removeNode(remoteBase)
    }
  })

  it('puts threads in their spaces and sends a removed space to History', () => {
    const home = useSpaces.getState().addSpace('Home')
    const work = useSpaces.getState().addSpace('Work')
    const base = useConnection.getState().baseUrl
    useSpaces.getState().place(storageKey(base, 'a'), home)
    useSpaces.getState().place(storageKey(base, 'b'), work)
    mount([row('a', 'Alpha'), row('b', 'Beta'), row('c', 'Gamma')], () => undefined)
    expect(host?.querySelector('[data-tile="a"]')?.getAttribute('data-space')).toBe(home)
    expect(host?.querySelector('[data-tile="b"]')?.getAttribute('data-space')).toBe(work)
    expect(host?.querySelector('[data-tile="c"]')).toBeNull()
    expect(host?.querySelector(`[data-region="${home}"]`)).not.toBeNull()
    expect(host?.querySelector(`[data-region="${work}"]`)).not.toBeNull()
    const text = host?.textContent ?? ''
    expect(text).toContain('Home')
    expect(text).toContain('Work')
    expect(text).not.toContain('Unplaced')
    act(() => {
      useSpaces.getState().place(storageKey(base, 'a'), work)
    })
    expect(host?.querySelector('[data-tile="a"]')?.getAttribute('data-space')).toBe(work)
    expect(host?.querySelector('[data-tile="b"]')?.getAttribute('data-space')).toBe(work)
    act(() => {
      useSpaces.getState().removeSpace(work)
    })
    expect(host?.querySelector('[data-tile="a"]')).toBeNull()
    expect(host?.querySelector('[data-tile="b"]')).toBeNull()
    document.body.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }))
    })
    expect(host?.querySelector('[data-history-row="a"]')).not.toBeNull()
    expect(host?.querySelector('[data-history-row="b"]')).not.toBeNull()
    expect(host?.querySelector('[data-history-row="c"]')).not.toBeNull()
  })

  it('with no spaces shows only the new-space control and keeps threads in History', () => {
    mount([row('a', 'Alpha'), row('b', 'Beta')], () => undefined)
    expect(host?.querySelector('[data-tile]')).toBeNull()
    expect(host?.querySelector('[data-empty-spaces]')?.textContent).toContain(
      'No spaces yet. Threads live in History.',
    )
    expect(host?.textContent).toContain('+ New space')
    press({ key: 'h' })
    expect(host?.querySelector('[data-history-row="a"]')).not.toBeNull()
    expect(host?.querySelector('[data-history-row="b"]')).not.toBeNull()
  })

  it('does not let Find claim Enter or Escape after an external open', () => {
    const rows = [row('a', 'Alpha'), row('b', 'Beta')]
    placeOnHome(['a', 'b'])
    const { render } = mount(rows, () => undefined)
    press({ key: '/' })
    expect(document.querySelector('[data-dock="find"]')).not.toBeNull()
    act(() => {
      render(rows, { activeId: 'a' })
    })
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('thread')
    expect(document.querySelector('[data-dock="find"]')).toBeNull()
    const enter = press({ key: 'Enter' })
    const escape = press({ key: 'Escape' })
    expect(enter.defaultPrevented).toBe(false)
    expect(escape.defaultPrevented).toBe(false)
  })

  it('claims Ctrl+J at Everything and not at Thread', () => {
    placeOnHome(['a'])
    mount([row('a', 'Alpha')], () => undefined)
    const claimed = press({ key: 'j', code: 'KeyJ', ctrlKey: true })
    expect(claimed.defaultPrevented).toBe(true)
    act(() => {
      root?.unmount()
    })
    host?.remove()
    mount([row('a', 'Alpha')], () => undefined, { activeId: 'a' })
    const left = press({ key: 'j', code: 'KeyJ', ctrlKey: true })
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('thread')
    expect(left.defaultPrevented).toBe(false)
  })

  it('drags the nested History row, not its ancestor', () => {
    const parent = row('parent', 'Parent')
    const child = { ...row('child', 'Child task'), parentKey: 'parent', updatedAt: 9 }
    mount([parent, child], () => undefined)
    press({ key: 'h' })
    const expand = host?.querySelector('[aria-label="expand nested conversations"]')
    if (!expand) throw new Error('missing expand')
    act(() => {
      expand.click()
    })
    const childRow = host?.querySelector('[data-history-row="child"]')
    if (!childRow) throw new Error('missing child row')
    const title = [...childRow.querySelectorAll('button')].find(
      (button) => !button.hasAttribute('aria-label'),
    )
    if (!title) throw new Error('missing child title')
    act(() => {
      title.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: 0,
          clientY: 0,
        }),
      )
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      )
    })
    expect(host?.querySelector('[data-drag-ghost]')?.textContent).toBe('Child task')
  })

  it('toasts a needs-you episode after the thread goes back to working', () => {
    const rows = [row('a', 'Alpha'), row('b', 'Beta')]
    const { render } = mount(rows, () => undefined, {
      activeId: 'a',
      blockedIds: new Set(['a', 'b']),
      blockedReady: true,
    })
    expect(document.querySelector('[data-needs-toasts]')?.textContent).not.toContain('needs you')
    act(() => {
      render(rows, { blockedIds: new Set() })
    })
    act(() => {
      render(rows, { blockedIds: new Set(['a', 'b']) })
    })
    const toasts = document.querySelector('[data-needs-toasts]')?.textContent ?? ''
    expect(toasts).toContain('Beta needs you')
    expect(toasts).not.toContain('Alpha needs you')
  })

  it('treats membership in a missing space as History', () => {
    const base = useConnection.getState().baseUrl
    useSpaces.getState().addSpace('Home')
    useSpaces.setState({ membership: { [storageKey(base, 'a')]: 'missing' } })
    mount([row('a', 'Alpha')], () => undefined)
    expect(host?.querySelector('[data-tile="a"]')).toBeNull()
    press({ key: 'h' })
    expect(host?.querySelector('[data-history-row="a"]')).not.toBeNull()
  })

  it('targets the framed space, not the selected tile in another space', () => {
    const home = placeOnHome(['a'])
    mount([row('a', 'Alpha')], () => undefined)
    // The only tile starts selected. Clicking it would open Thread, where N is not claimed.
    expect(host?.querySelector('[data-tile="a"]')?.getAttribute('data-selected')).toBe('true')
    press({ key: 'n' })
    const input = document.querySelector('[aria-label="Space name"]')
    if (!input) throw new Error('missing space name')
    const field = input as {
      type: string
      value: string
      _valueTracker?: { setValue: (value: string) => void }
    }
    field.type = 'text'
    field._valueTracker?.setValue('')
    field.value = 'Empty'
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = input.closest('form')
    if (!form) throw new Error('missing form')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('space')
    expect(host?.querySelector('[data-tile="a"]')?.getAttribute('data-selected')).toBe('true')
    expect(host?.querySelector('[data-tile="a"]')?.getAttribute('data-space')).toBe(home)

    press({ key: 'e' })
    const rename = document.querySelector('[aria-label="Space name"]')
    expect((rename as { value?: string } | null)?.value).toBe('Empty')
    cancelDialog()

    press({ key: 'Delete', shiftKey: true })
    const remove = document.body.textContent ?? ''
    expect(remove).toContain('Remove “Empty”?')
    expect(remove).toContain('It has no threads yet.')
    cancelDialog()

    press({ key: 't' })
    expect(document.body.textContent).toContain('Space ·')
    expect(document.body.textContent).toContain('Empty')
    expect(document.querySelector('[aria-label="Space"]')).toBeNull()
    cancelDialog()

    press({ key: '0', code: 'Digit0', ctrlKey: true })
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('everything')
    press({ key: 't' })
    expect(document.querySelector('[aria-label="Space"]')).not.toBeNull()
  })
})

function LandProbe(props: { onLand: () => void }): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  useCamera({
    stageRef,
    worldRef,
    target: { key: 't', mode: 'thread', rect: { x: 0, y: 0, w: 800, h: 500 } },
    onLand: props.onLand,
    onHandAltitude: () => undefined,
    onTileGesture: () => undefined,
  })
  return createElement('div', { ref: stageRef }, createElement('div', { ref: worldRef }))
}

describe('useCamera unmount', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not call onLand after unmount', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onLand = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(LandProbe, { onLand }))
    })
    act(() => {
      root.unmount()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(onLand).not.toHaveBeenCalled()
    host.remove()
  })

  it('does call onLand when the fly is allowed to finish', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onLand = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(LandProbe, { onLand }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(onLand).toHaveBeenCalledTimes(1)
    act(() => {
      root.unmount()
    })
    host.remove()
  })

  it('lands exactly once when StrictMode replays the initial fly', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onLand = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(StrictMode, null, createElement(LandProbe, { onLand })))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(onLand).toHaveBeenCalledTimes(1)
    act(() => {
      root.unmount()
    })
    host.remove()
  })
})

function CarryProbe(props: { generation: number; onLand: () => void }): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  useCamera({
    stageRef,
    worldRef,
    target: {
      key: `t-${String(props.generation)}`,
      mode: 'thread',
      rect: { x: props.generation * 40, y: 0, w: 800, h: 500 },
    },
    onLand: props.onLand,
    onHandAltitude: () => undefined,
    onTileGesture: () => undefined,
  })
  return createElement('div', { ref: stageRef }, createElement('div', { ref: worldRef }))
}

describe('useCamera fly carry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lands once when a snap interrupts a fly toward a thread', () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onLand = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(CarryProbe, { generation: 0, onLand }))
    })
    expect(onLand).not.toHaveBeenCalled()
    act(() => {
      root.render(createElement(CarryProbe, { generation: 1, onLand }))
    })
    expect(onLand).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onLand).toHaveBeenCalledTimes(1)
    act(() => {
      root.unmount()
    })
    host.remove()
  })
})

describe('ThreadMini backfill', () => {
  let root: Root | undefined
  let host: HTMLElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
    resetSessionStreams()
    useChat.setState({ sessionsDirty: 0, messages: {} })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function mountMini(strict: boolean): void {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const mini = createElement(
      QueryClientProvider,
      { client: client() },
      createElement(ThreadMini, { item: row('mini-1', 'Mini') }),
    )
    act(() => {
      root?.render(strict ? createElement(StrictMode, null, mini) : mini)
    })
  }

  it('debounces a global dirty bump and still seeds immediately', async () => {
    vi.useFakeTimers()
    const sessionMessages = vi
      .spyOn(useConnection.getState().gateway, 'sessionMessages')
      .mockResolvedValue({ messages: [] })
    mountMini(false)
    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionMessages).toHaveBeenCalledTimes(1)
    act(() => {
      useChat.setState({ sessionsDirty: useChat.getState().sessionsDirty + 1 })
    })
    expect(sessionMessages).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINI_BACKFILL_DEBOUNCE_MS - 1)
    })
    expect(sessionMessages).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(sessionMessages).toHaveBeenCalledTimes(2)
  })

  it('does not delay the initial seed when StrictMode replays the effect', async () => {
    vi.useFakeTimers()
    const sessionMessages = vi
      .spyOn(useConnection.getState().gateway, 'sessionMessages')
      .mockResolvedValue({ messages: [] })
    mountMini(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionMessages).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINI_BACKFILL_DEBOUNCE_MS)
    })
    expect(sessionMessages).toHaveBeenCalledTimes(2)
  })

  it('keeps the first seed and refetches by the max wait while dirty keeps bumping', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const sessionMessages = vi
      .spyOn(useConnection.getState().gateway, 'sessionMessages')
      .mockImplementation((_sessionId: string, signal?: AbortSignal) => {
        if (signal) signals.push(signal)
        return Promise.resolve({ messages: [] })
      })
    mountMini(false)
    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionMessages).toHaveBeenCalledTimes(1)
    const first = signals[0]
    if (!first) throw new Error('missing seed signal')
    const step = 500
    for (let t = 0; t < MINI_BACKFILL_MAX_WAIT_MS - step; t += step) {
      act(() => {
        useChat.setState({ sessionsDirty: useChat.getState().sessionsDirty + 1 })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(step)
      })
      expect(sessionMessages).toHaveBeenCalledTimes(1)
      expect(first.aborted).toBe(false)
    }
    act(() => {
      useChat.setState({ sessionsDirty: useChat.getState().sessionsDirty + 1 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step)
    })
    expect(first.aborted).toBe(false)
    expect(sessionMessages).toHaveBeenCalledTimes(2)
  })
})
