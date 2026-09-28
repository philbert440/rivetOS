import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capForStorage, eventIdFromContent } from '@rivetos/capture-core'
import { describe, expect, it } from 'vitest'
import { classifyHidden, extractAgentMessage } from '../src/hidden.js'
import {
  agentIdFromTranscriptPath,
  discoverModels,
  identityFor,
  identityForSession,
  listInputFiles,
  loadIdentityConfig,
  peekParentLastKnownTime,
  resolveSourceAgentId,
  slug,
} from '../src/identity.js'
import { ORDINAL_STRIDE } from '../src/types.js'
import { mergeParsedInputs, normalizePages } from '../src/pages.js'
import { LEGACY_TOOL_RESULT_MAX, legacyNormalizeRecords } from '../src/legacy.js'
import {
  clampCreatedAt,
  normalizeRecords,
  replaySkipIndices,
  toIngestRows,
} from '../src/normalize.js'
import { detectFormat, parseInput, parsePageHeader, toolResultBody } from '../src/parse.js'
import {
  assignRecleanPositions,
  isRowShapedSession,
  recleanFromSource,
  recleanStoredRows,
  storedRowPosition,
  v3RowsSession,
  v3Session,
} from '../src/reclean.js'
import { resolveIdent } from '../src/cli.js'
import {
  addMs,
  deriveCreatedAt,
  parseEpochMs,
  parseGrokTimestamp,
  parseKnownTime,
} from '../src/timestamps.js'
import { CONTENT_LIMIT, INHERIT_STEP_MS, stripSessionSuffix } from '../src/types.js'
import { stubImagePayloads } from '../src/storage.js'
import { countNoise, extractUserText, stripWrappers } from '../src/wrappers.js'
import { STORAGE_LIMIT } from '../src/types.js'
import { compareInput } from '../src/compare.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const RIVET_ID = '6a155e75-0dd5-4c8a-8391-994878ed683a'
const EGG_ID = 'fe09510f-c3ce-49bc-9d93-8c5ab5705809'
const BOB_ID = '00df02ea-4f5f-4d3e-945a-864e1c9c78dc'
const GARY_ID = '71aebcf6-8b3b-4649-abe1-ad6d653e6156'

function readFix(name: string): string {
  return readFileSync(join(FIX, name), 'utf8')
}

function rivetOpts(session = 'grokbot-rivet-grokbot') {
  return { sessionKey: session, agent: 'rivet-grokbot', agentId: RIVET_ID, persona: 'Rivet' }
}

function normalizeFile(
  name: string,
  extra?: { sessionKey?: string; agent?: string; agentId?: string },
) {
  const text = readFix(name)
  const parsed = parseInput(text)
  return {
    parsed,
    result: normalizeRecords(parsed.records, {
      ...rivetOpts(extra?.sessionKey),
      ...extra,
      format: parsed.format,
      startPosition: parsed.header?.a ?? 0,
      agentId: extra?.agentId ?? parsed.header?.id ?? RIVET_ID,
    }),
  }
}

