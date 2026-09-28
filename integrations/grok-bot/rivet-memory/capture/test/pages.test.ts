import { describe, expect, it } from 'vitest'
import { normalizeRecords, toIngestRows } from '../src/normalize.js'
import { formatMergeConflicts, mergeParsedInputs, normalizePages } from '../src/pages.js'
import { parseInput } from '../src/parse.js'
import { ORDINAL_STRIDE } from '../src/types.js'
import { BETA_ID } from './ids.js'

const BETA = BETA_ID

function rec(role: string, text: string, extra?: unknown) {
  if (role === 'tool') {
    return {
      role: 'tool',
      message: { content: [{ type: 'tool_result', name: 'shell', result: text }] },
    }
  }
  if (role === 'assistant' && extra) {
    return {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text },
          { type: 'tool_use', name: 'shell', input: extra },
        ],
      },
    }
  }
  return { role, message: { content: [{ type: 'text', text }] } }
}

function pageText(a: number, records: unknown[]): string {
  const b = a + records.length - 1
  const header = `Transcript of agent "Beta" (${BETA}), positions ${String(a)}–${String(b)} of 20:`
  return [header, ...records.map((r) => JSON.stringify(r))].join('\n') + '\n'
}

const ALL = [
  rec(
    'user',
    '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\none\n</user_query>',
  ),
  rec('assistant', 'reply one', { cmd: 'ls' }),
  rec('tool', '{"ok":true}'),
  rec(
    'user',
    '<timestamp>Sunday, Sep 27, 2026, 4:07 PM (UTC-4)</timestamp>\n<user_query>\ntwo\n</user_query>',
  ),
  rec('assistant', 'reply two'),
]

describe('page merge / stable ordinals', () => {
  it('overlapping or out-of-order pages match a single pass', () => {
    const full = parseInput(pageText(10, ALL))
    const first = parseInput(pageText(10, ALL.slice(0, 3)))
    const second = parseInput(pageText(12, ALL.slice(2)))
    const opts = { sessionKey: 'grokbot-beta-v3', agent: 'grokbot-beta', agentId: BETA }
    const single = normalizeRecords(full.records, {
      ...opts,
      format: 'page',
      startPosition: full.header?.a ?? 0,
    })
    const merged = normalizePages([second, first], opts)
    const outOfOrder = normalizePages([first, second], opts)

    const ids = (r: typeof single) => r.messages.map((m) => m.event_id)
    expect(ids(merged)).toEqual(ids(single))
    expect(ids(outOfOrder)).toEqual(ids(single))
    expect(merged.messages.map((m) => m.metadata?.ordinal)).toEqual(
      single.messages.map((m) => m.metadata?.ordinal),
    )
    expect(toIngestRows(merged.messages).map((r) => r.ordinal)).toEqual(
      toIngestRows(single.messages).map((r) => r.ordinal),
    )
  })

  it('reports position conflicts when overlapping pages disagree', () => {
    const first = parseInput(pageText(10, [rec('user', 'one')]))
    const second = parseInput(pageText(10, [rec('user', 'OTHER')]))
    const merged = mergeParsedInputs([first, second])
    expect(merged.conflicts).toEqual([10])
    expect(merged.records[0]).toEqual(first.records[0])
    expect(formatMergeConflicts(merged.conflicts)).toMatch(/CONFLICT positions 10/)
    const result = normalizePages([first, second], {
      sessionKey: 'grokbot-beta-v3',
      agent: 'grokbot-beta',
      agentId: BETA,
    })
    expect(result.conflicts).toEqual([10])
  })

  it('derives ordinal from position * stride + sub-index', () => {
    const parsed = parseInput(pageText(10, ALL.slice(0, 2)))
    const { messages } = normalizeRecords(parsed.records, {
      sessionKey: 'grokbot-beta-v3',
      agent: 'grokbot-beta',
      format: 'page',
      startPosition: 10,
    })
    expect(messages[0].metadata?.position).toBe(10)
    expect(messages[0].metadata?.ordinal).toBe(10 * ORDINAL_STRIDE)
    const toolUses = messages.filter((m) => m.role === 'assistant')
    expect(toolUses.length).toBeGreaterThan(1)
    expect(toolUses[0].metadata?.ordinal).toBe(11 * ORDINAL_STRIDE)
    expect(toolUses[1].metadata?.ordinal).toBe(11 * ORDINAL_STRIDE + 1)
  })
})
