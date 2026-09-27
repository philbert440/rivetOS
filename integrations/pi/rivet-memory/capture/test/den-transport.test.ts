import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
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
  dir = mkdtempSync(path.join(os.tmpdir(), 'pi-den-'))
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
import { ingestMessages, ingestFileFromCursor, loadCaptureState } from '../src/pi-memory-capture.js'

it('posts the exact batch with uncapped content, auxiliary lengths, pointers and finalize', async () => {
  const content = 'x'.repeat(17000)
  await ingestMessages(
    null,
    'sid',
    [
      {
        eventId: 'pi:sid:line',
        role: 'assistant',
        content,
        toolArgs: content,
        reasoning: content,
        lineIndex: 3,
        createdAt: '2026-09-27T00:00:00Z',
      },
    ],
    { ...sink(), title: 'Title', transcriptPath: '/session.jsonl', finalize: true },
  )
  expect(bodies).toEqual([
    {
      session_key: 'pi:sid',
      agent: 'rivet-deepseek',
      channel: 'pi',
      title: 'Title',
      finalize: true,
      settings: {
        source: 'pi-session',
        sessionId: 'sid',
        cwd: null,
        model: null,
        provider: null,
        thinkingLevel: null,
        triggerEvent: 'ingest',
        session_jsonl_path: '/session.jsonl',
      },
      messages: [
        {
          event_id: 'pi:sid:line',
          role: 'assistant',
          content,
          tool_args: content.slice(0, 16000),
          created_at: '2026-09-27T00:00:00Z',
          metadata: {
            source: 'pi-session',
            event_id: 'pi:sid:line',
            session_jsonl_path: '/session.jsonl',
            session_jsonl_line: 3,
            reasoning: content.slice(0, 16000),
            full_reasoning_length: 17000,
            full_tool_args_length: 17000,
            truncated: true,
          },
        },
      ],
    },
  ])
})

it.each(['delivered', 'spooled', 'failed'] as const)('cursor acknowledgment: %s', async (mode) => {
  vi.stubEnv('RIVETOS_PI_CAPTURE_STATE', path.join(dir, 'state.json'))
  const file = path.join(dir, 'session.jsonl')
  const text =
    [
      JSON.stringify({ type: 'session', version: 3, id: 'sid' }),
      JSON.stringify({
        type: 'message',
        id: 'line',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
    ].join('\n') + '\n'
  writeFileSync(file, text)
  const options = sink(mode !== 'delivered', mode === 'failed')
  const ingest = ingestFileFromCursor(file, null, options)
  if (mode === 'failed') {
    await expect(ingest).rejects.toThrow('spool failed')
    expect(loadCaptureState().cursors[file]).toBeUndefined()
  } else {
    await ingest
    expect(loadCaptureState().cursors[file].offset).toBe(Buffer.byteLength(text))
    if (mode === 'spooled') expect(readdirSync(options.spoolDir)).toHaveLength(1)
    if (mode === 'delivered') {
      await ingestFileFromCursor(file, null, { ...options, finalize: true })
      expect(bodies[1].finalize).toBe(true)
    }
  }
  expect(bodies[0].messages[0].metadata).toMatchObject({
    session_jsonl_path: file,
    session_jsonl_line: 1,
  })
})
