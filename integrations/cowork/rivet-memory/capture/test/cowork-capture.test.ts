import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCaptureWriter } from '@rivetos/capture-core'
import {
  backfillTranscript,
  captureFromHook,
  consumeTranscriptChunk,
  deliverBatch,
  discoverTasks,
  emptyState,
  encodeFrame,
  handleMcp,
  hookBatch,
  messagesFromHook,
  messagesFromTranscript,
  pickTitle,
  pushFrames,
  sessionPart,
  taskDirectoryCandidates,
} from '../src/cowork-capture.js'

describe('cowork capture ids', () => {
  it('falls back to session_id when cliSessionId is absent', () => {
    expect(sessionPart({ session_id: 'cli-1' })).toBe('cli-1')
    expect(sessionPart({})).toBe('unknown')
    expect(sessionPart({ cliSessionId: 'task-1', session_id: 'other' })).toBe('task-1')
  })

  it('shares a tool event id between a hook and a later transcript result', () => {
    const hook = messagesFromHook({
      hook_event_name: 'PostToolUse',
      session_id: 'sess',
      tool_name: 'Bash',
      tool_use_id: 'tu1',
      tool_input: { cmd: 'ls' },
      tool_response: 'ok',
    })
    expect(hook[0]?.event_id).toBe('cowork:sess:tool:tu1')
    expect(hook[0]?.tool_result).toBe('ok')

    const pending = messagesFromTranscript(
      [
        JSON.stringify({
          type: 'assistant',
          uuid: 'u1',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { cmd: 'ls' } }] },
        }),
      ],
      'sess',
    )
    expect(pending.messages[0]?.event_id).toBe('cowork:sess:tool:tu1')
    expect(pending.messages[0]?.metadata).toMatchObject({ pending_result: true, tool_use_id: 'tu1' })

    const filled = messagesFromTranscript(
      [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        }),
      ],
      'sess',
      new Map([['tu1', { name: 'Bash' }]]),
    )
    expect(filled.messages[0]?.event_id).toBe('cowork:sess:tool:tu1')
    expect(filled.messages[0]?.tool_result).toBe('ok')
  })

  it('uses a hook hash when the prompt has no uuid, and the transcript uuid when it has one', () => {
    const hook = messagesFromHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess', prompt: 'hello' })
    expect(hook[0]?.event_id).toMatch(/^cowork:sess:hook:/)
    const withId = messagesFromHook({
      hook_event_name: 'UserPromptSubmit',
      cliSessionId: 'sess',
      prompt: 'hello',
      uuid: 'abc',
    })
    expect(withId[0]?.event_id).toBe('cowork:sess:abc')
    const transcript = messagesFromTranscript(
      [JSON.stringify({ type: 'user', uuid: 'abc', message: { role: 'user', content: 'hello' } })],
      'sess',
    )
    expect(transcript.messages[0]?.event_id).toBe('cowork:sess:abc')
  })

  it('does not import a partial last line and records the task sandbox cwd', () => {
    const chunk = '{"type":"user","uuid":"a","message":{"content":"hi"}}\n{"type":"user","uuid":"b","mess'
    const taken = consumeTranscriptChunk(chunk)
    expect(taken.lines).toEqual(['{"type":"user","uuid":"a","message":{"content":"hi"}}'])
    expect(taken.consumed).toBeLessThan(Buffer.byteLength(chunk))

    const cwd = '/Users/me/Claude/local-agent-mode-sessions/local_task/outputs'
    const batch = hookBatch({ hook_event_name: 'UserPromptSubmit', session_id: 'sess', prompt: 'hi', cwd })
    expect(batch?.settings?.cwd).toBe(cwd)
    expect(batch?.created_at).toBeUndefined()
  })

  it('picks a title from metadata, then the ai title, then the prompt', () => {
    expect(pickTitle('From meta', 'From ai', 'prompt')).toBe('From meta')
    expect(pickTitle(undefined, 'From ai', 'prompt')).toBe('From ai')
    expect(pickTitle(undefined, undefined, 'prompt')).toBe('prompt')
  })
})

