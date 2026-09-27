import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CaptureBatch } from '@rivetos/capture-core'

vi.mock('pg', () => {
  class Pool {
    constructor() {
      throw new Error('pg loaded on den path')
    }
  }
  return { default: { Pool }, Pool }
})

let dir: string
let bodies: CaptureBatch[]
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kimi-den-'))
  bodies = []
  vi.stubEnv('RIVETOS_CAPTURE_TRANSPORT', 'den')
  vi.stubEnv('RIVET_DEN_URL', 'https://127.0.0.1:5174')
  vi.stubEnv('RIVETOS_USER_ID', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})
function sink(offline = false, failedSpool = false) {
  const spoolDir = path.join(dir, 'spool')
  if (failedSpool) writeFileSync(spoolDir, 'not a directory')
  const fetch: typeof globalThis.fetch = async (url, init) => {
    expect(String(url)).toBe('https://127.0.0.1:5174/api/capture')
    bodies.push(JSON.parse(String(init?.body)) as CaptureBatch)
    if (offline) throw new Error('offline')
    return new Response(
      JSON.stringify({ ok: true, conversation_id: 'conv', inserted: 1, skipped: 0 }),
    )
  }
  return { fetch, spoolDir }
}
import { createHash } from 'node:crypto'
import { processOp, contentHashEventId } from '../src/kimi-memory-capture.js'

it('keeps the original six-field content hash', () => {
  const parts = {
    sessionId: 'sid',
    role: 'tool',
    content: 'done',
    toolName: 'shell',
    toolResult: 'ok',
    sourceEvent: 'PostToolUse',
  }
  const expected = createHash('sha256')
    .update(['sid', 'tool', 'done', 'shell', 'ok', 'PostToolUse'].join('\0'), 'utf8')
    .digest('hex')
  expect(contentHashEventId(parts)).toBe(expected)
})
it('posts exact hook and wire rows with finalize and disk pointer', async () => {
  vi.spyOn(os, 'homedir').mockReturnValue(dir)
  const sessionDir = path.join(dir, '.kimi', 'sessions', 'workspace', 'sid', 'agents', 'main')
  mkdirSync(sessionDir, { recursive: true })
  const file = path.join(sessionDir, 'wire.jsonl')
  const text =
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1000,
      event: { type: 'content.part', uuid: 'uuid', part: { type: 'text', text: 'hello' } },
    }) + '\n'
  writeFileSync(file, text)
  await processOp(
    {
      kind: 'hook',
      sessionId: 'sid',
      sourceEvent: 'SessionEnd',
      finalize: true,
      payload: { timestamp: '2026-09-27T00:00:00Z' },
    },
    sink(),
  )
  const id = createHash('sha256')
    .update(['sid', 'assistant', 'hello', '', '', 'wire:content.part:uuid'].join('\0'))
    .digest('hex')
  const hookId = createHash('sha256')
    .update(['sid', 'system', '[kimi.SessionEnd]', '', '', 'SessionEnd'].join('\0'))
    .digest('hex')
  expect(bodies[0]).toEqual({
    session_key: 'kimi-code:sid',
    agent: 'rivet-kimi',
    channel: 'kimi-code',
    title: 'Kimi Code session',
    finalize: true,
    settings: { source: 'kimi-hook', sessionId: 'sid', cwd: null, triggerEvent: 'SessionEnd' },
    messages: [
      {
        event_id: hookId,
        role: 'system',
        content: '[kimi.SessionEnd]',
        metadata: {
          source: 'kimi-hook',
          event_id: hookId,
          sourceEvent: 'SessionEnd',
          event_ts: '2026-09-27T00:00:00Z',
        },
      },
      bodies[0].messages[1],
    ],
  })
  expect(bodies[0].messages.find((m) => m.event_id === id)).toEqual({
    event_id: id,
    role: 'assistant',
    content: 'hello',
    created_at: '1970-01-01T00:00:01.000Z',
    metadata: {
      source: 'kimi-wire',
      event_id: id,
      sourceEvent: 'wire:content.part',
      agentSlot: 'main',
      partType: 'text',
      uuid: 'uuid',
      session_jsonl_path: file,
      session_jsonl_line: 0,
      event_ts: '1970-01-01T00:00:01.000Z',
    },
  })
})
it.each(['spooled', 'failed'] as const)('durability: %s', async (mode) => {
  const options = sink(true, mode === 'failed')
  const ingest = processOp(
    { kind: 'hook', sessionId: 'sid', sourceEvent: 'SessionEnd', finalize: true, payload: {} },
    options,
  )
  if (mode === 'failed') await expect(ingest).rejects.toThrow('spool failed')
  else {
    await ingest
    expect(readdirSync(options.spoolDir)).toHaveLength(1)
  }
})
