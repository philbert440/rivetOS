import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { railHeaderClass, railToggle } from './sidebar-chrome.js'

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

  it('has one aria-controls per mode branch and no bottom-row chevron import', () => {
    const src = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')
    const controls = src.match(/aria-controls="hub-rail-nav"/g) ?? []
    expect(controls).toHaveLength(2)
    expect(src).not.toMatch(/\bChevronLeft\b/)
    expect(src).not.toMatch(/\bChevronRight\b/)
  })
})
