import './test-dom.js'
import { createElement, StrictMode, useRef, type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { HarnessDescriptor, SessionId } from '@rivetos/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { MINI_BACKFILL_DEBOUNCE_MS } from './ThreadMini.js'
import { resetSessionStreams } from '../../lib/use-session-stream.js'
import { useChat } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
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
  it('renders one card tile per row at everything', () => {
    const html = markup(
      createElement(SpacesCanvas, {
        rows: [row('a', 'Alpha', 'idle'), row('b', 'Beta', 'active')],
        onOpen: () => undefined,
        renderThread: () => null,
      }),
    )
    expect(html).toContain('data-tile="a"')
    expect(html).toContain('data-tile="b"')
    expect(html).toContain('data-face="card"')
    expect(html).toContain('data-altitude="everything"')
    expect(html).not.toContain('data-face="mini"')
    expect(html).not.toContain('id="conversations-pane"')
    expect(html).toContain('st-idle')
    expect(html).toContain('st-working')
    expect(html).toContain('Alpha')
    expect(html).toContain('Unplaced')
    expect(html).toContain('1 active · 0 waiting on you')
    expect(html).toContain('idle')
    expect(html).toContain('working')
    expect(html).toContain('--cs')
    expect(html).toContain('--ch')
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
    opts?: { activeId?: string; strict?: boolean; descriptors?: HarnessDescriptor[] },
  ) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const query = client()
    let activeId = opts?.activeId
    const render = (next: ChatItem[], nextActive?: string): void => {
      if (nextActive !== undefined) activeId = nextActive
      const canvas = createElement(
        QueryClientProvider,
        { client: query },
        createElement(SpacesCanvas, {
          rows: next,
          activeId,
          descriptors: opts?.descriptors,
          onOpen,
          renderThread: (id: string) => createElement('div', { 'data-active-session': id }, id),
        }),
      )
      root?.render(opts?.strict ? createElement(StrictMode, null, canvas) : canvas)
    }
    act(() => {
      render(rows)
    })
    return { render }
  }

  it('click selects a card and the next click opens it', () => {
    const onOpen = vi.fn()
    mount([row('a', 'Alpha'), row('b', 'Beta')], onOpen)
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
    mount([row('a', 'Alpha'), row('b', 'Beta')], onOpen)
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('everything')
    const unplaced = host?.querySelector('[aria-label="Location"]')?.querySelectorAll('button')[1]
    if (!(unplaced instanceof HTMLElement)) throw new Error('missing Unplaced')
    unplaced.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpen).not.toHaveBeenCalled()
    expect(host?.querySelector('[data-altitude]')?.getAttribute('data-altitude')).toBe('space')
  })

  it('keeps the open thread mounted across a draft rekey and admits a new row', async () => {
    vi.useFakeTimers(FLY_CLOCK)
    const onOpen = vi.fn()
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
      useChat.getState().rekey('draft-1', 'canon-1')
      render([row('canon-1', 'Canon')], 'canon-1')
    })
    expect(host?.querySelector('[data-tile="canon-1"]')).not.toBeNull()
    expect(host?.querySelector('[data-active-session]')?.getAttribute('data-active-session')).toBe(
      'canon-1',
    )
    act(() => {
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
})