describe('cowork backfill cursor', () => {
  it('advances past complete lines only and keeps a pending tool across runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-cap-'))
    const taskDir = join(dir, 'local_task')
    const projects = join(taskDir, '.claude', 'projects', 'slug')
    mkdirSync(projects, { recursive: true })
    const id = '11111111-1111-1111-1111-111111111111'
    const transcript = join(projects, `${id}.jsonl`)
    const meta = join(dir, 'local_task.json')
    writeFileSync(
      meta,
      JSON.stringify({
        cliSessionId: id,
        title: 'Pack the crate',
        cwd: `${taskDir}/outputs`,
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_100_000,
      }),
    )
    const line1 = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { cmd: 'ls' } }],
      },
    })
    writeFileSync(transcript, `${line1}\n{"partial"`)
    const [task] = discoverTasks([dir])
    expect(task?.transcriptPath).toBe(transcript)
    const state = emptyState()
    const first = backfillTranscript(task!, state)
    expect(first?.messages).toHaveLength(1)
    expect(first?.messages[0]?.metadata).toMatchObject({ pending_result: true })
    expect(first?.title).toBe('Pack the crate')
    expect(first?.settings?.cwd).toBe(`${taskDir}/outputs`)
    expect(first?.created_at).toBe(new Date(1_700_000_000_000).toISOString())
    expect(first?.updated_at).toBe(new Date(1_700_000_100_000).toISOString())
    expect(state.pending.tu9?.name).toBe('Bash')
    const offset = state.offsets[transcript]
    const second = backfillTranscript(task!, state)
    expect(second).toBeUndefined()
    expect(state.offsets[transcript]).toBe(offset)

    const line2 = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'listed' }] },
    })
    writeFileSync(transcript, `${line1}\n${line2}\n`)
    const third = backfillTranscript(task!, state)
    expect(third?.messages.map((m) => m.event_id)).toEqual([`cowork:${id}:tool:tu9`])
    expect(third?.messages[0]?.tool_result).toBe('listed')
    expect(state.pending.tu9).toBeUndefined()
  })
})

describe('cowork mcp framing', () => {
  it('answers initialize and a capture tool call', async () => {
    const init = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const fed = pushFrames(Buffer.alloc(0), init.subarray(0, 10))
    expect(fed.messages).toHaveLength(0)
    const rest = pushFrames(fed.buf, init.subarray(10))
    expect(rest.messages).toHaveLength(1)
    const response = await handleMcp(rest.messages[0], {
      onCapture: async () => ({ inserted: 1, skipped: 0 }),
    })
    expect(response?.result).toMatchObject({ serverInfo: { name: 'rivet-cowork-capture' } })

    const call = await handleMcp(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'memory_capture_event',
          arguments: { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' },
        },
      },
      { onCapture: async () => ({ inserted: 1, skipped: 0 }) },
    )
    expect(JSON.stringify(call)).toContain('inserted 1')
  })
})