describe('timestamps', () => {
  it('parses UTC-4 into absolute ISO UTC', () => {
    expect(parseGrokTimestamp('Sunday, Sep 27, 2026, 4:06 PM (UTC-4)')).toBe(
      '2026-09-27T20:06:00.000Z',
    )
  })

  it('parses UTC+5:30 into absolute ISO UTC', () => {
    expect(parseGrokTimestamp('Monday, Jan 5, 2026, 9:30 AM (UTC+5:30)')).toBe(
      '2026-01-05T04:00:00.000Z',
    )
  })

  it('spaces rows after the last stamp at 1s and records time_source', () => {
    const records = [
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\n[t1u]\nhello\n</user_query>',
            },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { role: 'tool', message: { content: [{ type: 'tool_result', name: 'x', result: 'ok' }] } },
      {
        role: 'user',
        message: { content: [{ type: 'text', text: '[t2u]\nlater turn, no stamp' }] },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'after unstamped user' }] } },
    ]
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages[0].created_at).toBe('2026-09-27T20:06:00.000Z')
    expect(messages[0].metadata?.time_source).toBe('tag')
    expect(messages[1].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 1_000))
    expect(messages[1].metadata?.time_source).toBe('inherited')
    expect(messages[2].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 2_000))
    expect(messages[3].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 3_000))
    expect(messages[4].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 4_000))
    expect(messages.every((m) => Boolean(m.created_at))).toBe(true)
    const times = messages.map((m) => Date.parse(m.created_at ?? ''))
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true)
  })

  it('does not parse <timestamp> quoted inside assistant or tool text', () => {
    const records = [
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'earlier you said <timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>',
            },
          ],
        },
      },
      {
        role: 'tool',
        message: {
          content: [
            {
              type: 'tool_result',
              name: 'x',
              result: '<timestamp>Monday, Jan 5, 2026, 9:30 AM (UTC+5:30)</timestamp>',
            },
          ],
        },
      },
      { role: 'user', message: { content: [{ type: 'text', text: 'plain' }] } },
    ]
    const { messages } = normalizeRecords(records, {
      ...rivetOpts(),
      fileMtimeMs: Date.parse('2026-09-01T12:00:00.000Z'),
    })
    expect(messages.every((m) => Boolean(m.created_at))).toBe(true)
    expect(messages.some((m) => m.created_at === '2026-09-27T20:06:00.000Z')).toBe(false)
    expect(messages.some((m) => m.created_at === '2026-01-05T04:00:00.000Z')).toBe(false)
  })

  it('assistant/tool inherit only from the immediately preceding stamped user', () => {
    const records = [
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nfirst\n</user_query>',
            },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'a1' }] } },
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:07 PM (UTC-4)</timestamp>\n<user_query>\nsecond\n</user_query>',
            },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'a2' }] } },
    ]
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages[0].created_at).toBe('2026-09-27T20:06:00.000Z')
    expect(messages[1].created_at).toBe('2026-09-27T20:06:30.000Z')
    expect(messages[1].metadata?.time_source).toBe('interpolated')
    expect(messages[2].created_at).toBe('2026-09-27T20:07:00.000Z')
    expect(messages[3].created_at).toBe(addMs('2026-09-27T20:07:00.000Z', 1_000))
    expect(messages[3].metadata?.time_source).toBe('inherited')
  })

  it('keeps genuine same-minute user repeats at different positions', () => {
    const stamp =
      '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nyes\n</user_query>'
    const rec = {
      role: 'user',
      message: { content: [{ type: 'text', text: stamp }] },
    }
    const after = {
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }] },
    }
    const later = {
      role: 'user',
      message: { content: [{ type: 'text', text: stamp }] },
    }
    const { messages } = normalizeRecords([rec, after, later], rivetOpts())
    const users = messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users[0].content).toBe('yes')
    expect(users[1].content).toBe('yes')
    expect(users[0].metadata?.position).toBe(0)
    expect(users[1].metadata?.position).toBe(2)
    expect(users[1].created_at).toBe(addMs(users[0].created_at ?? '', INHERIT_STEP_MS + 1))
  })

  it('clamps created_at to max(stamp, lastEmitted+1ms)', () => {
    const stamp =
      '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nfirst\n</user_query>'
    const records = [
      { role: 'user', message: { content: [{ type: 'text', text: stamp }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nsecond\n</user_query>',
            },
          ],
        },
      },
    ]
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages[0].created_at).toBe('2026-09-27T20:06:00.000Z')
    expect(messages[1].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', INHERIT_STEP_MS))
    expect(messages[1].metadata?.time_source).toBe('inherited')
    expect(messages[2].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', INHERIT_STEP_MS + 1))
    const clock = { last: '2026-09-27T20:06:00.000Z' }
    expect(clampCreatedAt(clock, '2026-09-27T20:06:00.000Z')).toBe(
      addMs('2026-09-27T20:06:00.000Z', 1),
    )
  })

  it('records original time when clamp moves a stamp by more than 1s', () => {
    const records = [
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nfirst\n</user_query>',
            },
          ],
        },
      },
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 3:38 PM (UTC-4)</timestamp>\n<user_query>\nbackwards\n</user_query>',
            },
          ],
        },
      },
    ]
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages[0].created_at).toBe('2026-09-27T20:06:00.000Z')
    expect(Date.parse(messages[1].created_at ?? '')).toBeGreaterThan(
      Date.parse(messages[0].created_at ?? ''),
    )
    expect(messages[1].metadata?.created_at_original).toBe('2026-09-27T19:38:00.000Z')
    expect(messages[1].metadata?.created_at_adjusted_ms).toBeGreaterThan(1_000)
  })

  it('ignores result.timestamp / part.timestamp and free-form date strings', () => {
    const records = [
      {
        role: 'tool',
        message: {
          content: [
            {
              type: 'tool_result',
              name: 'x',
              result: { timestamp: 'Monday, Jan 5, 2026, 9:30 AM (UTC+5:30)', note: 'not a stamp' },
              timestamp: '2020-01-01T00:00:00.000Z',
            },
          ],
        },
      },
    ]
    const { messages } = normalizeRecords(records, {
      ...rivetOpts(),
      fileMtimeMs: Date.parse('2026-09-01T12:00:00.000Z'),
    })
    expect(messages[0].created_at).not.toBe('2026-01-05T04:00:00.000Z')
    expect(messages[0].created_at).not.toBe('2020-01-01T00:00:00.000Z')
    expect(messages[0].metadata?.time_source).toBe('mtime')
    expect(parseKnownTime('not a date at all')).toBeUndefined()
    expect(parseKnownTime('2026-09-27T20:06:00.000Z')).toBe('2026-09-27T20:06:00.000Z')
  })

  it('drops a replayed block of two or more identical consecutive records', () => {
    const user = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nhello\n</user_query>',
          },
        ],
      },
    }
    const asst = { role: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }
    const records = [user, asst, user, asst]
    expect([...replaySkipIndices(records)].sort()).toEqual([2, 3])
    const { messages, stats } = normalizeRecords(records, rivetOpts())
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(stats.dropped).toBe(2)
  })

  it('keeps repeated identical tool_use and tool_result pairs (polling gh pr checks)', () => {
    const toolUse = {
      role: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'shell', input: { command: 'gh pr checks' } }],
      },
    }
    const toolRes = {
      role: 'tool',
      message: {
        content: [{ type: 'tool_result', name: 'shell', result: 'pending\n' }],
      },
    }
    const records = [toolUse, toolRes, toolUse, toolRes]
    expect(replaySkipIndices(records).size).toBe(0)
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('keeps an unstamped routine fire followed by an identical first tool call', () => {
    const routine = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '[SAND_HIDDEN_PROMPT][routine] "poll checks" (folder x) is due\nThis is your own standing order firing on schedule.',
          },
        ],
      },
    }
    const tool = {
      role: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'shell', input: { command: 'gh pr checks' } }],
      },
    }
    const records = [routine, tool, routine, tool]
    expect(replaySkipIndices(records).size).toBe(0)
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages.filter((m) => m.metadata?.kind === 'routine')).toHaveLength(2)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
  })

  it('drops a third 12-row identical created_at copy after skipped-run rows stay in byHash', () => {
    const rec = (n: number) => ({
      role: 'assistant',
      created_at: '2026-09-20T20:04:00.000Z',
      message: { content: [{ type: 'text', text: `block-${String(n)}` }] },
    })
    const first = Array.from({ length: 12 }, (_, i) => rec(i))
    const records = [...first, ...first.map((r) => ({ ...r })), ...first.map((r) => ({ ...r }))]
    const skips = replaySkipIndices(records)
    expect(skips.size).toBe(24)
    for (let i = 0; i < 12; i++) expect(skips.has(i)).toBe(false)
    for (let i = 12; i < 36; i++) expect(skips.has(i)).toBe(true)
  })

  it('drops later 10+ copies of one often-repeated hash and created_at without O(k²) candidates', () => {
    const rec = {
      role: 'assistant',
      created_at: '2026-09-20T20:04:00.000Z',
      message: { content: [{ type: 'text', text: 'same' }] },
    }
    const many = Array.from({ length: 40 }, () => ({ ...rec }))
    const pollA = {
      role: 'assistant',
      created_at: '2026-09-20T20:05:00.000Z',
      message: {
        content: [{ type: 'tool_use', name: 'shell', input: { command: 'gh pr checks' } }],
      },
    }
    const pollB = {
      role: 'tool',
      created_at: '2026-09-20T20:05:00.000Z',
      message: { content: [{ type: 'tool_result', name: 'shell', result: 'pending\n' }] },
    }
    const records = [...many, pollA, pollB, pollA, pollB]
    const skips = replaySkipIndices(records)
    expect(skips.size).toBeGreaterThanOrEqual(10)
    for (let i = 0; i < 10; i++) expect(skips.has(i)).toBe(false)
    expect(skips.has(10)).toBe(true)
    expect(skips.has(40)).toBe(false)
    expect(skips.has(41)).toBe(false)
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('drops a 10+ identical created_at run and keeps a short polling pair', () => {
    const rec = (n: number) => ({
      role: 'assistant',
      created_at: '2026-09-20T20:04:00.000Z',
      message: { content: [{ type: 'text', text: `block-${String(n)}` }] },
    })
    const first = Array.from({ length: 12 }, (_, i) => rec(i))
    const replay = first.map((r) => ({ ...r }))
    const pollA = {
      role: 'assistant',
      created_at: '2026-09-20T20:05:00.000Z',
      message: {
        content: [{ type: 'tool_use', name: 'shell', input: { command: 'gh pr checks' } }],
      },
    }
    const pollB = {
      role: 'tool',
      created_at: '2026-09-20T20:05:00.000Z',
      message: { content: [{ type: 'tool_result', name: 'shell', result: 'pending\n' }] },
    }
    const records = [...first, ...replay, pollA, pollB, pollA, pollB]
    const skips = replaySkipIndices(records)
    expect(skips.size).toBe(12)
    for (let i = 12; i < 24; i++) expect(skips.has(i)).toBe(true)
    expect(skips.has(24)).toBe(false)
    expect(skips.has(25)).toBe(false)
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(
      messages.filter((m) => m.role === 'assistant' && m.content.startsWith('block-')),
    ).toHaveLength(12)
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('drops the first-run fixture replay at positions 204/225', () => {
    const records = readFix('ondisk-rivet-first-run-0-240.jsonl')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown)
    const skips = replaySkipIndices(records)
    expect(skips.has(204)).toBe(false)
    expect(skips.has(225)).toBe(true)
    const { messages } = normalizeRecords(records, rivetOpts())
    const asked = messages.filter(
      (m) => m.role === 'user' && /did you address all the further reviews/i.test(m.content),
    )
    expect(asked).toHaveLength(1)
    expect(asked[0].metadata?.position).toBe(204)
  })

  it('reads send_message epoch stamps when a page has no <timestamp> tags', () => {
    const text = readFix('page-rivet-this-conversation-3040-3056.txt')
    const parsed = parseInput(text)
    const result = normalizeRecords(parsed.records, {
      ...rivetOpts(),
      format: parsed.format,
      startPosition: parsed.header?.a ?? 0,
    })
    expect(result.timeKnown).toBe(true)
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages.every((m) => Boolean(m.created_at))).toBe(true)
    const times = result.messages.map((m) => Date.parse(m.created_at ?? ''))
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true)
    expect(result.messages.some((m) => m.created_at === parseEpochMs('1787358088946'))).toBe(true)
  })

  it('ties event_id to ordinal so a later 0-200 run does not drop 0-99 repeats', () => {
    const stamp = (text: string) =>
      `<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\n${text}\n</user_query>`
    const rec = (text: string) => ({
      role: 'user',
      message: { content: [{ type: 'text', text: stamp(text) }] },
    })
    const records = Array.from({ length: 201 }, (_, i) =>
      rec(i === 5 || i === 150 ? 'ok' : `msg-${String(i)}`),
    )
    const opts = { sessionKey: 'grokbot-rivet-grokbot-v3', agent: 'rivet-grokbot' }
    const mid = normalizeRecords(records.slice(100), { ...opts, startPosition: 100 })
    const full = normalizeRecords(records, { ...opts, startPosition: 0 })

    const midByPos = new Map(mid.messages.map((m) => [m.metadata?.position, m]))
    const fullByPos = new Map(full.messages.map((m) => [m.metadata?.position, m]))
    for (const [pos, msg] of midByPos) {
      expect(fullByPos.get(pos)?.event_id, `pos ${String(pos)}`).toBe(msg.event_id)
    }
    expect(fullByPos.get(5)?.content).toBe('ok')
    expect(fullByPos.get(150)?.content).toBe('ok')
    expect(fullByPos.get(5)?.event_id).not.toBe(fullByPos.get(150)?.event_id)

    const pos5 = fullByPos.get(5)!
    expect(pos5.event_id).toBe(
      eventIdFromContent({
        sessionKey: opts.sessionKey,
        role: 'user',
        content: 'ok',
        occurrence: pos5.metadata?.ordinal as number,
      }),
    )

    const seenIds = new Set(mid.messages.map((m) => m.event_id))
    const seenOrdinals = new Set(mid.messages.map((m) => m.metadata?.ordinal))
    const ingested: number[] = []
    const skipped: number[] = []
    for (const m of full.messages) {
      const pos = m.metadata?.position as number
      if (seenIds.has(m.event_id) || seenOrdinals.has(m.metadata?.ordinal)) skipped.push(pos)
      else ingested.push(pos)
    }
    expect(ingested).toContain(5)
    expect(ingested.every((p) => p < 100)).toBe(true)
    expect(skipped.every((p) => p >= 100)).toBe(true)
    expect(ingested).toHaveLength(100)
    expect(skipped).toHaveLength(full.messages.length - 100)
    expect(new Set(full.messages.map((m) => m.event_id)).size).toBe(full.messages.length)
  })
})

