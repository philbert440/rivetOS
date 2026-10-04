/**
 * Unit tests for composeMessageEmbedText — pure, no PG.
 */

import { describe, expect, it } from 'vitest'
import { TOOL_RESULT_EMBED_CAP, composeMessageEmbedText } from './compose-embed-text.js'

describe('composeMessageEmbedText', () => {
  it('returns content alone when tool_result is empty', () => {
    expect(composeMessageEmbedText('hello world', null)).toBe('hello world')
    expect(composeMessageEmbedText('hello world', '')).toBe('hello world')
    expect(composeMessageEmbedText('hello world', '   ')).toBe('hello world')
  })

  it('returns tool_result alone when content is a blank placeholder-less row', () => {
    expect(composeMessageEmbedText(null, 'exit 1: EACCES')).toBe('exit 1: EACCES')
    expect(composeMessageEmbedText('', 'payload only')).toBe('payload only')
    expect(composeMessageEmbedText('  ', 'payload only')).toBe('payload only')
  })

  it('joins content + tool_result for tool rows (the daily-use footgun)', () => {
    const text = composeMessageEmbedText(
      '[tool] run_terminal_command',
      'Permission denied: /opt/rivetos/node_modules',
    )
    expect(text).toBe(
      '[tool] run_terminal_command\nPermission denied: /opt/rivetos/node_modules',
    )
    expect(text).toContain('Permission denied')
  })

  it('trims both sides', () => {
    expect(composeMessageEmbedText('  hi  ', '  there  ')).toBe('hi\nthere')
  })

  it('returns empty string when both sides are blank', () => {
    expect(composeMessageEmbedText(null, null)).toBe('')
    expect(composeMessageEmbedText('', '')).toBe('')
    expect(composeMessageEmbedText('  ', null)).toBe('')
  })

  it(`caps tool_result at ${String(TOOL_RESULT_EMBED_CAP)} chars`, () => {
    const huge = 'x'.repeat(TOOL_RESULT_EMBED_CAP + 5000)
    const out = composeMessageEmbedText('[tool] bash', huge)
    expect(out.length).toBe('[tool] bash\n'.length + TOOL_RESULT_EMBED_CAP)
    expect(out.startsWith('[tool] bash\n')).toBe(true)
    expect(out.endsWith('x')).toBe(true)
  })
})
