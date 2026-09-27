import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
  dir = mkdtempSync(path.join(os.tmpdir(), 'grok-den-'))
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
import { ingestSession } from '../src/grok-memory-capture.js'

function fixture() {
  vi.spyOn(os, 'homedir').mockReturnValue(dir)
  const sessionDir = path.join(dir, '.grok', 'sessions', 'workspace', 'sid')
  mkdirSync(sessionDir, { recursive: true })
  const text =
    JSON.stringify({
      params: {
        _meta: { agentTimestampMs: 1000 },
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
          _meta: { promptIndex: 0 },
        },
      },
    }) + '\n'
  const file = path.join(sessionDir, 'updates.jsonl')
  writeFileSync(file, text)
  return { file, text, sessionDir }
}
it('posts an exact batch and replays identical ordinal ids', async () => {
  const { file, sessionDir } = fixture()
  const options = sink()
  const op = {
    kind: 'ingest' as const,
    sessionId: 'sid',
    sourceEvent: 'SessionEnd',
    finalize: true,
  }
  await ingestSession(op, options)
  await ingestSession(op, options)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(bodies[0]).toEqual({
    session_key: 'grok-build:sid',
    agent: 'rivet-grok',
    channel: 'grok-build',
    title: 'Grok Build session',
    finalize: true,
    settings: {
      source: 'grok-jsonl',
      sessionId: 'sid',
      sessionDir,
      modelId: null,
      agentName: null,
      triggerEvent: 'SessionEnd',
    },
    messages: [
      {
        event_id: 'grok-build:sid:0',
        role: 'user',
        content: 'hello',
        created_at: '1970-01-01T00:00:01.000Z',
        metadata: {
          source: 'grok-jsonl',
          event_id: 'grok-build:sid:0',
          ordinal: 0,
          session_jsonl_path: file,
          session_jsonl_line: 0,
          event_ts: '1970-01-01T00:00:01.000Z',
          sessionUpdate: 'user_message_chunk',
          promptIndex: 0,
        },
      },
    ],
  })
})
it.each(['spooled', 'failed'] as const)('durability: %s', async (mode) => {
  fixture()
  const options = sink(true, mode === 'failed')
  const ingest = ingestSession({ kind: 'ingest', sessionId: 'sid' }, options)
  if (mode === 'failed') await expect(ingest).rejects.toThrow('spool failed')
  else {
    await ingest
    expect(readdirSync(options.spoolDir)).toHaveLength(1)
  }
  const state = JSON.parse(
    readFileSync(path.join(dir, '.rivetos', 'capture-state', 'sid.json'), 'utf8'),
  )
  expect(state.lastStatus).toBe(mode === 'failed' ? 'failure' : 'success')
})