describe('wrappers', () => {
  it('strips every documented wrapper type and keeps [Image]', () => {
    const raw = readFix('synthetic-wrappers.jsonl').split('\n')[0]
    const rec = JSON.parse(raw) as { message: { content: Array<{ text: string }> } }
    const text = rec.message.content[0].text
    const cleaned = extractUserText(text)
    expect(cleaned).toContain('look at this')
    expect(cleaned).toContain('[Image]')
    expect(cleaned).not.toMatch(
      /<timestamp>|user_query|SAND_|system_reminder|automation_status|t152u|Sent from machine|memory_context|user_info|agent_skills|dynamic_tool_catalog|mcp_server_catalog|instructions_update|attached_files/,
    )
    const leftover = countNoise(cleaned)
    expect(leftover.timestamp).toBe(0)
    expect(leftover.user_query).toBe(0)
    expect(leftover.SAND_HIDDEN_PROMPT).toBe(0)
    expect(leftover.address_tag).toBe(0)
    expect(leftover.image).toBe(1)
  })

  it('keeps a normal user message that mentions [event] or [routine]', () => {
    for (const tag of ['[event]', '[routine]'] as const) {
      const rec = {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: `<user_query>\nthe ${tag} tag should stay in this note\n</user_query>`,
            },
          ],
        },
      }
      const { messages } = normalizeRecords([rec], rivetOpts())
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('user')
      expect(messages[0].content).toContain(tag)
      expect(messages[0].content).toContain('should stay')
    }
  })

  it('keeps every hidden tag quoted in a normal user message as a user row', () => {
    const tags = [
      '[agent]',
      '[first run]',
      'treat it as skipped',
      '[The user reacted',
      '<instructions_update>',
      '[event]',
      '[routine]',
      '[A background task just completed]',
      'A background task you started has finished',
      'Earlier you prompted the user and they moved on without responding',
      '<agent_profile_update>',
      '<<SAND_AGENT_PROFILE_UPDATE',
    ]
    for (const tag of tags) {
      const rec = {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: `<user_query>\nplease keep the ${tag} phrase in this note\n</user_query>`,
            },
          ],
        },
      }
      const { messages } = normalizeRecords([rec], rivetOpts())
      expect(messages, tag).toHaveLength(1)
      expect(messages[0].role, tag).toBe('user')
      expect(messages[0].content, tag).toContain(tag)
      expect(messages[0].content, tag).toContain('please keep')
    }
  })

  it('strips wrappers on the first-run Rivet sample', () => {
    const { result } = normalizeFile('ondisk-rivet-first-run-0-240.jsonl')
    const blob = result.messages.map((m) => m.content).join('\n')
    expect(blob).not.toMatch(
      /<timestamp>|<user_query>|\[SAND_HIDDEN_PROMPT\]|<<SAND_AGENT_PROFILE_UPDATE|<agent_profile_update>/,
    )
    expect(blob).not.toMatch(/\[t\d+u\]/)
  })
})

