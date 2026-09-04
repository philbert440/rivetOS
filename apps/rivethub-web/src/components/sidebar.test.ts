import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hubPageTitle, railHeaderClass, railToggle } from './sidebar-chrome.js'

describe('hubPageTitle', () => {
  it('labels the mobile top bar from the pathname', () => {
    expect(hubPageTitle('/')).toBe('RivetHub')
    expect(hubPageTitle('/memory')).toBe('Memory')
    expect(hubPageTitle('/memory/foo')).toBe('Memory')
    expect(hubPageTitle('/files')).toBe('Files')
    expect(hubPageTitle('/tasks')).toBe('Tasks')
    expect(hubPageTitle('/workflows')).toBe('Workflows')
    expect(hubPageTitle('/settings')).toBe('Settings')
  })
})

describe('rail header toggle', () => {
  it('keeps relative positioning and the same vertical padding token in both modes', () => {
    const expanded = railHeaderClass(false)
    const collapsed = railHeaderClass(true)
    expect(expanded).toContain('relative')
    expect(collapsed).toContain('relative')
    const pyExpanded = expanded.match(/\bpy-\d+\b/)?.[0]
    const pyCollapsed = collapsed.match(/\bpy-\d+\b/)?.[0]
    expect(pyExpanded).toBeDefined()
    expect(pyCollapsed).toBe(pyExpanded)
  })

  it('does not use an h- height token that differs between modes', () => {
    const hTokens = (className: string): string[] => className.match(/\bh-\d+\b/g) ?? []
    expect(hTokens(railHeaderClass(false)).sort()).toEqual(hTokens(railHeaderClass(true)).sort())
  })

  it('maps each mode to the matching header toggle chrome', () => {
    expect(railToggle(false)).toEqual({
      kind: 'collapse',
      ariaExpanded: true,
      label: 'Collapse sidebar',
    })
    expect(railToggle(true)).toEqual({
      kind: 'expand',
      ariaExpanded: false,
      label: 'Expand sidebar',
    })
  })

  it('has one logo toggle and no collapse/expand icon', () => {
    const src = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')
    const controls = src.match(/aria-controls="hub-rail-nav"/g) ?? []
    expect(controls).toHaveLength(1)
    expect(src).not.toMatch(/\bPanelLeftClose\b/)
    expect(src).not.toMatch(/\bPanelLeftOpen\b/)
    expect(src).not.toMatch(/\bChevronLeft\b/)
    expect(src).not.toMatch(/\bChevronRight\b/)
    expect(src).toContain('setRailCollapsed(!railCollapsed)')
  })

  it('does not render an unarchived-count conversations badge', () => {
    const src = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')
    expect(src).not.toContain('unarchivedCount')
    expect(src).not.toContain('railBadgeText')
    expect(src).not.toContain('conversationsBadge')
  })

  it('does not re-open the conversations pane outside the rail button', () => {
    const agents = readFileSync(new URL('./agents-section.tsx', import.meta.url), 'utf8')
    const memory = readFileSync(new URL('../memory/MemoryHubPage.tsx', import.meta.url), 'utf8')
    const chat = readFileSync(new URL('../pages/chat.tsx', import.meta.url), 'utf8')
    expect(agents).not.toContain('openConversation(')
    expect(memory).not.toContain('openConversation(')
    expect(chat).not.toContain('openConversation(')
  })

  it('closed narrow drawer is inert so it leaves the a11y tree', () => {
    const src = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')
    expect(src).toContain('inert={narrow && !drawerOpen')
    expect(src).toContain('aria-modal={narrow && drawerOpen')
    expect(src).toContain("role={narrow ? 'dialog'")
    expect(src).toContain("aria-label={narrow ? 'Navigation'")
    expect(src).toContain("drawerOpen ? 'translate-x-0' : '-translate-x-full'")
  })

  it('does not render a ws-status dot on Conversations', () => {
    const src = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')
    expect(src).not.toContain('wsStatus')
    expect(src).not.toContain('showWs')
    // Unread-notifications still uses bg-red/10 and bg-red/20. The
    // Conversations dots used the standalone class `'bg-red'`.
    expect(src).not.toContain("'bg-red'")
  })
})

describe('MobileTopBar ☰ opener', () => {
  it('makes the lucide Menu button the rail toggle, labelled "Open menu"', () => {
    const src = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')
    expect(src).toContain('aria-label="Open menu"')
    expect(src).toContain('id="hub-rail-toggle"')
    expect(src).toContain('<Menu className="size-5 shrink-0" aria-hidden />')
    // The DenBot stays as brand — it is no longer the toggle button.
    expect(src).not.toContain('aria-label="Open sidebar"')
  })

  it('keeps the 44px hit box on the opener', () => {
    const src = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')
    const toggle = src.indexOf('id="hub-rail-toggle"')
    const hitBox = src.indexOf('size-11 shrink-0 p-0', toggle)
    expect(hitBox).toBeGreaterThan(toggle)
  })
})
