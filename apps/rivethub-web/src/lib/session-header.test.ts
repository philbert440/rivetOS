import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { narrowHeaderItems, showMobileTopBar } from './session-header.js'

describe('showMobileTopBar', () => {
  it('hides the wordmark bar only while a narrow session is open', () => {
    expect(showMobileTopBar(true, true)).toBe(false)
    expect(showMobileTopBar(true, false)).toBe(true)
  })

  it('never shows on wide, session or not', () => {
    expect(showMobileTopBar(false, true)).toBe(false)
    expect(showMobileTopBar(false, false)).toBe(false)
  })
})

describe('narrowHeaderItems', () => {
  it('is menu · title · context · segmented · history for an idle local session', () => {
    expect(narrowHeaderItems({ running: false, remote: false })).toEqual([
      'menu',
      'title',
      'context',
      'segmented',
      'history',
    ])
  })

  it('rides stop between context and segmented only while running', () => {
    expect(narrowHeaderItems({ running: true, remote: false })).toEqual([
      'menu',
      'title',
      'context',
      'stop',
      'segmented',
      'history',
    ])
  })

  it('inserts the remote badge after the title', () => {
    expect(narrowHeaderItems({ running: true, remote: true })).toEqual([
      'menu',
      'title',
      'remote',
      'context',
      'stop',
      'segmented',
      'history',
    ])
  })
})

describe('narrow session header wiring (chat.tsx source)', () => {
  const src = readFileSync(new URL('../pages/chat.tsx', import.meta.url), 'utf8')

  it('has no back chevron anywhere (back is the history drawer)', () => {
    expect(src).not.toContain('ChevronLeft')
    expect(src).not.toContain('onBack')
  })

  it('renders ☰ before the id and history last, in one nowrap h-12 row', () => {
    const menu = src.indexOf('aria-label="Open menu"')
    const title = src.indexOf('min-w-0 flex-1 truncate font-mono text-xs')
    const history = src.indexOf('id="hub-history-toggle"')
    expect(menu).toBeGreaterThan(-1)
    expect(title).toBeGreaterThan(menu)
    expect(history).toBeGreaterThan(title)
    expect(src).toContain('flex h-12 flex-nowrap items-center')
  })

  it('labels the history button Conversations and points it at the drawer', () => {
    expect(src).toContain('aria-label="Conversations"')
    expect(src).toContain('aria-controls="hub-history"')
    expect(src).toContain('id="hub-history"')
  })

  it('opens the left drawer from the session header', () => {
    expect(src).toContain('setDrawerOpen(true)')
  })
})
