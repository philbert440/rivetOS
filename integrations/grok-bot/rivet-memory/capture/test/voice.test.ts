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

describe('voice-calls reader (real callId/speaker/atMs shape)', () => {
  it('maps speaker to role and atMs/startedAtMs to ISO, using callId as id', () => {
    const call = parseVoiceCall(readFileSync(FIX, 'utf8'), FIX)
    expect(call.id).toBe('vc-redacted-001')
    expect(call.started_at).toBe('2026-09-20T15:04:00.000Z')
    expect(call.turns).toHaveLength(2)
    expect(call.turns[0]?.role).toBe('user')
    expect(call.turns[0]?.started_at).toBe('2026-09-20T15:04:01.000Z')
    expect(call.turns[1]?.role).toBe('assistant')
    expect(call.turns[1]?.started_at).toBe('2026-09-20T15:04:08.000Z')
    expect(call.turns[1]?.toolCalls).toHaveLength(1)
    expect(call.turns[1]?.nudgeCount).toBe(1)
  })

  it('uses a distinct -v3-voice-<stem> session so turn indices never mix with -v3', () => {
    expect(v3VoiceSession('grokbot-bob', FIX)).toBe('grokbot-bob-v3-voice-call-redacted')
  })

  it('feeds the same normalizer with role, time, and tool rows; drops nudges', () => {
    const call = parseVoiceCall(readFileSync(FIX, 'utf8'), FIX)
    const { records, positions } = voiceCallToRecords(call)
    expect(records).toHaveLength(3)
    expect(positions).toEqual([0, 1, 1])
    expect(records[0]).toMatchObject({
      role: 'user',
      created_at: '2026-09-20T15:04:01.000Z',
    })
    expect(records[1]).toMatchObject({
      role: 'assistant',
      created_at: '2026-09-20T15:04:08.000Z',
    })
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
    expect(result.messages.find((m) => m.role === 'user')?.created_at).toBe(
      '2026-09-20T15:04:01.000Z',
    )
    expect(result.messages.every((m) => m.metadata?.source === 'grokbot-voice')).toBe(true)
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
      expect(info.out).toBeGreaterThanOrEqual(2)
    } finally {
      console.log = log
    }
  })
})
