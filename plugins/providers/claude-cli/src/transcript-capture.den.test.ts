import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentTupleHash } from '@rivetos/capture-core'

vi.mock('pg', () => {
  class Pool {
    constructor() {
      // pg is still statically imported. This only proves no pool was constructed.
      throw new Error('no pool constructed')
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
    source?: unknown
    session_jsonl_path?: unknown
    session_jsonl_line?: unknown
    full_content_length?: number
    truncated?: boolean
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
      `claude-code:sess-1:occ:${contentTupleHash({ role: 'assistant', content: 'no uuid' })}:0`,
      'claude-code:sess-1:tool:toolu_1',
      'claude-code:sess-1:u1',
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
    expect(() => new pg.Pool()).toThrow(/no pool constructed/)
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

  it('ids an unreadable hook from the spool stem and lets the writer cap it', async () => {
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
    expect(bodies[0]?.messages[0]?.content).toBe('p'.repeat(16_000))
    expect(bodies[0]?.messages[0]?.metadata?.session_jsonl_path).toBeUndefined()
    expect(bodies[0]?.messages[0]?.metadata).toMatchObject({
      source: 'hook-only',
      full_content_length: 16_001,
      truncated: true,
    })
  })

  it('gives two identical user turns distinct ids that survive a second ingest', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    const user = () =>
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'continue' },
      })
    writeFileSync(
      file,
      [
        user(),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-1',
          uuid: 'a1',
          message: { role: 'assistant', content: 'ok' },
        }),
        user(),
      ].join('\n') + '\n',
    )
    const bodies: PostedBatch[] = []
    const fetch = okFetch(bodies)
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch })
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch })
    const ids = bodies[0]?.messages.filter((m) => m.role === 'user').map((m) => m.event_id) ?? []
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]).toMatch(/:occ:[0-9a-f]{64}:0$/)
    expect(ids[1]).toMatch(/:occ:[0-9a-f]{64}:1$/)
    expect(ids[0]?.slice(0, ids[0].lastIndexOf(':'))).toBe(ids[1]?.slice(0, ids[1].lastIndexOf(':')))
    expect(bodies[1]?.messages.filter((m) => m.role === 'user').map((m) => m.event_id)).toEqual(ids)
  })

  it('reconciles a hook prompt with the transcript in either order', async () => {
    const write = (): string => {
      const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
      dirs.push(dir)
      const file = path.join(dir, 'sess.jsonl')
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: 'user',
            sessionId: 'sess-1',
            uuid: 'u1',
            message: { role: 'user', content: 'continue' },
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'sess-1',
            uuid: 'a1',
            message: { role: 'assistant', content: 'ok' },
          }),
          JSON.stringify({
            type: 'user',
            sessionId: 'sess-1',
            uuid: 'u2',
            message: { role: 'user', content: 'continue' },
          }),
        ].join('\n') + '\n',
      )
      return file
    }
    const userId = (bodies: PostedBatch[]): string =>
      bodies
        .flatMap((batch) => batch.messages)
        .filter((m) => m.role === 'user')
        .map((m) => m.event_id)
        .at(-1) ?? ''
    const hookFirstFile = write()
    const hookFirst: PostedBatch[] = []
    await ingestHookEvent({
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
        prompt: 'continue',
        transcript_path: hookFirstFile,
      },
      idempotencyKey: 'stem-a',
      env: denEnv,
      fetch: okFetch(hookFirst),
    })
    await ingestTranscript({ transcriptPath: hookFirstFile, env: denEnv, fetch: okFetch(hookFirst) })
    const hookId = hookFirst[0]?.messages[0]?.event_id
    expect(hookId).toBe('claude-code:sess-1:u2')
    expect(hookFirst[0]?.messages[0]?.metadata).toMatchObject({ source: 'claude-code-hook' })
    expect(userId(hookFirst)).toBe(hookId)

    const transcriptFirstFile = write()
    const transcriptFirst: PostedBatch[] = []
    await ingestTranscript({
      transcriptPath: transcriptFirstFile,
      env: denEnv,
      fetch: okFetch(transcriptFirst),
    })
    await ingestHookEvent({
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
        prompt: 'continue',
        transcript_path: transcriptFirstFile,
      },
      idempotencyKey: 'stem-b',
      env: denEnv,
      fetch: okFetch(transcriptFirst),
    })
    const transcriptUser = transcriptFirst[0]?.messages.filter((m) => m.role === 'user').at(-1)?.event_id
    expect(transcriptFirst.at(-1)?.messages[0]?.event_id).toBe(transcriptUser)
  })

  it('assigns occ ids to tool rows that have no tool_use id', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'a-tools',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { path: 'a' } },
            { type: 'tool_use', name: 'Read', input: { path: 'a' } },
          ],
        },
      }) + '\n',
    )
    const bodies: PostedBatch[] = []
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch: okFetch(bodies) })
    const ids = bodies[0]?.messages.map((m) => m.event_id) ?? []
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/:occ:[0-9a-f]{64}:0$/)
    expect(ids[1]).toMatch(/:occ:[0-9a-f]{64}:1$/)
    expect(ids[0]).not.toContain(':tool:')
    expect(bodies[0]?.messages[0]).toMatchObject({
      role: 'tool',
      tool_name: 'Read',
      content: '[tool call] Read',
    })
  })

  it('uses an occurrence id when a tool transcript cannot be read', async () => {
    const bodies: PostedBatch[] = []
    await ingestHookEvent({
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
        transcript_path: path.join(tmpdir(), 'missing-claude-transcript.jsonl'),
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'ok',
      },
      idempotencyKey: 'stem-missing',
      env: denEnv,
      fetch: okFetch(bodies),
      pollForMs: 120,
      pollMs: 40,
    })
    const hash = contentTupleHash({
      role: 'tool',
      content: '[tool call] Bash',
      toolName: 'Bash',
      toolArgs: { command: 'ls' },
    })
    expect(bodies[0]?.messages[0]?.event_id).toBe(`claude-code:sess-1:occ:${hash}:0`)
    expect(bodies[0]?.messages[0]?.metadata).toMatchObject({ source: 'claude-code-hook' })
  })

  function readCall(id: string | undefined, input: unknown = { file_path: 'a' }): string {
    return JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      uuid: `a-${id ?? 'none'}`,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', ...(id ? { id } : {}), name: 'Read', input }],
      },
    })
  }

  async function postTool(file: string, bodies: PostedBatch[], stem: string): Promise<void> {
    await ingestHookEvent({
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
        transcript_path: file,
        tool_name: 'Read',
        tool_input: { file_path: 'a' },
        tool_response: 'ok',
      },
      idempotencyKey: stem,
      env: denEnv,
      fetch: okFetch(bodies),
      pollMs: 20,
      pollForMs: 1_000,
    })
  }

  it('shares the native tool id when PostToolUse runs before Stop', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(file, `${readCall('toolu_1')}\n`)
    const bodies: PostedBatch[] = []
    await postTool(file, bodies, 'stem-tool-hook-first')
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch: okFetch(bodies) })
    const hookId = bodies[0]?.messages[0]?.event_id
    const stopId = bodies[1]?.messages.find((m) => m.role === 'tool')?.event_id
    expect(hookId).toBe('claude-code:sess-1:tool:toolu_1')
    expect(stopId).toBe(hookId)
    expect(bodies[0]?.messages[0]?.metadata).toMatchObject({ source: 'claude-code-hook' })
  })

  it('shares the native tool id when Stop runs before PostToolUse', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(file, `${readCall('toolu_1')}\n`)
    const bodies: PostedBatch[] = []
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch: okFetch(bodies) })
    await postTool(file, bodies, 'stem-tool-stop-first')
    const stopId = bodies[0]?.messages.find((m) => m.role === 'tool')?.event_id
    expect(stopId).toBe('claude-code:sess-1:tool:toolu_1')
    expect(bodies.at(-1)?.messages[0]?.event_id).toBe(stopId)
  })

  it('gives two identical Read calls distinct native ids on both paths', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(file, `${readCall('toolu_1')}\n`)
    const bodies: PostedBatch[] = []
    await postTool(file, bodies, 'stem-read-1')
    writeFileSync(file, `${readCall('toolu_1')}\n${readCall('toolu_2')}\n`)
    await postTool(file, bodies, 'stem-read-2')
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch: okFetch(bodies) })
    expect(bodies[0]?.messages[0]?.event_id).toBe('claude-code:sess-1:tool:toolu_1')
    expect(bodies[1]?.messages[0]?.event_id).toBe('claude-code:sess-1:tool:toolu_2')
    expect(bodies[2]?.messages.filter((m) => m.role === 'tool').map((m) => m.event_id)).toEqual([
      'claude-code:sess-1:tool:toolu_1',
      'claude-code:sess-1:tool:toolu_2',
    ])
  })

  it('uses the occurrence id when the matching Read has no tool_use id', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(file, `${readCall(undefined)}\n`)
    const bodies: PostedBatch[] = []
    await postTool(file, bodies, 'stem-read-occ')
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch: okFetch(bodies) })
    const hookId = bodies[0]?.messages[0]?.event_id ?? ''
    expect(hookId).toMatch(/:occ:[0-9a-f]{64}:0$/)
    expect(hookId).not.toContain(':tool:')
    expect(bodies[1]?.messages.find((m) => m.role === 'tool')?.event_id).toBe(hookId)
  })

  it('waits until the matching prompt appears even when an assistant row follows it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    const user = (uuid: string, content: string) =>
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-1',
        uuid,
        message: { role: 'user', content },
      })
    const assistant = (uuid: string) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        uuid,
        message: { role: 'assistant', content: 'ok' },
      })
    writeFileSync(file, `${user('u0', 'older')}\n${assistant('a0')}\n`)
    const bodies: PostedBatch[] = []
    const pending = ingestHookEvent({
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
        prompt: 'continue',
        transcript_path: file,
      },
      idempotencyKey: 'stem-wait',
      env: denEnv,
      fetch: okFetch(bodies),
      pollMs: 20,
      pollForMs: 1_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    writeFileSync(
      file,
      [user('u0', 'older'), assistant('a0'), user('u2', 'continue'), assistant('a2')].join('\n') +
        '\n',
    )
    await pending
    expect(bodies[0]?.messages[0]?.event_id).toBe('claude-code:sess-1:u2')
    expect(bodies[0]?.messages[0]?.metadata).toMatchObject({ source: 'claude-code-hook' })
  })

  it('binds a prompt when the assistant response is already present', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-1',
          uuid: 'u1',
          message: { role: 'user', content: 'continue' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-1',
          uuid: 'a-late',
          message: { role: 'assistant', content: 'already moved on' },
        }),
      ].join('\n') + '\n',
    )
    const bodies: PostedBatch[] = []
    await ingestHookEvent({
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
        prompt: 'continue',
        transcript_path: file,
      },
      idempotencyKey: 'stem-late',
      env: denEnv,
      fetch: okFetch(bodies),
      pollMs: 20,
      pollForMs: 80,
    })
    expect(bodies[0]?.messages).toHaveLength(1)
    expect(bodies[0]?.messages[0]?.event_id).toBe('claude-code:sess-1:u1')
    expect(bodies[0]?.messages[0]?.metadata).toMatchObject({ source: 'claude-code-hook' })
  })

  function multiRead(ids: Array<{ id: string; path: string }>): string {
    return JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      uuid: 'a-multi',
      message: {
        role: 'assistant',
        content: ids.map((tool) => ({
          type: 'tool_use',
          id: tool.id,
          name: 'Read',
          input: { file_path: tool.path },
        })),
      },
    })
  }

  it('binds PostToolUse(Read a) then Stop to exactly t1 and t2', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(
      file,
      `${multiRead([
        { id: 't1', path: 'a' },
        { id: 't2', path: 'b' },
      ])}\n`,
    )
    const bodies: PostedBatch[] = []
    await ingestHookEvent({
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
        transcript_path: file,
        tool_name: 'Read',
        tool_input: { file_path: 'a' },
        tool_response: 'ok',
      },
      idempotencyKey: 'multi-a',
      env: denEnv,
      fetch: okFetch(bodies),
      pollMs: 20,
      pollForMs: 200,
    })
    await ingestTranscript({ transcriptPath: file, env: denEnv, fetch: okFetch(bodies) })
    expect(bodies[0]?.messages).toHaveLength(1)
    expect(bodies[0]?.messages[0]?.event_id).toBe('claude-code:sess-1:tool:t1')
    expect(bodies[1]?.messages.filter((m) => m.role === 'tool').map((m) => m.event_id)).toEqual([
      'claude-code:sess-1:tool:t1',
      'claude-code:sess-1:tool:t2',
    ])
    const ids = new Set(bodies.flatMap((batch) => batch.messages.map((m) => m.event_id)))
    expect([...ids].sort()).toEqual(['claude-code:sess-1:tool:t1', 'claude-code:sess-1:tool:t2'])
  })

  it('resolves two identical Reads to their own tool_use_ids', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(
      file,
      `${multiRead([
        { id: 't1', path: 'a' },
        { id: 't2', path: 'a' },
      ])}\n`,
    )
    const bodies: PostedBatch[] = []
    for (const id of ['t1', 't2']) {
      await ingestHookEvent({
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'sess-1',
          transcript_path: file,
          tool_name: 'Read',
          tool_input: { file_path: 'a' },
          tool_response: 'ok',
          tool_use_id: id,
        },
        idempotencyKey: `same-${id}`,
        env: denEnv,
        fetch: okFetch(bodies),
        pollMs: 20,
        pollForMs: 200,
      })
    }
    expect(bodies[0]?.messages[0]?.event_id).toBe('claude-code:sess-1:tool:t1')
    expect(bodies[1]?.messages[0]?.event_id).toBe('claude-code:sess-1:tool:t2')
  })

  it('binds a payload with no tool_use_id to the last matching tool_use', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-den-'))
    dirs.push(dir)
    const file = path.join(dir, 'sess.jsonl')
    const later = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      uuid: 'a-done',
      message: { role: 'assistant', content: 'done' },
    })
    writeFileSync(
      file,
      `${multiRead([
        { id: 't1', path: 'a' },
        { id: 't2', path: 'a' },
      ])}\n${later}\n`,
    )
    const bodies: PostedBatch[] = []
    await ingestHookEvent({
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
        transcript_path: file,
        tool_name: 'Read',
        tool_input: { file_path: 'a' },
        tool_response: 'ok',
      },
      idempotencyKey: 'no-id',
      env: denEnv,
      fetch: okFetch(bodies),
      pollMs: 20,
      pollForMs: 200,
    })
    expect(bodies[0]?.messages).toHaveLength(1)
    expect(bodies[0]?.messages[0]?.event_id).toBe('claude-code:sess-1:tool:t2')
    expect(bodies[0]?.messages[0]?.metadata).toMatchObject({ source: 'claude-code-hook' })
  })
})
