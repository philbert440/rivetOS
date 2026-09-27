import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CaptureBatch } from '@rivetos/capture-core'
import {
  batchesFromEvents,
  ingestBatches,
  loadSpoolDir,
  messagesFromCursorEvent,
  spoolStampToIso,
  type SpoolEvent,
} from '../src/cursor-memory-capture.ts'

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
  dir = mkdtempSync(path.join(os.tmpdir(), 'cursor-capture-'))
  bodies = []
  vi.stubEnv('RIVETOS_CAPTURE_TRANSPORT', 'den')
  vi.stubEnv('RIVET_DEN_URL', 'https://127.0.0.1:5174')
  vi.stubEnv('RIVETOS_USER_ID', '')
  vi.stubEnv('RIVET_DEN_CA', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function event(hook: string, payload: Record<string, unknown>, createdAt?: string): SpoolEvent {
  return { event: hook, payload, createdAt, file: `${createdAt ?? ''}-${hook}.json` }
}

const base = {
  conversation_id: 'conv-1',
  generation_id: 'gen-1',
  model: 'grok-4.7',
  cursor_version: '2026.09.26',
  user_email: 'person@example.com',
  workspace_roots: ['/home/phil/Work'],
  transcript_path: '/tmp/transcript.jsonl',
}

it('converts the hook stamp into an ISO timestamp', () => {
  expect(spoolStampToIso('20260927T175058Z')).toBe('2026-09-27T17:50:58.000Z')
  expect(spoolStampToIso('not-a-stamp')).toBeUndefined()
})

it('maps prompt, assistant text, and tool use without storing email', () => {
  const prompt = messagesFromCursorEvent(
    event('beforeSubmitPrompt', { ...base, prompt: 'is the cursor plugin specifically 100%?', attachments: [{}] }),
  )
  const reply = messagesFromCursorEvent(
    event('afterAgentResponse', { ...base, text: 'No. Hooks spool, nothing ingests.' }),
  )
  const tool = messagesFromCursorEvent(
    event('postToolUse', {
      ...base,
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
      tool_input: { command: 'echo hi' },
      tool_output: 'hi',
    }),
  )
  expect(prompt[0]).toMatchObject({
    role: 'user',
    content: 'is the cursor plugin specifically 100%?',
    metadata: { attachment_count: 1, source: 'cursor-hook' },
  })
  expect(reply[0]).toMatchObject({ role: 'assistant', content: 'No. Hooks spool, nothing ingests.' })
  expect(tool[0]).toMatchObject({
    role: 'tool',
    content: 'Shell',
    tool_name: 'Shell',
    tool_args: { command: 'echo hi' },
    tool_result: 'hi',
    event_id: 'cursor:conv-1:tool:tool-1',
  })
  const encoded = JSON.stringify([prompt, reply, tool])
  expect(encoded).not.toContain('person@example.com')
  expect(encoded).not.toContain('user_email')
})

it('keeps a stable id for the same text and a new id when the text changes', () => {
  const first = messagesFromCursorEvent(event('afterAgentResponse', { ...base, text: 'same' }))
  const retry = messagesFromCursorEvent(event('afterAgentResponse', { ...base, text: 'same' }))
  const edited = messagesFromCursorEvent(event('afterAgentResponse', { ...base, text: 'different' }))
  expect(first[0].event_id).toBe(retry[0].event_id)
  expect(edited[0].event_id).not.toBe(first[0].event_id)
})

it('skips turn-stop and records session end as finalize', () => {
  expect(messagesFromCursorEvent(event('stop', { ...base, status: 'completed' }))).toEqual([])
  const batches = batchesFromEvents([
    event('beforeSubmitPrompt', { ...base, prompt: 'hello' }, '2026-09-27T17:00:00.000Z'),
    event('stop', { ...base, status: 'completed' }, '2026-09-27T17:00:01.000Z'),
    event('sessionEnd', { ...base, reason: 'completed' }, '2026-09-27T17:00:02.000Z'),
  ])
  expect(batches).toHaveLength(1)
  expect(batches[0].finalize).toBe(true)
  expect(batches[0].session_key).toBe('cursor:conv-1')
  expect(batches[0].agent).toBe('rivet-cursor')
  expect(batches[0].channel).toBe('cursor')
  expect(batches[0].title).toBe('hello')
  expect(batches[0].messages.map((row) => row.role)).toEqual(['user', 'system'])
  expect(batches[0].messages[1].content).toBe('[cursor.sessionEnd] completed')
})

it('backfill reads the spool in time order and posts one batch per conversation', async () => {
  const spool = path.join(dir, 'spool')
  mkdirSync(spool)
  const write = (name: string, hook: string, ts: string, payload: Record<string, unknown>) => {
    writeFileSync(path.join(spool, name), JSON.stringify({ hook, ts, payload }))
  }
  write('b.json', 'afterAgentResponse', '20260927T170100Z', { ...base, text: 'second' })
  write('a.json', 'beforeSubmitPrompt', '20260927T170000Z', { ...base, prompt: 'first' })
  write('c.json', 'beforeSubmitPrompt', '20260927T170200Z', {
    ...base,
    conversation_id: 'conv-2',
    prompt: 'other',
  })
  write('dup.json', 'beforeSubmitPrompt', '20260927T170000Z', { ...base, prompt: 'first' })
  const loaded = loadSpoolDir(spool)
  expect(loaded.unreadable).toBe(0)
  const counts = await ingestBatches(batchesFromEvents(loaded.events), {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as CaptureBatch)
      return new Response(JSON.stringify({ ok: true, conversation_id: 'conv', inserted: 1, skipped: 0 }))
    },
    spoolDir: path.join(dir, 'den-spool'),
  })
  expect(counts.failed).toBe(0)
  expect(counts.conversations).toBe(2)
  const conv1 = bodies.find((batch) => batch.session_key === 'cursor:conv-1')
  expect(conv1?.messages.map((row) => row.content)).toEqual(['first', 'second'])
  expect(JSON.stringify(bodies)).not.toContain('person@example.com')
})

it('caps tool output and reports a rejected batch as failed', async () => {
  const huge = 'x'.repeat(20_000)
  const [row] = messagesFromCursorEvent(
    event('postToolUse', { ...base, tool_name: 'Shell', tool_use_id: 'tool-big', tool_output: huge }),
  )
  expect(row.tool_result).toHaveLength(16_000)
  expect(row.metadata).toMatchObject({ truncated: true, full_tool_result_length: 20_000 })
  const counts = await ingestBatches(
    batchesFromEvents([event('beforeSubmitPrompt', { ...base, prompt: 'hi' })]),
    {
      fetch: async () => new Response('no', { status: 400 }),
      spoolDir: path.join(dir, 'den-spool'),
    },
  )
  expect(counts.failed).toBe(1)
  expect(counts.inserted).toBe(0)
})
