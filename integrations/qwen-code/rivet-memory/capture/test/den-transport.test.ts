import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => {
  class Pool {
    constructor() {
      throw new Error('pg.Pool must not be constructed on the den path')
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
  content: string
  metadata?: { session_jsonl_path?: unknown; session_jsonl_line?: unknown }
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
    for (const message of batch?.messages ?? []) {
      expect(message.metadata?.session_jsonl_path).toBe(path.resolve(FIXTURE))
      expect(typeof message.metadata?.session_jsonl_line).toBe('number')
    }
    expect(loadCaptureState(stateFile).cursors[path.resolve(FIXTURE)]?.offset).toBe(
      statSync(FIXTURE).size,
    )
    const pg = (await import('pg')).default as { Pool: new () => unknown }
    expect(() => new pg.Pool()).toThrow(/pg\.Pool/)
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
