import { createElement, type JSX } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NARROW_MAX_PX,
  narrowMediaQuery,
  readIsNarrow,
  subscribeIsNarrow,
  useIsNarrow,
} from './use-narrow.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('narrowMediaQuery', () => {
  it('defaults to max-width 767px (below Tailwind md)', () => {
    expect(NARROW_MAX_PX).toBe(767)
    expect(narrowMediaQuery()).toBe('(max-width: 767px)')
    expect(narrowMediaQuery(640)).toBe('(max-width: 640px)')
  })
})

describe('readIsNarrow', () => {
  it('is false when matchMedia is missing (SSR / tests)', () => {
    expect(readIsNarrow()).toBe(false)
  })

  it('reads window.matchMedia', () => {
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({
        matches: q === '(max-width: 767px)',
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    })
    expect(readIsNarrow()).toBe(true)
    expect(readIsNarrow(640)).toBe(false)
  })
})

describe('subscribeIsNarrow', () => {
  it('subscribes to matchMedia change and unsubscribes', () => {
    const added: Array<() => void> = []
    const removed: Array<() => void> = []
    vi.stubGlobal('window', {
      matchMedia: () => ({
        matches: false,
        media: '(max-width: 767px)',
        addEventListener: (_type: string, cb: () => void) => added.push(cb),
        removeEventListener: (_type: string, cb: () => void) => removed.push(cb),
      }),
    })
    const onChange = (): void => undefined
    const unsub = subscribeIsNarrow(onChange)
    expect(added).toEqual([onChange])
    unsub()
    expect(removed).toEqual([onChange])
  })
})

describe('useIsNarrow', () => {
  it('SSR snapshot is desktop (false)', () => {
    function Probe(): JSX.Element {
      return createElement('span', null, useIsNarrow() ? 'narrow' : 'wide')
    }
    expect(renderToString(createElement(Probe))).toBe('<span>wide</span>')
  })
})
