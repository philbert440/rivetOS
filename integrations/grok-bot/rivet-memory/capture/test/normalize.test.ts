import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capForStorage } from '@rivetos/capture-core'
import { describe, expect, it } from 'vitest'
import { classifyHidden, extractAgentMessage } from '../src/hidden.js'
import {
  HISTORICAL_OVERRIDES,
  agentIdFromTranscriptPath,
  discoverModels,
  identityFor,
  listInputFiles,
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
import { recleanFromSource, recleanStoredRows, v3Session } from '../src/reclean.js'
import { addMs, parseGrokTimestamp } from '../src/timestamps.js'
import { countNoise, extractUserText, stripWrappers } from '../src/wrappers.js'
import { STORAGE_LIMIT } from '../src/types.js'
import { compareInput } from '../src/compare.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const RIVET_ID = '6a155e75-0dd5-4c8a-8391-994878ed683a'
const EGG_ID = 'fe09510f-c3ce-49bc-9d93-8c5ab5705809'
const BOB_ID = '00df02ea-4f5f-4d3e-945a-864e1c9c78dc'

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

  it('inherits last known time plus N ms only onto assistant/tool after a stamped user', () => {
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
    expect(messages[1].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 1))
    expect(messages[2].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 2))
    expect(messages[3].created_at).toBeUndefined()
    expect(messages[4].created_at).toBeUndefined()
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
    const { messages } = normalizeRecords(records, rivetOpts())
    expect(messages.every((m) => !m.created_at)).toBe(true)
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
    expect(messages[1].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 1))
    expect(messages[2].created_at).toBe('2026-09-27T20:07:00.000Z')
    expect(messages[3].created_at).toBe(addMs('2026-09-27T20:07:00.000Z', 1))
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
    expect(users[1].created_at).toBe(addMs(users[0].created_at ?? '', 2))
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
    expect(messages[1].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 1))
    expect(messages[2].created_at).toBe(addMs('2026-09-27T20:06:00.000Z', 2))
    const clock = { last: '2026-09-27T20:06:00.000Z' }
    expect(clampCreatedAt(clock, '2026-09-27T20:06:00.000Z')).toBe(
      addMs('2026-09-27T20:06:00.000Z', 1),
    )
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

  it('leaves created_at unset when no time is known', () => {
    const { result } = normalizeFile('page-rivet-this-conversation-3040-3056.txt')
    const stamped = result.messages.filter((m) => m.created_at)
    expect(result.timeKnown).toBe(false)
    expect(stamped).toEqual([])
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

  it('keeps a normal user message that mentions [event]', () => {
    const rec = {
      role: 'user',
      message: {
        content: [
          { type: 'text', text: '<user_query>\nI got an [event] at work today\n</user_query>' },
        ],
      },
    }
    const { messages } = normalizeRecords([rec], rivetOpts())
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toContain('[event]')
    expect(messages[0].content).toContain('at work today')
    expect(
      extractUserText('<user_query>\nI got an [event] at work today\n</user_query>'),
    ).toContain('[event]')
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
    const { result } = normalizeFile('synthetic-wrappers.jsonl')
    expect(result.messages.some((m) => m.metadata?.kind === 'reaction')).toBe(true)
    expect(result.messages.some((m) => m.metadata?.kind === 'event')).toBe(true)
  })
})

describe('per-bot tags', () => {
  it('keeps the historical Rivet session/agent tags unchanged', () => {
    const ident = identityFor(RIVET_ID)
    expect(ident.session).toBe('grokbot-rivet-grokbot')
    expect(ident.agent).toBe('rivet-grokbot')
    expect(HISTORICAL_OVERRIDES[RIVET_ID].session).toBe('grokbot-rivet-grokbot')
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
        '/home/box/agent-data/agent-transcripts/00df02ea-4f5f-4d3e-945a-864e1c9c78dc/00df02ea-4f5f-4d3e-945a-864e1c9c78dc.jsonl',
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

  it('caps tool_result at the capture-core 16_000 UTF-16 limit with no inline marker', () => {
    const huge = 'x'.repeat(20_000)
    const rec = {
      role: 'tool',
      message: { content: [{ type: 'tool_result', name: 'shell', result: huge }] },
    }
    const { messages } = normalizeRecords([rec], rivetOpts())
    const cap = capForStorage(huge)
    expect(messages[0].tool_result).toBe(cap.text)
    expect(messages[0].tool_result?.length).toBe(STORAGE_LIMIT)
    expect(messages[0].tool_result).not.toContain('…[truncated')
    expect(messages[0].metadata?.truncated).toBe(true)
    expect(messages[0].metadata?.full_tool_result_length).toBe(20_000)
    expect(LEGACY_TOOL_RESULT_MAX).toBe(4096)
  })

  it('caps a real oversized ReadTranscript shell result the same way', () => {
    const { result } = normalizeFile('page-rivet-2395-2445.txt')
    const tools = result.messages.filter((m) => m.role === 'tool' && m.metadata?.truncated)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools[0].tool_result?.length).toBeLessThanOrEqual(STORAGE_LIMIT)
    expect(tools[0].tool_result).not.toContain('…[truncated')
    expect(Number(tools[0].metadata?.full_tool_result_length)).toBeGreaterThan(STORAGE_LIMIT)
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
    expect(rows.some((r) => r.createdAt)).toBe(true)
    expect(rows.some((r) => r.toolCalls && r.toolCalls.length > 0)).toBe(true)
    expect(rows.every((r) => r.metadata?.agent_id === BOB_ID)).toBe(true)
    expect(rows.every((r) => typeof r.metadata?.position === 'number')).toBe(true)
    expect(rows.every((r) => typeof r.ordinal === 'number')).toBe(true)
    expect(rows.every((r) => typeof r.event_id === 'string' && r.event_id.length > 0)).toBe(true)
    const tool = rows.find((r) => r.role === 'tool' && r.metadata?.truncated)
    if (tool) {
      expect(typeof tool.metadata?.full_tool_result_length).toBe('number')
    }
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
