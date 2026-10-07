import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size
    },
  })
  vi.stubGlobal('window', { location: { origin: 'http://192.168.1.20:8787' } })
})
import type { ChatItem } from '../../lib/harness-chat.js'
import { canvasKeyClaims, performCanvasEffect, reduceCanvasCommand } from './canvas-input.js'
import { SpacesCanvas } from './SpacesCanvas.js'

function row(key: string, title: string, status?: ChatItem['status']): ChatItem {
  return { key, kind: 'legacy', title, updatedAt: 1, status }
}

describe('SpacesCanvas', () => {
  it('renders one card tile per row at everything', () => {
    const html = renderToStaticMarkup(
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
    expect(html).toContain('st-idle')
    expect(html).toContain('st-working')
    expect(html).toContain('Alpha')
    expect(html).toContain('Unplaced')
    expect(html).toContain('1 active · 0 waiting on you')
    expect(html).toContain('idle')
    expect(html).toContain('working')
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
