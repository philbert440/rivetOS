/**
 * Unit tests for v5 compactor prompt formatters.
 *
 * No DB, no LLM required. Formatters are pure functions.
 */

import { describe, it, expect } from 'vitest'
import { formatLeafPrompt, formatBranchPrompt, formatRootPrompt } from './compactor.ts'
import { fmtIsoMinute } from './types.ts'
import type { ConversationMeta, CompactMessageRow, SummaryRow } from './types.ts'

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const conv: ConversationMeta = {
  id: 'conv-abc-123',
  agent: 'opus',
  channel: 'discord',
  channel_id: '987',
  title: 'Memory v5 testing',
}

const convNoChannelId: ConversationMeta = {
  id: 'conv-xyz-999',
  agent: 'grok',
  channel: 'terminal',
  channel_id: null,
  title: null,
}

function msg(
  overrides: Partial<CompactMessageRow> & {
    id: string
    role: string
    content: string | null
    created_at: Date
  },
): CompactMessageRow {
  return {
    agent: 'opus',
    tool_name: null,
    tool_args: null,
    ...overrides,
  }
}

function summary(
  overrides: Partial<SummaryRow> & { id: string; content: string; created_at: Date },
): SummaryRow {
  return {
    kind: 'leaf',
    earliest_at: overrides.earliest_at ?? overrides.created_at,
    latest_at: overrides.latest_at ?? overrides.created_at,
    message_count: 10,
    ...overrides,
  }
}

const t1 = new Date('2026-04-18T12:00:00Z')
const t2 = new Date('2026-04-18T12:05:00Z')
const t3 = new Date('2026-04-18T12:10:00Z')

// ---------------------------------------------------------------------
// fmtIsoMinute
// ---------------------------------------------------------------------

describe('fmtIsoMinute', () => {
  it('returns ISO minute with Z', () => {
    expect(fmtIsoMinute(t1)).toBe('2026-04-18T12:00Z')
  })

  it('strips seconds and ms', () => {
    expect(fmtIsoMinute(new Date('2026-04-18T12:05:37.412Z'))).toBe('2026-04-18T12:05Z')
  })
})

// ---------------------------------------------------------------------
// formatLeafPrompt
// ---------------------------------------------------------------------

