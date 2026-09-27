import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => {
  class Pool {
    constructor() {
      // pg is still statically imported. This only proves no pool was constructed.
      throw new Error('no pool constructed')
    }
  }
  return { default: { Pool }, Pool }
})

import {
  deriveSessionKey,
  ingestTranscriptFile,
  loadCaptureState,
  parseTranscriptFile,
  resolveCaptureAgent,
  saveCaptureState,
} from '../src/qwen-memory-capture.ts'

const denEnv: NodeJS.ProcessEnv = {
  RIVETOS_CAPTURE_TRANSPORT: 'den',
  RIVET_DEN_URL: 'https://127.0.0.1:5174',
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-session',
  '11111111-2222-4333-8444-555555555555.jsonl',
)

interface PostedMessage {
  event_id: string
  role: string
  content: string
  tool_name?: string
  tool_args?: unknown
  tool_result?: string
  created_at?: string
  metadata?: {
    session_jsonl_path?: unknown
    session_jsonl_line?: unknown
    full_content_length?: number
    truncated?: boolean
  }
}
interface PostedBatch {
  session_key: string
  agent: string
  channel?: string
  finalize?: boolean
  messages: PostedMessage[]
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-den-'))
  dirs.push(dir)
  return dir
}

function okFetch(bodies: PostedBatch[]): typeof fetch {
  return (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as PostedBatch)
    return new Response(
      JSON.stringify({ ok: true, conversation_id: 'conv-1', inserted: 2, skipped: 0 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

describe('qwen den transport', () => {
  it('posts the uncapped batch and advances the cursor', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const bodies: PostedBatch[] = []
    const parsed = parseTranscriptFile(FIXTURE)
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: okFetch(bodies),
      spoolDir: path.join(dir, 'spool'),
    })
    expect(result.failed).toBeUndefined()
    const batch = bodies[0]
    expect(batch?.session_key).toBe(deriveSessionKey(parsed.sessionId))
    expect(batch?.agent).toBe(resolveCaptureAgent())
    expect(batch?.channel).toBe('qwen-code')
    expect(batch?.finalize).toBeUndefined()
    expect(batch?.messages.map((m) => m.event_id)).toEqual(parsed.messages.map((m) => m.eventId))
    expect(batch?.messages.map((m) => m.content)).toEqual(parsed.messages.map((m) => m.content))
    expect(batch?.messages.map((m) => m.role)).toEqual(parsed.messages.map((m) => m.role))
    const user = batch?.messages.find((m) => m.role === 'user' && m.content.startsWith('reply'))
    expect(user).toMatchObject({
      role: 'user',
      content: 'reply with the single word pong',
      created_at: '2026-09-15T20:24:20.902Z',
    })
    expect(user?.tool_name).toBeUndefined()
    const call = batch?.messages.find((m) => m.tool_name === 'run_shell_command' && !m.tool_result)
    expect(call).toMatchObject({
      role: 'tool',
      content: '[tool] run_shell_command',
      tool_name: 'run_shell_command',
      tool_args: {
        command: 'echo tool-sample-ok',
        description: 'Print a sample marker string to stdout',
      },
      created_at: '2026-09-15T20:26:32.134Z',
    })
    const toolOut = batch?.messages.find((m) => m.tool_result === 'tool-sample-ok')
    expect(toolOut).toMatchObject({
      role: 'tool',
      content: '[tool-result] run_shell_command',
      tool_name: 'run_shell_command',
      tool_result: 'tool-sample-ok',
      created_at: '2026-09-15T20:26:32.341Z',
    })
    for (const message of batch?.messages ?? []) {
      expect(message.metadata?.session_jsonl_path).toBe(path.resolve(FIXTURE))
      expect(typeof message.metadata?.session_jsonl_line).toBe('number')
    }
    expect(loadCaptureState(stateFile).cursors[path.resolve(FIXTURE)]?.offset).toBe(
      statSync(FIXTURE).size,
    )
    const pg = (await import('pg')).default as { Pool: new () => unknown }
    expect(() => new pg.Pool()).toThrow(/no pool constructed/)
  })

  it('records oversized field metadata after the writer cap', async () => {
    const dir = tmpDir()
    const file = path.join(dir, '11111111-2222-4333-8444-555555555555.jsonl')
    const content = 'q'.repeat(16_001)
    writeFileSync(
      file,
      JSON.stringify({
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        sessionId: '11111111-2222-4333-8444-555555555555',
        timestamp: '2026-09-15T20:24:20.902Z',
        type: 'user',
        provenance: 'real_user',
        cwd: '/home/example/scratchpad/proj',
        message: { role: 'user', parts: [{ text: content }] },
      }) + '\n',
    )
    const bodies: PostedBatch[] = []
    await ingestTranscriptFile(file, {
      stateFile: path.join(dir, 'state.json'),
      env: denEnv,
      fetch: okFetch(bodies),
      spoolDir: path.join(dir, 'spool'),
    })
    expect(bodies[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: 'q'.repeat(16_000),
      created_at: '2026-09-15T20:24:20.902Z',
      metadata: { full_content_length: 16_001, truncated: true },
    })
  })

  it('rolls the cursor back to the previous offset on a thrown 4xx', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const abs = path.resolve(FIXTURE)
    saveCaptureState(
      { version: 1, cursors: { [abs]: { offset: 24, pending: 'keep-me' } } },
      stateFile,
    )
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: () => Promise.resolve(new Response('', { status: 422 })),
      spoolDir: path.join(dir, 'spool'),
    })
    expect(result.failed).toBe(true)
    expect(loadCaptureState(stateFile).cursors[abs]).toEqual({ offset: 24, pending: 'keep-me' })
  })

  it('sets finalize when the session closes', async () => {
    const dir = tmpDir()
    const bodies: PostedBatch[] = []
    await ingestTranscriptFile(FIXTURE, {
      stateFile: path.join(dir, 'state.json'),
      env: denEnv,
      fetch: okFetch(bodies),
      closeSession: true,
      spoolDir: path.join(dir, 'spool'),
    })
    expect(bodies[0]?.finalize).toBe(true)
  })

  it('advances the cursor when the batch is spooled', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const spoolDir = path.join(dir, 'spool')
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      spoolDir,
    })
    expect(result.failed).toBeUndefined()
    expect(loadCaptureState(stateFile).cursors[path.resolve(FIXTURE)]?.offset).toBe(
      statSync(FIXTURE).size,
    )
    expect(readdirSync(spoolDir).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  })

  it('does not advance the cursor when spooling fails', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const blocker = path.join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      spoolDir: path.join(blocker, 'spool'),
    })
    expect(result.failed).toBe(true)
    expect(loadCaptureState(stateFile).cursors[path.resolve(FIXTURE)]).toBeUndefined()
  })
})