describe('desktop task layout', () => {
  const taskUuid = 'af1d0ad3-ab84-4a4d-8c7e-d344b9e7ee17'
  const cli = '55555555-5555-5555-5555-555555555555'

  function layout(): { root: string; transcript: string; taskDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'cowork-desktop-'))
    const org = join(root, 'local-agent-mode-sessions', 'acct', 'org')
    const taskDir = join(org, taskUuid.slice(0, 8))
    const projects = join(taskDir, '.claude', 'projects', 'session')
    mkdirSync(projects, { recursive: true })
    const transcript = join(projects, `${cli}.jsonl`)
    writeFileSync(
      join(org, `local_${taskUuid}.json`),
      JSON.stringify({
        sessionId: `local_${taskUuid}`,
        cliSessionId: cli,
        title: 'Desktop shape',
        cwd: `${taskDir}/outputs`,
        isArchived: false,
        userSelectedFolders: ['/work/real-repo'],
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_100_000,
      }),
    )
    return { root, transcript, taskDir }
  }

  it('keys on cliSessionId and finds the 8-hex task directory', () => {
    const { root, transcript, taskDir } = layout()
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', uuid: 'u-prompt', message: { role: 'user', content: 'ship it' } })}\n`,
    )
    const [task] = discoverTasks([root])
    expect(task?.cliSessionId).toBe(cli)
    expect(task?.transcriptPath).toBe(transcript)
    expect(task?.folders).toEqual(['/work/real-repo'])
    expect(task?.cwd).toBe(`${taskDir}/outputs`)
    const batch = backfillTranscript(task!, emptyState())
    expect(batch?.session_key).toBe(`cowork:${cli}`)
    expect(batch?.settings?.folders).toEqual(['/work/real-repo'])
    expect(batch?.messages.map((message) => message.event_id)).toEqual([`cowork:${cli}:u-prompt`])
  })

  it('tries the older local_ directory before the short uuid', () => {
    const meta = join('/org', `local_${taskUuid}.json`)
    expect(taskDirectoryCandidates(meta, `/org/${taskUuid.slice(0, 8)}/outputs`)).toEqual([
      join('/org', `local_${taskUuid}`),
      join('/org', taskUuid.slice(0, 8)),
    ])
  })

  it('a hook prompt then a transcript pass stores one row', () => {
    const { root, transcript } = layout()
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-prompt',
      message: { role: 'user', content: 'ship it' },
    })
    writeFileSync(transcript, '')
    const state = emptyState()
    expect(
      captureFromHook(
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: cli,
          prompt: 'ship it',
          cwd: '/private/var/empty',
          transcript_path: transcript,
        },
        state,
      ),
    ).toBeUndefined()
    writeFileSync(transcript, `${line}\n`)
    const hooked = captureFromHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: cli,
        prompt: 'ship it',
        cwd: '/private/var/empty',
        transcript_path: transcript,
      },
      state,
    )
    expect(hooked?.messages).toHaveLength(1)
    expect(hooked?.messages[0]?.event_id).toBe(`cowork:${cli}:u-prompt`)
    expect(hooked?.messages[0]?.metadata).toMatchObject({ source: 'cowork-transcript' })
    expect(hooked?.settings?.cwd).not.toBe('/private/var/empty')
    expect(hooked?.settings?.folders).toEqual(['/work/real-repo'])
    const [task] = discoverTasks([root])
    expect(backfillTranscript(task!, state)).toBeUndefined()
  })

  it('a Stop hook then a transcript pass stores the assistant reply once', () => {
    const { root, transcript } = layout()
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u-reply',
      message: { role: 'assistant', content: 'shipped' },
    })
    writeFileSync(transcript, `${line}\n`)
    const state = emptyState()
    const hooked = captureFromHook(
      {
        hook_event_name: 'Stop',
        session_id: cli,
        cwd: '/private/var/empty',
        last_assistant_message: 'shipped',
        transcript_path: transcript,
      },
      state,
    )
    expect(hooked?.messages).toEqual([
      expect.objectContaining({
        event_id: `cowork:${cli}:u-reply`,
        role: 'assistant',
        content: 'shipped',
      }),
    ])
    const [task] = discoverTasks([root])
    expect(backfillTranscript(task!, state)).toBeUndefined()
  })
})

describe('deliverBatch', () => {
  it('spools when the den cannot be reached', async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), 'cowork-spool-'))
    const writer = createCaptureWriter({
      denUrl: 'http://127.0.0.1:9',
      spoolDir,
      fetch: async () => {
        throw new Error('econnrefused')
      },
    })
    const batch = hookBatch({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess',
      prompt: 'keep me',
    })
    const result = await deliverBatch(batch, writer)
    expect(result.spooled).toBe(true)
    expect(readdirSync(spoolDir).some((name) => name.endsWith('.json'))).toBe(true)
  })
})
