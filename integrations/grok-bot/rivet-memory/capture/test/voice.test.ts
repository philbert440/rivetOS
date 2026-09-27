import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { normalizeRecords } from '../src/normalize.js'
import {
  parseVoiceCall,
  v3VoiceSession,
  voiceCallToRecords,
} from '../src/voice.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures', 'voice-calls', 'call-redacted.json')

describe('voice-calls reader (reconstructed fixture, not a live dump)', () => {
  it('parses turns from the reconstructed schema', () => {
    const call = parseVoiceCall(readFileSync(FIX, 'utf8'), FIX)
    expect(call.id).toBe('vc-redacted-001')
    expect(call.turns).toHaveLength(2)
    expect(call.turns[0]?.role).toBe('user')
    expect(call.turns[1]?.text).toMatch(/not from a live dump/)
  })

  it('uses a distinct -v3-voice-<stem> session so turn indices never mix with -v3', () => {
    expect(v3VoiceSession('grokbot-bob', FIX)).toBe('grokbot-bob-v3-voice-call-redacted')
  })

  it('feeds the same normalizer with turn index as position', () => {
    const call = parseVoiceCall(readFileSync(FIX, 'utf8'), FIX)
    const { records, positions } = voiceCallToRecords(call)
    const result = normalizeRecords(records, {
      sessionKey: v3VoiceSession('grokbot-bob', FIX),
      agent: 'rivet-bob',
      format: 'voice',
      positions,
      useStoredCreatedAt: true,
    })
    expect(result.messages.map((m) => m.metadata?.position)).toEqual([0, 1])
    expect(result.messages.every((m) => m.metadata?.source === 'grokbot-voice')).toBe(true)
  })

  it('accepts a top-level array of turns', () => {
    const call = parseVoiceCall(
      JSON.stringify([
        { role: 'user', text: 'hi', started_at: '2026-09-20T15:00:00.000Z' },
        { role: 'assistant', text: 'hello' },
      ]),
      'array.json',
    )
    expect(call.turns).toHaveLength(2)
    expect(call.id).toBe('array')
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
      const info = JSON.parse(logs[logs.length - 1] ?? '{}') as { session?: string; out?: number }
      expect(info.session).toBe('grokbot-bob-v3-voice-call-redacted')
      expect(info.out).toBe(2)
    } finally {
      console.log = log
    }
  })
})
