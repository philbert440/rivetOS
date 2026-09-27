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

import { ingestTranscriptFile, parseRolloutFile, loadCaptureState, deriveSessionKey } from '../src/codex-memory-capture.ts'

const denEnv: NodeJS.ProcessEnv = {
  RIVETOS_CAPTURE_TRANSPORT: 'den',
  RIVET_DEN_URL: 'https://127.0.0.1:5174',
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-rollout',
  'rollout-2026-09-07T12-00-00-89965427-b96f-4d5e-8ad5-c3dd138e33dc.jsonl',
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