describe('hidden turns', () => {
  it('stores first-run, profile, routine, skipped, background as system — not user', () => {
    const { result } = normalizeFile('ondisk-rivet-first-run-0-240.jsonl')
    const users = result.messages.filter((m) => m.role === 'user')
    const systems = result.messages.filter((m) => m.role === 'system')
    expect(
      users.every(
        (m) => !/\[first run\]|treat it as skipped|\[routine\]|\[A background task/.test(m.content),
      ),
    ).toBe(true)
    expect(systems.some((m) => m.metadata?.kind === 'first_run')).toBe(true)
    expect(systems.some((m) => m.metadata?.kind === 'profile_update')).toBe(true)
    expect(systems.some((m) => m.metadata?.kind === 'background_task')).toBe(true)
    expect(systems.some((m) => m.metadata?.kind === 'skipped_prompt')).toBe(true)
    expect(result.stats.systemEvents).toBeGreaterThan(0)
  })

  it('keeps [agent] payload as a system event with from_agent / from_agent_id', () => {
    const { result } = normalizeFile('ondisk-rivet-agent-msgs-1880-1920.jsonl')
    const agents = result.messages.filter((m) => m.metadata?.kind === 'agent_message')
    expect(agents.length).toBeGreaterThan(0)
    expect(agents[0].role).toBe('system')
    expect(agents[0].content).toMatch(/Told Philip|Cleanup done|Rivet Team removal/)
    expect(agents[0].content).not.toMatch(/A message just arrived from another/)
    expect(agents[0].metadata?.from_agent).toMatch(/Gary|Bob/)
    expect(String(agents[0].metadata?.from_agent_id)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('mixed real text + hidden block keeps only the real text as the user turn', () => {
    const { result } = normalizeFile('ondisk-rivet-first-run-0-240.jsonl')
    const users = result.messages.filter((m) => m.role === 'user')
    const desc = users.find((m) => /good grok bot description/i.test(m.content))
    expect(desc).toBeTruthy()
    expect(desc?.content).not.toMatch(/SAND_AGENT_PROFILE_UPDATE|agent_profile_update/)
  })

  it('keeps repeated routine fires distinct by position', () => {
    const rec = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<timestamp>Thursday, Aug 20, 2026, 11:46 PM (UTC-4)</timestamp>\n<user_query>\n[SAND_TRUSTED_AUTOMATION_PROMPT]\n[routine] "Same job" (folder x) is due\n</user_query>',
          },
        ],
      },
    }
    const { messages } = normalizeRecords([rec, rec], rivetOpts())
    const routines = messages.filter((m) => m.metadata?.kind === 'routine')
    expect(routines).toHaveLength(2)
    expect(routines[0].metadata?.position).toBe(0)
    expect(routines[1].metadata?.position).toBe(1)
    expect(routines[0].metadata?.ordinal).toBe(0 * ORDINAL_STRIDE)
    expect(routines[1].metadata?.ordinal).toBe(1 * ORDINAL_STRIDE)
  })

  it('stores role=system records as system, not assistant', () => {
    const rec = {
      role: 'system',
      message: { content: [{ type: 'text', text: 'sys note' }] },
    }
    const { messages } = normalizeRecords([rec], rivetOpts())
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBe('sys note')
  })

  it('throws when per-position sub-index reaches ORDINAL_STRIDE', () => {
    const parts = Array.from({ length: ORDINAL_STRIDE + 1 }, (_, i) => ({
      type: 'tool_use',
      name: `t${String(i)}`,
      input: {},
    }))
    const rec = { role: 'assistant', message: { content: parts } }
    expect(() => normalizeRecords([rec], rivetOpts())).toThrow(/ordinal sub-index/)
  })

  it('classifies reactions and events', () => {
    expect(classifyHidden('[The user reacted ❤️ to your message]')).toBe('reaction')
    expect(classifyHidden('[event] Something about this conversation just changed.')).toBe('event')
    const sandReaction = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '[SAND_HIDDEN_PROMPT][The user reacted +1 to your message]',
          },
        ],
      },
    }
    const sandEvent = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '[SAND_HIDDEN_PROMPT][event] Something about this conversation just changed.',
          },
        ],
      },
    }
    const { messages } = normalizeRecords([sandReaction, sandEvent], rivetOpts())
    expect(messages.some((m) => m.metadata?.kind === 'reaction')).toBe(true)
    expect(messages.some((m) => m.metadata?.kind === 'event')).toBe(true)
    const unmarked = normalizeFile('synthetic-wrappers.jsonl')
    expect(unmarked.result.messages.some((m) => m.metadata?.kind === 'reaction')).toBe(false)
    expect(
      unmarked.result.messages.some(
        (m) => m.role === 'user' && /\[The user reacted/.test(m.content),
      ),
    ).toBe(true)
  })
})

describe('per-bot tags', () => {
  it('keeps the historical Rivet session/agent tags unchanged', () => {
    const ident = identityFor(RIVET_ID)
    expect(ident.session).toBe('grokbot-rivet-grokbot')
    expect(ident.agent).toBe('rivet-grokbot')
    expect(loadIdentityConfig().overrides[RIVET_ID]?.session).toBe('grokbot-rivet-grokbot')
  })

  it('keeps the historical eggbot tags', () => {
    const ident = identityFor(EGG_ID)
    expect(ident.session).toBe('grokbot-eggbot')
    expect(ident.agent).toBe('rivet-eggbot')
  })

  it('discovers roster bots, skips group.json and excludeNames', () => {
    const catalog = discoverModels({
      agentsDir: join(FIX, 'agents'),
      modelsPath: join(dirname(FIX), '..', 'models.json'),
    })
    const ids = catalog.models.map((m) => m.id)
    expect(ids).toContain(RIVET_ID)
    expect(ids).toContain(BOB_ID)
    expect(ids).toContain(EGG_ID)
    expect(ids).toContain('cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa')
    expect(catalog.models.find((m) => m.id === 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa')?.agent).toBe(
      'rivet-arch',
    )
    expect(ids).not.toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(ids).not.toContain('11111111-2222-4333-8444-555555555555')
    expect(catalog.models.find((m) => m.id === RIVET_ID)?.session).toBe('grokbot-rivet-grokbot')
    expect(ids).toContain(GARY_ID)
    expect(catalog.models.find((m) => m.id === GARY_ID)?.agent).toBe('rivet-gary')
  })

  it('reports unmapped <uuid>/<uuid>.jsonl transcripts instead of dropping them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-unmapped-'))
    const orphan = 'eb245c0c-0000-4000-8000-000000000001'
    mkdirSync(join(dir, orphan), { recursive: true })
    writeFileSync(join(dir, orphan, `${orphan}.jsonl`), '{}\n')
    const catalog = discoverModels({
      agentsDir: join(FIX, 'agents'),
      modelsPath: join(dirname(FIX), '..', 'models.json'),
      transcriptsDir: dir,
    })
    expect(catalog.unmappedTranscripts).toContain(orphan)
    expect(catalog.models.map((m) => m.id)).not.toContain(orphan)
  })

  it('tags subagents as rivet-grokbot-run / grokbot-run-<id>', () => {
    const id = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
    const ident = identityFor(id, { agentsDir: join(FIX, 'agents') })
    expect(ident.agent).toBe('rivet-grokbot-run')
    expect(ident.session).toBe(`grokbot-run-${id}`)
  })

  it('consults the roster before the subagent fallback (un-overridden Arch)', () => {
    const id = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'
    const ident = identityFor(id, {
      agentsDir: join(FIX, 'agents'),
      modelsPath: join(dirname(FIX), '..', 'models.json'),
    })
    expect(ident.persona).toBe('Arch')
    expect(ident.session).toBe('grokbot-arch')
    expect(ident.agent).toBe('rivet-arch')
  })

  it('refuses unidentified backfill files without --agent-id, header, or uuid/uuid.jsonl', () => {
    expect(resolveSourceAgentId({ file: '/tmp/orphan.jsonl' })).toBeUndefined()
    expect(resolveSourceAgentId({ file: '/tmp/page.txt' })).toBeUndefined()
    expect(resolveSourceAgentId({ file: `/tmp/${BOB_ID}/${BOB_ID}.jsonl` })).toBe(BOB_ID)
    expect(resolveSourceAgentId({ file: '/tmp/x.jsonl', headerId: BOB_ID })).toBe(BOB_ID)
    expect(resolveSourceAgentId({ file: '/tmp/x.jsonl', explicitId: BOB_ID })).toBe(BOB_ID)
  })

  it('reads on-disk agent id from <uuid>/<uuid>.jsonl', () => {
    expect(
      agentIdFromTranscriptPath(
        '/home/user/agent-data/agent-transcripts/00df02ea-4f5f-4d3e-945a-864e1c9c78dc/00df02ea-4f5f-4d3e-945a-864e1c9c78dc.jsonl',
      ),
    ).toBe(BOB_ID)
    expect(agentIdFromTranscriptPath('/tmp/page.txt')).toBeUndefined()
  })

  it('lists input files recursively so the agent-transcripts root works', () => {
    const root = join(FIX, 'agent-transcripts')
    const files = listInputFiles(root)
    expect(files.some((f) => f.endsWith(`${BOB_ID}/${BOB_ID}.jsonl`))).toBe(true)
  })

  it('puts the agent id on every message metadata', () => {
    const { result } = normalizeFile('ondisk-bob-0-16.jsonl', {
      sessionKey: 'grokbot-bob',
      agent: 'rivet-bob',
      agentId: BOB_ID,
    })
    expect(result.messages.every((m) => m.metadata?.agent_id === BOB_ID)).toBe(true)
  })

  it('slugs New Bot-style names', () => {
    expect(slug('dr eggbot')).toBe('dr-eggbot')
  })
})