describe('formatLeafPrompt', () => {
  it('renders preamble with conv metadata', () => {
    const output = formatLeafPrompt(conv, [
      msg({ id: '1', role: 'user', content: 'Hi', created_at: t1 }),
    ])
    expect(output).toContain('id:        conv-abc-123')
    expect(output).toContain('agent:     opus')
    expect(output).toContain('channel:   discord (987)')
    expect(output).toContain('title:     Memory v5 testing')
    expect(output).toContain('messages:  1 in this batch')
  })

  it('handles missing title and channel_id', () => {
    const output = formatLeafPrompt(convNoChannelId, [
      msg({ id: '1', role: 'user', content: 'Test', created_at: t1 }),
    ])
    expect(output).toContain('channel:   terminal')
    expect(output).not.toContain('(null)')
    expect(output).not.toContain('title:')
  })

  it('renders span as min→max timestamp', () => {
    const output = formatLeafPrompt(conv, [
      msg({ id: '1', role: 'user', content: 'a', created_at: t1 }),
      msg({ id: '2', role: 'assistant', content: 'b', created_at: t3 }),
    ])
    expect(output).toContain('span:      2026-04-18T12:00Z → 2026-04-18T12:10Z')
  })

  it('numbers messages and shows role/agent per message', () => {
    const output = formatLeafPrompt(conv, [
      msg({ id: '1', role: 'user', content: 'Question', created_at: t1, agent: 'opus' }),
      msg({
        id: '2',
        role: 'assistant',
        content: 'Answer',
        created_at: t2,
        agent: 'opus',
      }),
    ])
    expect(output).toMatch(/\[#01 2026-04-18T12:00Z opus\/user\]/)
    expect(output).toMatch(/\[#02 2026-04-18T12:05Z opus\/assistant\]/)
  })

  it('renders a tool-call fallback when content is empty and tool_name is set', () => {
    const output = formatLeafPrompt(conv, [
      msg({
        id: '1',
        role: 'assistant',
        content: '',
        created_at: t1,
        tool_name: 'exec',
        tool_args: { command: 'df -h' },
      }),
    ])
    expect(output).toContain('(tool call) exec')
    expect(output).toContain('df -h')
  })

  it('renders a tool-call fallback when content is null', () => {
    const output = formatLeafPrompt(conv, [
      msg({
        id: '1',
        role: 'assistant',
        content: null,
        created_at: t1,
        tool_name: 'read',
        tool_args: { path: '/tmp/foo' },
      }),
    ])
    expect(output).toContain('(tool call) read')
  })

  it('truncates huge tool_args blobs at 2000 chars', () => {
    const huge = 'x'.repeat(5000)
    const output = formatLeafPrompt(conv, [
      msg({
        id: '1',
        role: 'assistant',
        content: '',
        created_at: t1,
        tool_name: 'exec',
        tool_args: { blob: huge },
      }),
    ])
    // Should not include the full 5000-char blob
    expect(output.length).toBeLessThan(3000)
  })

  it('separates messages with --- delimiter', () => {
    const output = formatLeafPrompt(conv, [
      msg({ id: '1', role: 'user', content: 'one', created_at: t1 }),
      msg({ id: '2', role: 'assistant', content: 'two', created_at: t2 }),
    ])
    const separators = output.match(/\n---\n/g) ?? []
    // 1 between preamble and body + 1 between the 2 messages = 2 total
    expect(separators.length).toBe(2)
  })
})

// ---------------------------------------------------------------------
// formatBranchPrompt
// ---------------------------------------------------------------------

describe('formatBranchPrompt', () => {
  it('renders branch preamble with leaf count', () => {
    const output = formatBranchPrompt(conv, [
      summary({ id: 's1', content: 'Leaf 1 summary', created_at: t1 }),
      summary({ id: 's2', content: 'Leaf 2 summary', created_at: t2 }),
    ])
    expect(output).toContain('leaves:    2 in this branch')
  })

  it('labels leaves as [Leaf #N from → to | N msgs]', () => {
    const output = formatBranchPrompt(conv, [
      summary({
        id: 's1',
        content: 'first',
        created_at: t1,
        earliest_at: t1,
        latest_at: t2,
        message_count: 10,
      }),
    ])
    expect(output).toMatch(/\[Leaf #01 2026-04-18T12:00Z → 2026-04-18T12:05Z \| 10 msgs\]/)
  })

  it('includes leaf content verbatim', () => {
    const output = formatBranchPrompt(conv, [
      summary({ id: 's1', content: 'Specific leaf text', created_at: t1 }),
    ])
    expect(output).toContain('Specific leaf text')
  })
})

// ---------------------------------------------------------------------
// formatRootPrompt
// ---------------------------------------------------------------------

describe('formatRootPrompt', () => {
  it('renders root preamble with branch count', () => {
    const output = formatRootPrompt(conv, [
      summary({ id: 'b1', content: 'Branch 1', kind: 'branch', created_at: t1 }),
      summary({ id: 'b2', content: 'Branch 2', kind: 'branch', created_at: t2 }),
      summary({ id: 'b3', content: 'Branch 3', kind: 'branch', created_at: t3 }),
    ])
    expect(output).toContain('branches:  3 in this root')
  })

  it('labels branches as [Branch #N from → to | N msgs]', () => {
    const output = formatRootPrompt(conv, [
      summary({
        id: 'b1',
        content: 'Branch content',
        kind: 'branch',
        created_at: t1,
        earliest_at: t1,
        latest_at: t3,
        message_count: 50,
      }),
    ])
    expect(output).toMatch(/\[Branch #01 2026-04-18T12:00Z → 2026-04-18T12:10Z \| 50 msgs\]/)
  })
})
