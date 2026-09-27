import { describe, expect, it } from 'vitest'
import { normalizeRecords, toIngestRows } from '../src/normalize.js'
import { normalizePages } from '../src/pages.js'
import { parseInput } from '../src/parse.js'
import { ORDINAL_STRIDE } from '../src/types.js'

const BOB = '00df02ea-4f5f-4d3e-945a-864e1c9c78dc'

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
  const header = `Transcript of agent "Bob" (${BOB}), positions ${String(a)}–${String(b)} of 20:`
  return [header, ...records.map((r) => JSON.stringify(r))].join('\n') + '\n'
}

const ALL = [
  rec('user', '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\none\n</user_query>'),
  rec('assistant', 'reply one', { cmd: 'ls' }),
  rec('tool', '{"ok":true}'),
  rec('user', '<timestamp>Sunday, Sep 27, 2026, 4:07 PM (UTC-4)</timestamp>\n<user_query>\ntwo\n</user_query>'),
  rec('assistant', 'reply two'),
]

describe('page merge / stable ordinals', () => {
  it('overlapping or out-of-order pages match a single pass', () => {
    const full = parseInput(pageText(10, ALL))
    const first = parseInput(pageText(10, ALL.slice(0, 3)))
    const second = parseInput(pageText(12, ALL.slice(2)))
    const opts = { sessionKey: 'grokbot-bob-v3', agent: 'rivet-bob', agentId: BOB }
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

  it('derives ordinal from position * stride + sub-index', () => {
    const parsed = parseInput(pageText(10, ALL.slice(0, 2)))
    const { messages } = normalizeRecords(parsed.records, {
      sessionKey: 'grokbot-bob-v3',
      agent: 'rivet-bob',
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