describe('unstamped on-disk transcript + createdAt', () => {
  it('stamps every line on a bot with no inline <timestamp> tags and hidden turns', () => {
    const { result } = normalizeFile('ondisk-unstamped-hidden.jsonl', {
      sessionKey: 'grokbot-ollie-v4',
      agent: 'rivet-ollie',
    })
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages.every((m) => Boolean(m.created_at))).toBe(true)
    const times = result.messages.map((m) => Date.parse(m.created_at ?? ''))
    expect(times.every((t) => Number.isFinite(t))).toBe(true)
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true)
    expect(result.messages.some((m) => m.metadata?.kind === 'first_run')).toBe(true)
    expect(result.messages.some((m) => m.metadata?.kind === 'routine')).toBe(true)
    expect(result.messages.some((m) => m.created_at === parseEpochMs('1787270751113'))).toBe(true)
    expect(result.messages.map((m) => m.content).join('\n')).not.toMatch(/<timestamp>/)
  })

  it('falls back to file mtime + 1s steps, last row at mtime', () => {
    const mtime = Date.parse('2026-08-11T15:00:00.000Z')
    const records = [
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '[SAND_HIDDEN_PROMPT][first run] This is your very first turn.',
            },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: '[t0u]\nplain note' }] } },
    ]
    const { messages } = normalizeRecords(records, { ...rivetOpts(), fileMtimeMs: mtime })
    expect(messages.every((m) => Boolean(m.created_at))).toBe(true)
    const times = messages.map((m) => Date.parse(m.created_at ?? ''))
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true)
    expect(times[times.length - 1]).toBe(mtime)
    expect(times[1] - times[0]).toBe(INHERIT_STEP_MS)
    expect(times[2] - times[1]).toBe(INHERIT_STEP_MS)
    expect(messages.every((m) => m.metadata?.time_source === 'mtime')).toBe(true)
  })

  it('interpolates mtime-tier rows from file birthtime to mtime', () => {
    const mtime = Date.parse('2026-08-11T15:00:00.000Z')
    const birth = mtime - 60_000
    const records = [
      { role: 'user', message: { content: [{ type: 'text', text: '[t0u]\none' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: '[t1u]\nthree' }] } },
    ]
    const { messages } = normalizeRecords(records, {
      ...rivetOpts(),
      fileMtimeMs: mtime,
      fileBirthtimeMs: birth,
    })
    const times = messages.map((m) => Date.parse(m.created_at ?? ''))
    expect(times[0]).toBe(birth)
    expect(times[1]).toBe(birth + 30_000)
    expect(times[2]).toBe(mtime)
    expect(messages.every((m) => m.metadata?.time_source === 'mtime')).toBe(true)
  })

  it('uses 1s mtime steps when birth is only 4 ms earlier (copied sand-subagent)', () => {
    const mtime = Date.parse('2026-08-11T15:00:00.000Z')
    const records = [
      { role: 'user', message: { content: [{ type: 'text', text: '[t0u]\none' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: '[t1u]\nthree' }] } },
    ]
    const { messages } = normalizeRecords(records, {
      ...rivetOpts(),
      fileMtimeMs: mtime,
      fileBirthtimeMs: mtime - 4,
    })
    const times = messages.map((m) => Date.parse(m.created_at ?? ''))
    expect(times[times.length - 1]).toBe(mtime)
    expect(times[1] - times[0]).toBe(INHERIT_STEP_MS)
    expect(times[2] - times[1]).toBe(INHERIT_STEP_MS)
    expect(messages.every((m) => m.metadata?.time_source === 'mtime')).toBe(true)
  })

  it('inherits from a parent session stamp when lastKnownTime is set', () => {
    const parent = '2026-08-11T14:00:00.000Z'
    const mtime = Date.parse('2026-08-11T15:00:00.000Z')
    const records = [
      { role: 'user', message: { content: [{ type: 'text', text: '[t0u]\nsubagent start' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]
    const { messages } = normalizeRecords(records, {
      ...rivetOpts(),
      fileMtimeMs: mtime,
      lastKnownTime: parent,
    })
    expect(messages[0].created_at).toBe(addMs(parent, INHERIT_STEP_MS))
    expect(messages[0].metadata?.time_source).toBe('inherited')
    expect(messages[1].created_at).toBe(addMs(parent, 2 * INHERIT_STEP_MS))
    expect(messages[1].metadata?.time_source).toBe('inherited')
  })

  it('skips parent seeding when only parentId is known (not the last stamp)', () => {
    const parentId = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111'
    const childId = 'bbbbbbbb-cccc-4ddd-8eee-222222222222'
    const root = mkdtempSync(join(tmpdir(), 'gb-parent-skip-'))
    mkdirSync(join(root, parentId), { recursive: true })
    mkdirSync(join(root, 'agents', childId), { recursive: true })
    writeFileSync(
      join(root, parentId, `${parentId}.jsonl`),
      `${JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nparent\n</user_query>',
            },
          ],
        },
      })}\n`,
    )
    writeFileSync(join(root, 'agents', childId, 'profile.json'), JSON.stringify({ parentId }))
    const childPath = join(root, childId, `${childId}.jsonl`)
    mkdirSync(join(root, childId), { recursive: true })
    writeFileSync(childPath, '{}\n')
    expect(
      peekParentLastKnownTime({
        sourcePath: childPath,
        agentsDir: join(root, 'agents'),
        transcriptsDir: root,
      }),
    ).toBeUndefined()
  })

  it('peeks the parent stamp nearest the child spawn mention, not the last stamp', () => {
    const parentId = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111'
    const childId = 'bbbbbbbb-cccc-4ddd-8eee-222222222222'
    const root = mkdtempSync(join(tmpdir(), 'gb-parent-near-'))
    mkdirSync(join(root, parentId), { recursive: true })
    mkdirSync(join(root, 'agents', childId), { recursive: true })
    const early = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: `<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nspawn ${childId}\n</user_query>`,
          },
        ],
      },
    }
    const late = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<timestamp>Sunday, Sep 27, 2026, 5:06 PM (UTC-4)</timestamp>\n<user_query>\nlater parent turn\n</user_query>',
          },
        ],
      },
    }
    writeFileSync(
      join(root, parentId, `${parentId}.jsonl`),
      `${JSON.stringify(early)}\n${JSON.stringify(late)}\n`,
    )
    writeFileSync(join(root, 'agents', childId, 'profile.json'), JSON.stringify({ parentId }))
    const childPath = join(root, childId, `${childId}.jsonl`)
    mkdirSync(join(root, childId), { recursive: true })
    writeFileSync(childPath, '{}\n')
    expect(
      peekParentLastKnownTime({
        sourcePath: childPath,
        agentsDir: join(root, 'agents'),
        transcriptsDir: root,
      }),
    ).toBe('2026-09-27T20:06:00.000Z')
  })

  it('uses profile createdAt to pick the nearest parent stamp', () => {
    const parentId = 'aaaaaaaa-bbbb-4ccc-8ddd-333333333333'
    const childId = 'bbbbbbbb-cccc-4ddd-8eee-444444444444'
    const root = mkdtempSync(join(tmpdir(), 'gb-parent-created-'))
    mkdirSync(join(root, parentId), { recursive: true })
    mkdirSync(join(root, 'agents', childId), { recursive: true })
    writeFileSync(
      join(root, parentId, `${parentId}.jsonl`),
      `${JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nearly\n</user_query>',
            },
          ],
        },
      })}\n${JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 5:06 PM (UTC-4)</timestamp>\n<user_query>\nlate\n</user_query>',
            },
          ],
        },
      })}\n`,
    )
    writeFileSync(
      join(root, 'agents', childId, 'profile.json'),
      JSON.stringify({ parentId, createdAt: '2026-09-27T20:06:20.000Z' }),
    )
    const childPath = join(root, childId, `${childId}.jsonl`)
    mkdirSync(join(root, childId), { recursive: true })
    writeFileSync(childPath, '{}\n')
    expect(
      peekParentLastKnownTime({
        sourcePath: childPath,
        agentsDir: join(root, 'agents'),
        transcriptsDir: root,
      }),
    ).toBe('2026-09-27T20:06:00.000Z')
  })

  it('steps INHERIT_STEP_MS when the later stamp is earlier than the earlier stamp', () => {
    const earlier = { time: '2026-09-27T20:07:00.000Z', position: 0 }
    const later = { time: '2026-09-27T20:06:00.000Z', position: 2 }
    const mid = deriveCreatedAt({
      position: 1,
      earlier,
      later,
      maxPosition: 2,
    })
    expect(mid.source).toBe('inherited')
    expect(mid.time).toBe(addMs(earlier.time, INHERIT_STEP_MS))
    const records = [
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:07 PM (UTC-4)</timestamp>\n<user_query>\nfirst\n</user_query>',
            },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'mid' }] } },
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nback\n</user_query>',
            },
          ],
        },
      },
    ]
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages[1].created_at).toBe(addMs('2026-09-27T20:07:00.000Z', INHERIT_STEP_MS))
    expect(messages[1].metadata?.time_source).toBe('inherited')
  })

  it('resets clamp adjustment state when the next candidate is empty', () => {
    const clock = { last: '2026-09-27T20:06:00.000Z' }
    expect(clampCreatedAt(clock, '2026-09-27T19:00:00.000Z')).toBe(
      addMs('2026-09-27T20:06:00.000Z', 1),
    )
    expect(clock.lastOriginal).toBe('2026-09-27T19:00:00.000Z')
    expect(clock.lastAdjustmentMs).toBeGreaterThan(1_000)
    expect(clampCreatedAt(clock, undefined)).toBeUndefined()
    expect(clock.lastOriginal).toBeUndefined()
    expect(clock.lastAdjustmentMs).toBe(0)
  })

  it('strips -v4 store/voice/rows suffixes the same way as -v3', () => {
    expect(stripSessionSuffix('grokbot-ollie-v4')).toBe('grokbot-ollie')
    expect(stripSessionSuffix('grokbot-ollie-v4-store')).toBe('grokbot-ollie')
    expect(stripSessionSuffix('grokbot-ollie-v4-rows')).toBe('grokbot-ollie')
    expect(stripSessionSuffix('grokbot-ollie-v4-voice-call')).toBe('grokbot-ollie')
    expect(stripSessionSuffix('grokbot-rivet-grokbot-v3-voice-call-redacted')).toBe(
      'grokbot-rivet-grokbot',
    )
  })
})

