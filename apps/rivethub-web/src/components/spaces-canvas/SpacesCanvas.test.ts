import './test-dom.js'
import { createElement, useRef, type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/agent-gateway.js', () => ({
  gatewayFor: () =>
    Promise.resolve({
      getHarnessSession: () => Promise.reject(new Error('unused')),
      harnesses: () => Promise.resolve({ harnesses: [] }),
      sessionMessages: () => Promise.resolve({ messages: [] }),
      harnessSessions: () => Promise.resolve({ sessions: [] }),
    }),
}))

vi.mock('../transcript.js', () => ({
  Transcript: () => null,
}))

import type { ChatItem } from '../../lib/harness-chat.js'
import { resetSessionStreams } from '../../lib/use-session-stream.js'
import { canvasKeyClaims, performCanvasEffect, reduceCanvasCommand } from './canvas-input.js'
import { SpacesCanvas } from './SpacesCanvas.js'
import { useCamera } from './use-camera.js'

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
    vi.useRealTimers()
  })

  function mount(rows: ChatItem[], onOpen: (id: string) => void) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const query = client()
    const render = (next: ChatItem[]): void => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: query },
          createElement(SpacesCanvas, {
            rows: next,
            onOpen,
            renderThread: (id: string) => createElement('div', { 'data-active-session': id }, id),
          }),
        ),
      )
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
})
