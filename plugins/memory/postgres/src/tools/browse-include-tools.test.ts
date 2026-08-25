/**
 * Unit tests for memory_browse include_tools default (exclude role=tool).
 */

import { describe, it, expect } from 'vitest'
import { wantsIncludeTools } from './browse-tool.js'

describe('wantsIncludeTools', () => {
  it('defaults to false (tools excluded)', () => {
    expect(wantsIncludeTools({})).toBe(false)
  })

  it('treats explicit false as excluded', () => {
    expect(wantsIncludeTools({ include_tools: false })).toBe(false)
  })

  it('only true opts in', () => {
    expect(wantsIncludeTools({ include_tools: true })).toBe(true)
  })

  it('ignores truthy non-boolean junk', () => {
    expect(wantsIncludeTools({ include_tools: 'true' })).toBe(false)
    expect(wantsIncludeTools({ include_tools: 1 })).toBe(false)
  })
})