describe('tool_result + capForStorage', () => {
  it('reads tool_result from result (old converter ignored it)', () => {
    const page = readFix('page-rivet-this-conversation-3040-3056.txt')
    const parsed = parseInput(page)
    const tool = parsed.records.find((r) => {
      const rec = r as { role?: string }
      return rec.role === 'tool'
    }) as { message: { content: unknown[] } }
    const body = toolResultBody(tool.message.content[0])
    expect(body.length).toBeGreaterThan(0)
    expect(body).toMatch(/success|spawnError|timestamp/)

    const legacy = legacyNormalizeRecords([tool], { page: false })
    expect(legacy[0]?.content ?? '').not.toMatch(/success|spawnError/)

    const after = normalizeRecords([tool], rivetOpts())
    expect(after.messages[0].role).toBe('tool')
    expect(after.messages[0].tool_result).toMatch(/success|spawnError|timestamp/)
  })

  it('keeps a 20_000-char tool_result without the legacy 4 KB chop or 16K recap', () => {
    const huge = 'x'.repeat(20_000)
    const rec = {
      role: 'tool',
      message: { content: [{ type: 'tool_result', name: 'shell', result: huge }] },
    }
    const { messages } = normalizeRecords([rec], rivetOpts())
    expect(messages[0].tool_result).toBe(huge)
    expect(messages[0].tool_result?.length).toBe(20_000)
    expect(messages[0].tool_result).not.toContain('…[truncated')
    expect(messages[0].metadata?.truncated).toBeUndefined()
    expect(LEGACY_TOOL_RESULT_MAX).toBe(4096)
    expect(capForStorage(huge).truncated).toBe(true)
    expect(STORAGE_LIMIT).toBe(16_000)
  })

  it('keeps a real oversized ReadTranscript shell result in full', () => {
    const { result } = normalizeFile('page-rivet-2395-2445.txt')
    const tools = result.messages.filter((m) => m.role === 'tool' && (m.tool_result?.length ?? 0) > 4_096)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((m) => m.metadata?.truncated !== true)).toBe(true)
    expect(tools.every((m) => !m.tool_result?.includes('…[truncated'))).toBe(true)
    expect(tools.some((m) => (m.tool_result?.length ?? 0) > STORAGE_LIMIT)).toBe(true)
  })

  it('stubs base64/data-URI images and caps huge tool results with a source pointer', () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const dataUri = `data:image/png;base64,${png}`
    const stubbed = stubImagePayloads(JSON.stringify({ image: dataUri, b64_json: png }))
    expect(stubbed.stubbed).toBe(true)
    expect(stubbed.text).toMatch(/\[image mime=image\/png bytes=\d+ sha256=[0-9a-f]{16}\]/)
    expect(stubbed.text).not.toContain(png)

    const huge = 'x'.repeat(CONTENT_LIMIT + 50)
    const src = join(FIX, 'ondisk-unstamped-hidden.jsonl')
    const { messages } = normalizeRecords(
      [
        {
          role: 'tool',
          message: {
            content: [{ type: 'tool_result', name: 'generate_image', result: dataUri }],
          },
        },
        {
          role: 'tool',
          message: { content: [{ type: 'tool_result', name: 'shell', result: huge }] },
        },
      ],
      { ...rivetOpts(), sourcePath: src, sourceLines: [0, 1] },
    )
    const img = messages[0]
    expect(img.metadata?.truncated).toBe(true)
    expect(img.metadata?.image_stubbed).toBe(true)
    expect(img.tool_result).toMatch(/\[image mime=image\/png/)
    expect(img.tool_result).not.toContain(png)
    expect(img.metadata?.session_jsonl_path).toBe(src)
    expect(img.metadata?.session_jsonl_line).toBe(0)
    expect(typeof img.metadata?.full_tool_result_length).toBe('number')

    const shell = messages[1]
    expect(shell.tool_result?.length).toBe(CONTENT_LIMIT)
    expect(shell.metadata?.truncated).toBe(true)
    expect(shell.metadata?.full_tool_result_length).toBe(CONTENT_LIMIT + 50)
    expect(shell.metadata?.session_jsonl_path).toBe(src)
    expect(shell.metadata?.session_jsonl_line).toBe(1)
    expect(CONTENT_LIMIT).toBe(262_144)
  })
})

