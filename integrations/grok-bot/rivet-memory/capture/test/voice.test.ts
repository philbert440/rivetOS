import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { normalizeRecords } from '../src/normalize.js'
import { parseVoiceCall, v3VoiceSession, voiceCallToRecords } from '../src/voice.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures', 'voice-calls', 'call-redacted.json')

describe('voice-calls reader (real callId/speaker/atMs + call-level toolCalls)', () => {
  it('maps speaker to role and atMs/startedAtMs to ISO, using callId as id', () => {
    const call = parseVoiceCall(readFileSync(FIX, 'utf8'), FIX)
    expect(call.id).toBe('vc-redacted-001')
    expect(call.started_at).toBe('2026-09-20T15:04:00.000Z')
    expect(call.turns).toHaveLength(2)
    expect(call.turns[0]?.role).toBe('user')
    expect(call.turns[0]?.started_at).toBe('2026-09-20T15:04:01.000Z')
    expect(call.turns[1]?.role).toBe('assistant')
    expect(call.turns[1]?.started_at).toBe('2026-09-20T15:04:08.000Z')
    expect(call.toolCalls).toHaveLength(1)
    expect(call.toolCalls[0]?.name).toBe('lookup')
    expect(call.toolCalls[0]?.atMs).toBe(1789916645000)
    expect(call.toolCalls[0]?.result).toContain('"ok":true')
  })

  it('uses a distinct -v3-voice-<stem> session so turn indices never mix with -v3', () => {
    expect(v3VoiceSession('grokbot-bob', FIX)).toBe('grokbot-bob-v3-voice-call-redacted')
  })

  it('emits call-level tool rows in time order next to the nearest turn', () => {
    const call = parseVoiceCall(readFileSync(FIX, 'utf8'), FIX)
    const { records, positions } = voiceCallToRecords(call)
    expect(records).toHaveLength(3)
    expect(records.map((r) => (r as { role: string }).role)).toEqual(['user', 'tool', 'assistant'])
    expect(records.map((r) => (r as { created_at: string }).created_at)).toEqual([
      '2026-09-20T15:04:01.000Z',
      '2026-09-20T15:04:05.000Z',
      '2026-09-20T15:04:08.000Z',
    ])
    expect(positions).toEqual([0, 1, 1])
    expect(JSON.stringify(records)).not.toContain('nudges')
    expect(JSON.stringify(records)).not.toContain('silence')
    const result = normalizeRecords(records, {
      sessionKey: v3VoiceSession('grokbot-bob', FIX),
      agent: 'rivet-bob',
      format: 'voice',
      positions,
      useStoredCreatedAt: true,
    })
    expect(result.messages.some((m) => m.role === 'user')).toBe(true)
    expect(result.messages.some((m) => m.role === 'assistant')).toBe(true)
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true)
    const tool = result.messages.find((m) => m.role === 'tool')
    expect(tool?.created_at).toBe('2026-09-20T15:04:05.000Z')
    expect(tool?.tool_result).toContain('"ok":true')
    expect(result.messages.find((m) => m.role === 'user')?.created_at).toBe(
      '2026-09-20T15:04:01.000Z',
    )
    expect(result.messages.every((m) => m.metadata?.source === 'grokbot-voice')).toBe(true)
  })

  it('records truncated metadata and keeps capped argumentsJson when a result exists', () => {
    const bigArgs = 'a'.repeat(18_000)
    const bigResult = 'b'.repeat(18_000)
    const call = parseVoiceCall(
      JSON.stringify({
        callId: 'vc-cap',
        startedAtMs: 1789916640000,
        turns: [
          { speaker: 'user', atMs: 1789916641000, text: 'ask' },
          { speaker: 'assistant', atMs: 1789916648000, text: 'ans' },
        ],
        toolCalls: [
          {
            name: 'lookup',
            argumentsJson: JSON.stringify({ q: bigArgs }),
            result: { atMs: 1789916645000, json: { body: bigResult } },
          },
        ],
      }),
    )
    expect(call.toolCalls[0]?.argumentsJson).toBeTruthy()
    expect(call.toolCalls[0]?.result).toBeTruthy()
    expect(call.toolCalls[0]?.truncated).toBe(true)
    expect(Number(call.toolCalls[0]?.fullArgumentsLength)).toBeGreaterThan(16_000)
    expect(Number(call.toolCalls[0]?.fullResultLength)).toBeGreaterThan(16_000)
    const { records, positions } = voiceCallToRecords(call)
    const toolRec = records.find((r) => (r as { role: string }).role === 'tool') as {
      message?: { content?: Array<Record<string, unknown>> }
    }
    const part = toolRec?.message?.content?.[0]
    expect(part?.argumentsJson).toBeTruthy()
    expect(part?.result).toBeTruthy()
    expect(part?.truncated).toBe(true)
    const result = normalizeRecords(records, {
      sessionKey: 'grokbot-bob-v3-voice-cap',
      agent: 'rivet-bob',
      format: 'voice',
      positions,
      useStoredCreatedAt: true,
    })
    const tool = result.messages.find((m) => m.role === 'tool')
    expect(tool?.metadata?.truncated).toBe(true)
    expect(tool?.tool_args).toBeTruthy()
    expect(tool?.tool_result).toBeTruthy()
    expect(Number(tool?.metadata?.full_tool_result_length)).toBeGreaterThan(16_000)
    expect(Number(tool?.metadata?.full_arguments_length)).toBeGreaterThan(16_000)
    expect(String(tool?.tool_args).length).toBeLessThanOrEqual(16_000)
    expect(String(tool?.tool_result).length).toBeLessThanOrEqual(16_000)
  })

  it('accepts a top-level array of turns with speaker/atMs', () => {
    const call = parseVoiceCall(
      JSON.stringify([
        { speaker: 'user', text: 'hi', atMs: 1789916640000 },
        { speaker: 'assistant', text: 'hello', atMs: 1789916645000 },
      ]),
      'array.json',
    )
    expect(call.turns).toHaveLength(2)
    expect(call.id).toBe('array')
    expect(call.toolCalls).toEqual([])
    expect(call.turns[0]?.role).toBe('user')
    expect(call.turns[0]?.started_at).toBe('2026-09-20T15:04:00.000Z')
  })

  it('convert-voice CLI writes ingest jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-voice-cli-'))
    const dst = join(dir, 'out.jsonl')
    const logs: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    }
    try {
      const code = await main([
        'convert-voice',
        FIX,
        dst,
        '--agent-id',
        '00df02ea-4f5f-4d3e-945a-864e1c9c78dc',
      ])
      expect(code).toBe(0)
      const info = JSON.parse(logs[logs.length - 1] ?? '{}') as {
        session?: string
        out?: number
        call_id?: string
      }
      expect(info.session).toBe('grokbot-bob-v3-voice-call-redacted')
      expect(info.call_id).toBe('vc-redacted-001')
      expect(info.out).toBeGreaterThanOrEqual(3)
    } finally {
      console.log = log
    }
  })
})
