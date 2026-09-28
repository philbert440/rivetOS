import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CaptureBatch } from '@rivetos/capture-core'
import {
  batchesFromEvents,
  canonicalTool,
  consumeTranscript,
  emptyConvState,
  enrichReadOutput,
  ingestBatches,
  loadSpoolDir,
  messagesFromCursorEvent,
  planCursorHook,
  splitCompleteLines,
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
  workspace_roots: ['/home/user/Work'],
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

it('keeps a trailing partial transcript line unconsumed', () => {
  const split = splitCompleteLines(Buffer.from('{"role":"user"}\n{"role":"assi'))
  expect(split.lines).toEqual(['{"role":"user"}'])
  expect(split.consumed).toBe('{"role":"user"}\n'.length)
  expect(splitCompleteLines(Buffer.from('no newline yet'))).toEqual({ lines: [], consumed: 0 })
})

it('joins hook results onto transcript rows and does not store the hook text again', () => {
  const file = path.join(dir, 'conv.jsonl')
  const lines = [
    {
      role: 'user',
      message: { content: [{ type: 'text', text: 'tail the transcript' }] },
    },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', name: 'Shell', input: { command: 'echo hi', description: 'say hi' } },
          {
            type: 'tool_use',
            name: 'CallDynamicTool',
            input: { namespace: 'rivetos', toolName: 'echo', arguments: { message: 'ping' } },
          },
        ],
      },
    },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const shell = planCursorHook(
    event('postToolUse', {
      ...base,
      transcript_path: file,
      tool_name: 'Shell',
      tool_use_id: 'tool-shell',
      tool_input: { command: 'echo hi', cwd: '', timeout: 30000 },
      tool_output: 'hi\n',
    }),
    null,
  )
  expect(shell.messages.map((row) => row.role)).toEqual(['user', 'assistant', 'tool'])
  expect(shell.messages.map((row) => row.event_id)).toEqual([
    'cursor:conv-1:line:0:part:0',
    'cursor:conv-1:line:1:part:0',
    'cursor:conv-1:line:1:part:1',
  ])
  expect(shell.messages[2]).toMatchObject({
    tool_name: 'Shell',
    tool_result: 'hi\n',
    metadata: { source: 'cursor-transcript', session_jsonl_path: file, session_jsonl_line: 1 },
  })
  expect(shell.messages.some((row) => String(row.event_id).includes(':assistant:'))).toBe(false)
  const echo = planCursorHook(
    event('postToolUse', {
      ...base,
      transcript_path: file,
      tool_name: 'MCP:echo',
      tool_use_id: 'tool-echo',
      tool_input: { message: 'ping' },
      tool_output: 'pong',
    }),
    shell.state,
  )
  expect(echo.messages).toHaveLength(1)
  expect(echo.messages[0]).toMatchObject({
    event_id: 'cursor:conv-1:line:1:part:2',
    tool_name: 'CallDynamicTool',
    tool_result: 'pong',
  })
  const reply = planCursorHook(
    event('afterAgentResponse', { ...base, transcript_path: file, text: 'Reading it.' }),
    echo.state,
  )
  expect(reply.messages).toEqual([])
  expect(canonicalTool('Shell', { command: 'echo hi', cwd: '', timeout: 1 }).inputKey).toBe(
    canonicalTool('Shell', { command: 'echo hi', description: 'say hi' }).inputKey,
  )
})

it('snapshots a Read stub from the transcript offset and leaves Grep stubs alone', () => {
  const file = path.join(dir, 'notes.txt')
  writeFileSync(file, 'alpha\nbeta\ngamma\n')
  const transcript = path.join(dir, 'read.jsonl')
  writeFileSync(
    transcript,
    `${JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { path: file, offset: 2, limit: 1 } }] },
    })}\n`,
  )
  const planned = planCursorHook(
    event('postToolUse', {
      ...base,
      transcript_path: transcript,
      tool_name: 'Read',
      tool_use_id: 'tool-read',
      tool_input: { file_path: file },
      tool_output: { file_path: file, content_length: 16 },
    }),
    null,
  )
  expect(planned.messages[0].tool_result).toBe('beta')
  const stub = JSON.stringify({ file_path: file, content_length: 16 })
  expect(enrichReadOutput('Grep', { path: file, pattern: 'beta' }, stub)).toBe(stub)
})

it('emits a tool row once the result arrives, and flushes a result with no transcript line', () => {
  const file = path.join(dir, 'late.jsonl')
  writeFileSync(file, '')
  const queued = planCursorHook(
    event('postToolUse', {
      ...base,
      transcript_path: file,
      tool_name: 'Shell',
      tool_use_id: 'tool-late',
      tool_input: { command: 'true', cwd: '', timeout: 1000 },
      tool_output: 'ok',
    }),
    null,
  )
  expect(queued.messages).toEqual([])
  expect(queued.state.results).toHaveLength(1)
  const flushed = planCursorHook(event('stop', { ...base, transcript_path: file, status: 'completed' }), queued.state)
  expect(flushed.messages[0]).toMatchObject({
    event_id: 'cursor:conv-1:tool:tool-late',
    role: 'tool',
    tool_result: 'ok',
  })
  const joined = consumeTranscript({
    conversationId: 'conv-1',
    file,
    chunk: Buffer.from(
      `${JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'true', description: 'noop' } }] },
      })}\n`,
    ),
    state: { ...emptyConvState(file), results: queued.state.results },
    mtimeMs: Date.parse('2026-09-27T17:00:00.000Z'),
  })
  expect(joined.messages[0].event_id).toBe('cursor:conv-1:line:0:part:0')
  expect(joined.messages[0].tool_result).toBe('ok')
  expect(joined.state.results).toEqual([])
})