describe('both input formats', () => {
  it('parses on-disk jsonl (no header)', () => {
    const parsed = parseInput(readFix('ondisk-bob-0-16.jsonl'))
    expect(parsed.format).toBe('ondisk')
    expect(parsed.records.length).toBe(17)
    expect(parsed.header).toBeUndefined()
  })

  it('parses a named-agent page with footer', () => {
    const parsed = parseInput(readFix('page-rivet-2395-2445.txt'))
    expect(parsed.format).toBe('page')
    expect(parsed.header?.name).toBe('Rivet')
    expect(parsed.header?.id).toBe(RIVET_ID)
    expect(parsed.header?.a).toBe(2395)
    expect(parsed.hasOlderFooter).toBe(true)
  })

  it('parses the this-conversation header variant', () => {
    const parsed = parseInput(readFix('page-rivet-this-conversation-3040-3056.txt'))
    expect(parsed.header?.thisConversation).toBe(true)
    expect(parsed.header?.a).toBe(3040)
    expect(parsed.header?.b).toBe(3056)
    expect(parsePageHeader('Transcript of this conversation, positions 0–0 of 1:')).toMatchObject({
      thisConversation: true,
      a: 0,
    })
  })

  it('parses an A=0 page with no footer', () => {
    const parsed = parseInput(readFix('page-maggie-0-20.txt'))
    expect(parsed.header?.a).toBe(0)
    expect(parsed.header?.name).toBe('Maggie')
    expect(parsed.hasOlderFooter).toBe(false)
    expect(detectFormat(readFix('page-maggie-0-20.txt'))).toBe('page')
  })
})

describe('reclean', () => {
  it('writes under -v3 and never targets the original session', () => {
    expect(v3Session('grokbot-rivet-grokbot')).toBe('grokbot-rivet-grokbot-v3')
    expect(v3Session('grokbot-rivet-grokbot-v2')).toBe('grokbot-rivet-grokbot-v3')
    const result = recleanFromSource(readFix('ondisk-bob-0-16.jsonl'), {
      sessionKey: 'grokbot-bob',
      agent: 'rivet-bob',
      agentId: BOB_ID,
      dryRun: true,
    })
    expect(result.session).toBe('grokbot-bob-v3')
    expect(result.dryRun).toBe(true)
    expect(result.wrote).toBe(false)
  })

  it('follows GROKBOT_SESSION_SUFFIX and refuses already row-shaped sessions', () => {
    expect(v3Session('grokbot-bob', '-v4')).toBe('grokbot-bob-v4')
    expect(v3RowsSession('grokbot-bob', '-v4')).toBe('grokbot-bob-v4-rows')
    expect(isRowShapedSession('grokbot-bob-v3-rows')).toBe(true)
    expect(isRowShapedSession('grokbot-bob-v4')).toBe(false)
    const v4 = recleanFromSource(readFix('ondisk-bob-0-16.jsonl'), {
      sessionKey: 'grokbot-bob',
      agent: 'rivet-bob',
      sessionSuffix: '-v4',
      dryRun: true,
    })
    expect(v4.session).toBe('grokbot-bob-v4')
    expect(() =>
      recleanFromSource(readFix('ondisk-bob-0-16.jsonl'), {
        sessionKey: 'grokbot-bob-v3-rows',
        agent: 'rivet-bob',
        dryRun: true,
      }),
    ).toThrow(/row-shaped/)
    expect(() =>
      recleanStoredRows(
        [
          {
            role: 'user',
            content: 'already captured',
            metadata: { capture_source: 'grokbot-transcript', position: 0 },
          },
        ],
        { sessionKey: 'grokbot-bob-v3', agent: 'rivet-bob', dryRun: true },
      ),
    ).toThrow(/capture_source/)
  })

  it('dry-run reclean of stored rows does not write', () => {
    const result = recleanStoredRows(
      [
        {
          role: 'user',
          content:
            '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\n[t9u]\nkeep me\n</user_query>',
          ordinal: 0,
        },
      ],
      { sessionKey: 'grokbot-rivet-grokbot', agent: 'rivet-grokbot', dryRun: true },
    )
    expect(result.wrote).toBe(false)
    expect(result.ingest[0].content).toBe('keep me')
    expect(result.ingest[0].createdAt).toBe('2026-09-27T20:06:00.000Z')
  })

  it('uses stored created_at for a later unstamped user turn', () => {
    const result = recleanStoredRows(
      [
        {
          role: 'user',
          content:
            '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nfirst\n</user_query>',
          created_at: '2026-09-27T20:06:00.000Z',
          ordinal: 0,
        },
        {
          role: 'user',
          content: 'later unstamped',
          created_at: '2026-09-27T21:00:00.000Z',
          ordinal: 1,
        },
      ],
      { sessionKey: 'grokbot-rivet-grokbot', agent: 'rivet-grokbot', dryRun: true },
    )
    const users = result.messages.filter((m) => m.role === 'user')
    expect(users[0].created_at).toBe('2026-09-27T20:06:00.000Z')
    expect(users[1].created_at).toBe('2026-09-27T21:00:00.000Z')
  })

  it('uses each stored ordinal and parks NULL ordinals after the last known position', () => {
    const positions = assignRecleanPositions([
      { role: 'user', content: 'a', ordinal: 5 },
      { role: 'user', content: 'gap', ordinal: null },
      { role: 'assistant', content: 'b', ordinal: 40 },
    ])
    expect(positions).toEqual([5, 41, 40])
    const result = recleanStoredRows(
      [
        { role: 'user', content: 'keep', ordinal: 12 },
        { role: 'assistant', content: 'later', ordinal: 40 },
      ],
      { sessionKey: 'grokbot-bob', agent: 'rivet-bob', dryRun: true },
    )
    expect(result.messages[0].metadata?.position).toBe(12)
    expect(result.messages[1].metadata?.position).toBe(40)
  })

  it('does not force rivet-grokbot when reclean is given only --session', () => {
    const egg = resolveIdent(undefined, 'grokbot-eggbot', undefined)
    expect(egg.agent).toBe('rivet-eggbot')
    expect(egg.session).toBe('grokbot-eggbot')
    const unknown = resolveIdent(undefined, 'grokbot-not-a-real-session', undefined)
    expect(unknown.agent).toBeUndefined()
    expect(identityForSession('grokbot-rivet-grokbot-v3')?.agent).toBe('rivet-grokbot')
    expect(identityForSession('grokbot-rivet-grokbot-v3-rows')?.agent).toBe('rivet-grokbot')
    expect(identityForSession('grokbot-rivet-grokbot-v3-store')?.agent).toBe('rivet-grokbot')
    expect(identityForSession('grokbot-rivet-grokbot-v3-voice-call-redacted')?.agent).toBe(
      'rivet-grokbot',
    )
    expect(identityForSession('grokbot-rivet-grokbot-v4')?.agent).toBe('rivet-grokbot')
    expect(identityForSession('grokbot-rivet-grokbot-v4-store')?.agent).toBe('rivet-grokbot')
  })

  it('writes stored-row reclean under -v3-rows, not -v3', () => {
    expect(v3RowsSession('grokbot-rivet-grokbot')).toBe('grokbot-rivet-grokbot-v3-rows')
    expect(v3RowsSession('grokbot-rivet-grokbot-v3')).toBe('grokbot-rivet-grokbot-v3-rows')
    expect(v3RowsSession('grokbot-rivet-grokbot-v2')).toBe('grokbot-rivet-grokbot-v3-rows')
    const result = recleanStoredRows([{ role: 'user', content: 'keep', ordinal: 0 }], {
      sessionKey: 'grokbot-rivet-grokbot',
      agent: 'rivet-grokbot',
      dryRun: true,
    })
    expect(result.session).toBe('grokbot-rivet-grokbot-v3-rows')
  })

  it('keeps old-style sequential ordinals 0..2500 as positions without collapsing', () => {
    const rows = Array.from({ length: 2501 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `row-${String(i)}`,
      ordinal: i,
    }))
    const positions = assignRecleanPositions(rows)
    expect(positions).toEqual(Array.from({ length: 2501 }, (_, i) => i))
    expect(new Set(positions).size).toBe(2501)
    expect(Math.max(...positions)).toBe(2500)
    const result = recleanStoredRows(rows, {
      sessionKey: 'grokbot-rivet-grokbot',
      agent: 'rivet-grokbot',
      dryRun: true,
    })
    const outPos = result.messages.map((m) => m.metadata?.position as number)
    expect(outPos).toEqual(positions)
    expect(outPos).toEqual([...outPos].sort((a, b) => a - b))
    expect(new Set(outPos).size).toBe(2501)
    expect(result.session).toBe('grokbot-rivet-grokbot-v3-rows')
  })

  it('decodes new-style stride ordinals only when capture_source or position is present', () => {
    expect(storedRowPosition({ role: 'assistant', content: 'b', ordinal: 1880_000 })).toBe(1880_000)
    expect(
      storedRowPosition({
        role: 'assistant',
        content: 'b',
        ordinal: 1880_000,
        metadata: { capture_source: 'grokbot-transcript' },
      }),
    ).toBe(1880)
    expect(
      storedRowPosition({
        role: 'assistant',
        content: 'b',
        ordinal: 1880_000,
        metadata: { position: 1880 },
      }),
    ).toBe(1880)
  })

  it('reports time_known when a timestamp was seen even if inheritance stops', () => {
    const result = recleanStoredRows(
      [
        {
          role: 'user',
          content:
            '<timestamp>Sunday, Sep 27, 2026, 4:06 PM (UTC-4)</timestamp>\n<user_query>\nfirst\n</user_query>',
          created_at: '2026-09-27T20:06:00.000Z',
          ordinal: 0,
        },
        {
          role: 'user',
          content: 'later unstamped',
          created_at: '2026-09-27T21:00:00.000Z',
          ordinal: 1,
        },
      ],
      { sessionKey: 'grokbot-rivet-grokbot', agent: 'rivet-grokbot', dryRun: true },
    )
    expect(result.stats.timeKnown).toBe(true)
    expect(result.ingest.every((r) => Boolean(r.createdAt))).toBe(true)
  })
})

