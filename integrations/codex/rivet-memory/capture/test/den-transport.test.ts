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
  parseRolloutFile,
  saveCaptureState,
} from '../src/codex-memory-capture.ts'

const denEnv: NodeJS.ProcessEnv = {
  RIVETOS_CAPTURE_TRANSPORT: 'den',
  RIVET_DEN_URL: 'https://127.0.0.1:5174',
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-rollout',
  'rollout-2026-09-07T12-00-00-00000000-0000-4000-8000-000000000020.jsonl',
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
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-den-'))
  dirs.push(dir)
  return dir
}

function okFetch(bodies: PostedBatch[], urls: string[]): typeof fetch {
  return (async (input, init) => {
    urls.push(String(input))
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as PostedBatch)
    return new Response(
      JSON.stringify({ ok: true, conversation_id: 'conv-1', inserted: 4, skipped: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

describe('codex den transport', () => {
  it('posts the uncapped batch and advances the cursor', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const bodies: PostedBatch[] = []
    const urls: string[] = []
    const parsed = parseRolloutFile(FIXTURE)
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: okFetch(bodies, urls),
      spoolDir: path.join(dir, 'spool'),
    })
    expect(result.failed).toBeUndefined()
    expect(urls).toEqual(['https://127.0.0.1:5174/api/capture'])
    const batch = bodies[0]
    expect(batch?.session_key).toBe(deriveSessionKey(parsed.sessionId))
    expect(batch?.agent).toBe('rivet-gpt')
    expect(batch?.channel).toBe('codex')
    expect(batch?.finalize).toBeUndefined()
    expect(batch?.messages.map((m) => m.event_id)).toEqual(parsed.messages.map((m) => m.eventId))
    expect(batch?.messages.map((m) => m.content)).toEqual(parsed.messages.map((m) => m.content))
    expect(batch?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ])
    const byId = new Map((batch?.messages ?? []).map((message) => [message.event_id, message]))
    expect(byId.get('rs_user1')).toMatchObject({ role: 'user', content: 'list the files' })
    expect(byId.get('rs_user1')?.tool_name).toBeUndefined()
    expect(byId.get('rs_user1')?.created_at).toBeUndefined()
    expect(byId.get('rs_think1')).toMatchObject({
      role: 'assistant',
      content: '[thinking] I should list',
    })
    expect(byId.get('ctc_1')).toMatchObject({
      role: 'tool',
      content: '[tool] shell',
      tool_name: 'shell',
      tool_args: { command: 'ls', extra: { nested: true } },
    })
    expect(byId.get('ctc_1')?.tool_result).toBeUndefined()
    expect(byId.get('ctco_1')).toMatchObject({
      role: 'tool',
      content: '[tool-result] shell',
      tool_name: 'shell',
      tool_result: 'a.txt',
    })
    expect(byId.get('rs_asst1')).toMatchObject({ role: 'assistant', content: 'here they are' })
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

  it('posts created_at and capped oversized metadata', async () => {
    const dir = tmpDir()
    const file = path.join(
      dir,
      'rollout-2026-09-07T12-00-00-00000000-0000-4000-8000-000000000020.jsonl',
    )
    const content = 'x'.repeat(16_001)
    writeFileSync(
      file,
      [
        JSON.stringify({
          timestamp: '2026-09-07T12:00:00.000Z',
          type: 'session_meta',
          payload: { id: '00000000-0000-4000-8000-000000000020', cwd: '/tmp/demo' },
        }),
        JSON.stringify({
          timestamp: '2026-09-07T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            id: 'user-ts',
            content: [{ type: 'input_text', text: content }],
          },
        }),
      ].join('\n') + '\n',
    )
    const bodies: PostedBatch[] = []
    await ingestTranscriptFile(file, {
      stateFile: path.join(dir, 'state.json'),
      env: denEnv,
      fetch: okFetch(bodies, []),
      spoolDir: path.join(dir, 'spool'),
    })
    expect(bodies[0]?.messages[0]).toMatchObject({
      event_id: 'user-ts',
      role: 'user',
      content: 'x'.repeat(16_000),
      created_at: '2026-09-07T12:00:01.000Z',
      metadata: { full_content_length: 16_001, truncated: true },
    })
  })

  it('rolls the cursor back to the previous offset on a thrown 4xx', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const abs = path.resolve(FIXTURE)
    saveCaptureState(
      { version: 1, cursors: { [abs]: { offset: 20, pending: 'keep-me' } } },
      stateFile,
    )
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: () => Promise.resolve(new Response('', { status: 400 })),
      spoolDir: path.join(dir, 'spool'),
    })
    expect(result.failed).toBe(true)
    expect(loadCaptureState(stateFile).cursors[abs]).toEqual({ offset: 20, pending: 'keep-me' })
  })

  it('sets finalize when the session closes', async () => {
    const dir = tmpDir()
    const bodies: PostedBatch[] = []
    await ingestTranscriptFile(FIXTURE, {
      stateFile: path.join(dir, 'state.json'),
      env: denEnv,
      fetch: okFetch(bodies, []),
      closeSession: true,
      spoolDir: path.join(dir, 'spool'),
    })
    expect(bodies[0]?.finalize).toBe(true)
  })

  it('advances the cursor when the batch is spooled', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const spoolDir = path.join(dir, 'spool')
    const failing: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'))
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: failing,
      spoolDir,
    })
    expect(result.failed).toBeUndefined()
    expect(loadCaptureState(stateFile).cursors[path.resolve(FIXTURE)]?.offset).toBe(
      statSync(FIXTURE).size,
    )
    const spooled = readdirSync(spoolDir).filter((name) => name.endsWith('.json'))
    expect(spooled).toHaveLength(1)
    const saved = JSON.parse(readFileSync(path.join(spoolDir, spooled[0] ?? ''), 'utf8')) as PostedBatch
    expect(saved.session_key).toBe(deriveSessionKey(parseRolloutFile(FIXTURE).sessionId))
    expect(saved.messages.length).toBeGreaterThan(0)
  })

  it('does not advance the cursor when spooling fails', async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const blocker = path.join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const failing: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'))
    const result = await ingestTranscriptFile(FIXTURE, {
      stateFile,
      env: denEnv,
      fetch: failing,
      spoolDir: path.join(blocker, 'spool'),
    })
    expect(result.failed).toBe(true)
    expect(loadCaptureState(stateFile).cursors[path.resolve(FIXTURE)]).toBeUndefined()
  })
})
