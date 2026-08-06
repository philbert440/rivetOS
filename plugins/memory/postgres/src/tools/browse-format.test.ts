/**
 * Unit tests for formatBrowseMessageBody — pure browse-row body formatting
 * (content + tool_result previews + recovery handles).
 */

import { describe, it, expect } from 'vitest'
import { formatBrowseMessageBody, truncationHint } from './helpers.js'

describe('formatBrowseMessageBody', () => {
  it('returns short content unchanged when no tool_result', () => {
    const body = formatBrowseMessageBody({
      id: 'm1',
      content: 'hello world',
      tool_name: null,
      tool_result: null,
      metadata: null,
    })
    expect(body).toBe('hello world')
  })

  it('includes tool_result so tool rows are not placeholder-only', () => {
    const body = formatBrowseMessageBody({
      id: 'm2',
      content: '[tool] search_tool',
      tool_name: 'search_tool',
      tool_result: 'Found 3 matching files under packages/cli',
      metadata: null,
    })
    expect(body).toContain('[tool] search_tool')
    expect(body).toContain('[tool_result (search_tool)]')
    expect(body).toContain('Found 3 matching files under packages/cli')
    expect(body).not.toContain('memory_get_full')
  })

  it('display-truncates long content and points at memory_get_full when complete', () => {
    const long = 'x'.repeat(600)
    const body = formatBrowseMessageBody({
      id: 'm3',
      content: long,
      tool_name: null,
      tool_result: null,
      metadata: null,
    })
    expect(body.startsWith('x'.repeat(500) + '…')).toBe(true)
    expect(body).toContain('display-truncated content 600 chars → memory_get_full id=m3')
  })

  it('display-truncates long tool_result with get_full handle when complete', () => {
    const longResult = 'y'.repeat(1200)
    const body = formatBrowseMessageBody(
      {
        id: 'm4',
        content: '[tool] Bash',
        tool_name: 'Bash',
        tool_result: longResult,
        metadata: null,
      },
      { toolResultLimit: 800 },
    )
    expect(body).toContain('[tool_result (Bash) 1200 chars]')
    expect(body).toContain('y'.repeat(800) + '…')
    expect(body).toContain('display-truncated tool_result → memory_get_full id=m4')
  })

  it('does not add display get_full when capture-truncated (disk recovery path)', () => {
    const long = 'z'.repeat(600)
    const body = formatBrowseMessageBody({
      id: 'm5',
      content: long,
      tool_name: 'Bash',
      tool_result: 'partial',
      metadata: { truncated: true, full_tool_result_length: 40000 },
    })
    expect(body).toContain('z'.repeat(500) + '…')
    expect(body).not.toContain('display-truncated')
    expect(body).toContain(truncationHint({ truncated: true, full_tool_result_length: 40000 }, 'm5').trim())
  })

  it('omits empty tool_result strings', () => {
    const body = formatBrowseMessageBody({
      id: 'm6',
      content: 'plain',
      tool_name: 'noop',
      tool_result: '',
      metadata: null,
    })
    expect(body).toBe('plain')
  })
})