describe('ingest mapping + compare', () => {
  it('maps CaptureMessage to ingest camelCase rows', () => {
    const { result } = normalizeFile('ondisk-bob-0-16.jsonl', {
      sessionKey: 'grokbot-bob',
      agent: 'rivet-bob',
      agentId: BOB_ID,
    })
    const rows = toIngestRows(result.messages)
    expect(rows.every((r) => r.role !== undefined)).toBe(true)
    expect(rows.every((r) => Boolean(r.createdAt))).toBe(true)
    expect(rows.some((r) => r.toolCalls && r.toolCalls.length > 0)).toBe(true)
    expect(rows.every((r) => r.metadata?.agent_id === BOB_ID)).toBe(true)
    expect(rows.every((r) => typeof r.metadata?.position === 'number')).toBe(true)
    expect(rows.every((r) => typeof r.ordinal === 'number')).toBe(true)
    expect(rows.every((r) => typeof r.event_id === 'string' && r.event_id.length > 0)).toBe(true)
    const tool = rows.find((r) => r.role === 'tool' && r.metadata?.truncated)
    if (tool) {
      expect(typeof tool.metadata?.full_tool_result_length).toBe('number')
      expect(typeof tool.toolResult).toBe('string')
      expect(tool.content).not.toBe(tool.toolResult)
    }
    expect(rows.some((r) => r.metadata?.capture_source === 'grokbot-transcript')).toBe(true)
  })

  it('before/after comparison shrinks noise and average length on real samples', () => {
    const cmp = compareInput(readFix('ondisk-rivet-first-run-0-240.jsonl'), rivetOpts())
    // After splits each tool_use onto its own CaptureMessage (capture-core shape),
    // so row count can rise; noise and mean content length must fall.
    expect(cmp.after.avgChars.all).toBeLessThan(cmp.before.avgChars.all)
    expect(cmp.after.avgChars.user).toBeLessThan(cmp.before.avgChars.user)
    expect(cmp.after.stats.user).toBeLessThan(cmp.before.rows)
    expect(cmp.systemEvents).toBeGreaterThan(0)
    expect(sumNoise(cmp.after.noise)).toBeLessThan(sumNoise(cmp.before.noise))
  })
})

describe('extractAgentMessage', () => {
  it('pulls the named body out of the boilerplate', () => {
    const got = extractAgentMessage(
      `[agent] A message just arrived from another of your user's agents: Gary (id: 71aebcf6-8b3b-4649-abe1-ad6d653e6156).
This is another assistant reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.

Gary: Told Philip. PRs clean.

If it needs a reply or an action, handle it: reply to Gary with SendToAgent`,
    )
    expect(got).toEqual({
      fromAgent: 'Gary',
      fromAgentId: '71aebcf6-8b3b-4649-abe1-ad6d653e6156',
      text: 'Told Philip. PRs clean.',
    })
  })
})

describe('stripWrappers leaves user prose', () => {
  it('does not eat a short real reply', () => {
    expect(stripWrappers('<user_query>\nSkip for now\n\n</user_query>')).toBe('Skip for now')
  })

  it('does not eat pasted XML outside the injected-tag allowlist', () => {
    const raw = 'see <my_custom_tag>keep me</my_custom_tag> please'
    expect(stripWrappers(raw)).toContain('<my_custom_tag>keep me</my_custom_tag>')
  })

  it('strips profile blobs that include - and _', () => {
    const raw =
      '<<SAND_AGENT_PROFILE_UPDATE:v1:abc-DEF_123+/=>>\n<user_query>\nhello\n</user_query>'
    expect(extractUserText(raw)).toBe('hello')
    expect(countNoise(raw).profile_blob).toBe(1)
  })
})

function sumNoise(n: ReturnType<typeof countNoise>): number {
  return Object.values(n).reduce((a, b) => a + b, 0)
}
