import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventIdFromContent } from '@rivetos/capture-core'

vi.mock('pg', () => {
  class Pool {
    constructor() {
      throw new Error('pg.Pool must not be constructed on the den path')
    }
  }
  return { default: { Pool }, Pool }
})

import { ingestHookEvent, ingestTranscript } from './transcript-capture.js'

const denEnv: NodeJS.ProcessEnv = {
  RIVETOS_CAPTURE_TRANSPORT: 'den',
  RIVET_DEN_URL: 'https://127.0.0.1:5174',
}

interface PostedMessage {
  event_id: string
  role: string
  content: string
  tool_name?: string
  tool_result?: string
  metadata?: {
    session_jsonl_path?: unknown
    session_jsonl_line?: unknown
  }
}
interface PostedBatch {
  session_key: string
  task_id?: string
  finalize?: boolean
  messages: PostedMessage[]
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function transcript(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
  dirs.push(dir)
  const file = path.join(dir, 'sess.jsonl')
  const lines = [
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-1',
      uuid: 'u1',
      timestamp: '2026-09-01T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      uuid: 'a1',
      timestamp: '2026-09-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-1',
      uuid: 'u2',
      timestamp: '2026-09-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      timestamp: '2026-09-01T00:00:03.000Z',
      message: { role: 'assistant', content: 'no uuid' },
    }),
  ]
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function okFetch(bodies: PostedBatch[]): typeof fetch {
  return (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as PostedBatch)
    return new Response(
      JSON.stringify({
        ok: true,
        conversation_id: 'conv-1',
        inserted: bodies[bodies.length - 1]?.messages.length ?? 0,
        skipped: 0,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

describe('claude-cli den transport', () => {
  it('uses stable event ids and jsonl pointers for a transcript', async () => {
    const file = transcript()
    const bodies: PostedBatch[] = []
    const fetch = okFetch(bodies)
    const first = await ingestTranscript({
      transcriptPath: file,
      env: denEnv,
      fetch,
      taskId: 'cccccccc-3333-4333-8333-cccccccccccc',
    })
    const second = await ingestTranscript({ transcriptPath: file, env: denEnv, fetch })
    expect(first.sessionKey).toBe('claude-code:sess-1')
    expect(second.sessionKey).toBe(first.sessionKey)
    const ids = bodies[0]?.messages.map((m) => m.event_id)
    expect(bodies[1]?.messages.map((m) => m.event_id)).toEqual(ids)
    expect(ids).toEqual([
      'claude-code:sess-1:a1',
      eventIdFromContent({
        sessionKey: 'claude-code:sess-1',
        role: 'assistant',
        content: 'no uuid',
      }),
      'claude-code:sess-1:tool:toolu_1',
      eventIdFromContent({ sessionKey: 'claude-code:sess-1', role: 'user', content: 'hello' }),
    ])
    expect(bodies[0]?.task_id).toBe('cccccccc-3333-4333-8333-cccccccccccc')
    expect(bodies[0]?.finalize).toBeUndefined()
    const tool = bodies[0]?.messages[2]
    expect(tool?.tool_name).toBe('Bash')
    expect(tool?.tool_result).toBe('ok')
    expect(tool?.metadata?.session_jsonl_path).toBe(path.resolve(file))
    expect(tool?.metadata?.session_jsonl_line).toBe(2)
    expect(bodies[0]?.messages[3]?.metadata?.session_jsonl_line).toBe(0)
    const pg = (await import('pg')).default as { Pool: new () => unknown }
    expect(() => new pg.Pool()).toThrow(/pg\.Pool/)
  })

  it('finalizes on SessionEnd', async () => {
    const file = transcript()
    const bodies: PostedBatch[] = []
    await ingestTranscript({
      transcriptPath: file,
      env: denEnv,
      fetch: okFetch(bodies),
      markInactive: true,
      event: 'SessionEnd',
    })
    expect(bodies[0]?.finalize).toBe(true)
  })

  it('ids a hook event from the spool stem and sends uncapped content', async () => {
    const bodies: PostedBatch[] = []
    const prompt = 'p'.repeat(16_001)
    await ingestHookEvent({
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt },
      idempotencyKey: 'stem1',
      env: denEnv,
      fetch: okFetch(bodies),
    })
    expect(bodies[0]?.session_key).toBe('claude-code:sess-1')
    expect(bodies[0]?.messages[0]?.event_id).toBe('claude-code:sess-1:hook:stem1')
    expect(bodies[0]?.messages[0]?.content).toBe(prompt)
    expect(bodies[0]?.messages[0]?.metadata?.session_jsonl_path).toBeUndefined()
  })
})
