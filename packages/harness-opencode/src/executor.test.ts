/**
 * OpencodeExecutor tests — the shared HarnessExecutor conformance suite plus
 * opencode specifics, all driven by a FAKE `opencode` binary writing an
 * opencode-shaped transcript into a throwaway data dir. The real
 * binary is never invoked: no provider tokens, no live store, no
 * `~/.local/share/opencode`.
 *
 * Covered: lifecycle, kill → 'killed', result-never-rejects (nonzero exit,
 * malformed stream, missing session id), post-hoc usage reconcile (including
 * the user-role row it must ignore), canonical session id on turn.end,
 * `--session` resume on steered turns, the resume-rejected fallback, the #467
 * env contract, and the prompt scaffold.
 */

import { afterAll, describe, expect, it } from 'vitest'
import type { TaskEvent } from '@rivetos/types'
import {
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalOpencodeSessionId,
  OpencodeExecutor,
  OPENCODE_HARNESS_ID,
  renderResumeTranscript,
} from './executor.js'
import {
  cleanupFakeOpencode,
  makeFakeOpencode,
  successLines,
  type FakeOpencode,
} from './test/fake-opencode.js'
import {
  runExecutorConformance,
  makeConformanceSpec,
} from '../../core/src/domain/task/test/executor-conformance.js'

afterAll(() => {
  cleanupFakeOpencode()
})

const SESSION = 'ses_11111111111111111111111111'

function makeExecutor(fake: FakeOpencode): OpencodeExecutor {
  return new OpencodeExecutor({
    binary: fake.binary,
    cwd: fake.cwd,
    opencodeHome: fake.home,
    // Tests must not sit through the real 10s cleanup budget.
    killGraceMs: 200,
  })
}

function successFake(text = 'All done.'): FakeOpencode {
  return makeFakeOpencode({ lines: successLines(text, SESSION), sessionId: SESSION })
}

async function drain(events: AsyncIterable<TaskEvent>): Promise<TaskEvent[]> {
  const seen: TaskEvent[] = []
  for await (const e of events) seen.push(e)
  return seen
}

// ---------------------------------------------------------------------------
// Shared conformance suite
// ---------------------------------------------------------------------------

runExecutorConformance('opencode', {
  makeSuccess: () => ({ executor: makeExecutor(successFake()), spec: makeConformanceSpec() }),
  makeError: () => ({
    executor: makeExecutor(
      makeFakeOpencode({ lines: [], exitCode: 1, stderr: 'error: provider auth failed' }),
    ),
    spec: makeConformanceSpec(),
  }),
  makeSlow: () => ({
    executor: makeExecutor(makeFakeOpencode({ slow: true })),
    spec: makeConformanceSpec(),
  }),
})

// ---------------------------------------------------------------------------
// opencode specifics
// ---------------------------------------------------------------------------

describe('OpencodeExecutor', () => {
  it('reports the promised capability set', () => {
    expect(makeExecutor(successFake()).capabilities()).toEqual({
      steerable: true,
      multiTurn: true,
      structuredStream: true,
      usageInResult: true,
      sessionIdCapture: true,
      slashCommands: false,
      effortSelection: true,
      mcpInjection: 'persistent-config',
    })
  })

  it('registers under the harness id', () => {
    expect(OPENCODE_HARNESS_ID).toBe('opencode')
    expect(makeExecutor(successFake()).name).toBe('opencode')
  })

  it('translates JSON events into den events and reconciles usage off disk', async () => {
    const fake = makeFakeOpencode({
      lines: successLines('All done.', SESSION),
      sessionId: SESSION,
      usage: [
        { inputOther: 100, output: 25, inputCacheRead: 10 },
        { inputOther: 40, output: 5, inputCacheRead: 0 },
      ],
    })
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const den = events.filter((e) => e.type === 'den').map((e) => e.event)
    expect(den).toContainEqual({ type: 'message.agent', text: 'All done.' })
    expect(den).toContainEqual({ type: 'tool.start', tool: 'bash' })
    expect(den).toContainEqual({ type: 'tool.end', tool: 'bash' })

    expect(events.find((e) => e.type === 'turn.end')).toMatchObject({
      harnessSessionId: `opencode:${SESSION}`,
      // 100+10 + 40 in, 25+5 out. The user-role row the fake also writes
      // (99999/99999) must NOT be counted.
      usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180, turns: 1 },
    })
    expect(result.verdict).toBe('completed')
    expect(result.usage.totalTokens).toBe(180)
  })

  it('spawns with the #467 env contract and the fixed flag set', async () => {
    const previous = process.env.RIVETOS_SESSION_KEY
    process.env.RIVETOS_SESSION_KEY = 'chat-20260809-dead'
    try {
      const fake = successFake()
      const spec = makeConformanceSpec({
        taskId: 'task-env-check',
        model: 'zai/glm-5.3-flash',
      })
      await makeExecutor(fake).start(spec, { signal: new AbortController().signal }).result

      const env = fake.env()
      expect(env.RIVETOS_TASK_ID).toBe('task-env-check')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
      expect(env.RIVETOS_DEN_HOOK_DISABLED).toBe('1')
      expect(env.XDG_DATA_HOME).toBe(fake.home)

      const args = fake.args()
      expect(args[0]).toBe('run')
      expect(args[args.indexOf('--model') + 1]).toBe('zai/glm-5.3-flash')
      expect(args[args.indexOf('--format') + 1]).toBe('json')
      // Turn 1 opens a fresh session.
      expect(args).not.toContain('--session')
      expect(args).not.toContain('--continue')
    } finally {
      if (previous === undefined) delete process.env.RIVETOS_SESSION_KEY
      else process.env.RIVETOS_SESSION_KEY = previous
    }
  })

  it('carries the task scaffold in the prompt, never a leading slash command', async () => {
    const fake = successFake()
    const spec = makeConformanceSpec({
      goal: '/goal ship the widget',
      acceptanceCriteria: [{ id: 'c1', description: 'widget ships', kind: 'manual' }],
    })
    await makeExecutor(fake).start(spec, { signal: new AbortController().signal }).result

    const args = fake.args()
    expect(args[0]).toBe('run')
    const prompt = fake.invocationTexts()[0]
    expect(prompt).toContain('## Task Context')
    expect(prompt).toContain('[c1] widget ships')
    expect(prompt).toContain('TASK_RESULT')
    expect(prompt).toContain('/goal ship the widget')
  })

  it('prefers the stream sessionID over a newer store row', async () => {
    const streamId = 'ses_streamstreamstreamstrea'
    const storeId = 'ses_storestorestorestoresto'
    const fake = makeFakeOpencode({
      lines: successLines('done', streamId),
      sessionId: storeId,
    })
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    const [events, result] = await Promise.all([drain(handle.events), handle.result])
    expect(result.verdict).toBe('completed')
    expect(events.find((e) => e.type === 'turn.end')).toMatchObject({
      harnessSessionId: `opencode:${streamId}`,
    })
  })

  it('steers onto the SAME native session with --session', async () => {
    const fake = successFake()
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('and one more thing')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    expect(result.usage.turns).toBe(2)
    const invocations = fake.invocations()
    expect(invocations).toHaveLength(2)
    expect(invocations[0]).not.toContain('--session')
    expect(invocations[1][invocations[1].indexOf('--session') + 1]).toBe(SESSION)
    const ids = events
      .filter((e) => e.type === 'turn.end')
      .map((e) => (e as { harnessSessionId?: string }).harnessSessionId)
    expect(ids).toEqual([`opencode:${SESSION}`, `opencode:${SESSION}`])
  })

  it('does not replay a resumed turn when the failure is not session-not-found', async () => {
    const fake = makeFakeOpencode({
      lines: successLines('done', SESSION),
      sessionId: SESSION,
      onResume: { stderr: 'error: provider auth failed', exitCode: 1 },
    })
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('carry on')
    const result = await handle.result
    const invocations = fake.invocations()
    expect(invocations).toHaveLength(2)
    expect(invocations[1]).toContain('--session')
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/provider auth failed/)
  })

  it('falls back to a fresh session when opencode refuses the resume', async () => {
    const fake = makeFakeOpencode({
      lines: successLines('done', SESSION),
      sessionId: SESSION,
      onResume: { stderr: `Session "${SESSION}" not found.`, exitCode: 1 },
    })
    const memory = {
      getSessionHistory: () => Promise.resolve([]),
      getTaskHistory: () =>
        Promise.resolve([{ role: 'assistant', content: 'what turn one already did' }]),
    }
    const executor = new OpencodeExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      opencodeHome: fake.home,
      killGraceMs: 200,
      memory,
    })
    const handle = executor.start(makeConformanceSpec(), { signal: new AbortController().signal })
    await handle.steer('carry on')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const invocations = fake.invocations()
    // turn 1 fresh, turn 2 rejected on --session, turn 2 retried fresh.
    expect(invocations).toHaveLength(3)
    expect(invocations[1]).toContain('--session')
    expect(invocations[2]).not.toContain('--session')
    expect(fake.invocationTexts()[2]).toContain('what turn one already did')
    expect(result.verdict).toBe('completed')
    expect(events.some((e) => e.type === 'log' && e.message.includes('fresh session'))).toBe(true)
  })

  it('parses a fenced TASK_RESULT block out of the final assistant text', async () => {
    const finalText = [
      'Work complete.',
      '',
      '```TASK_RESULT',
      JSON.stringify({
        verdict: 'completed',
        summary: 'Fixed the widget',
        artifacts: [{ kind: 'commit', ref: 'abc123', note: 'the fix' }],
      }),
      '```',
    ].join('\n')
    const result = await makeExecutor(successFake(finalText)).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.summary).toBe('Fixed the widget')
    expect(result.artifacts).toEqual([{ kind: 'commit', ref: 'abc123', note: 'the fix' }])
  })

  it('falls back to completed/<last text> without a fence', async () => {
    const result = await makeExecutor(successFake('Just prose.')).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.summary).toBe('Just prose.')
  })

  it('resolves failed on a nonzero exit and surfaces the stderr tail', async () => {
    const fake = makeFakeOpencode({
      lines: [],
      exitCode: 1,
      stderr: 'error: model alias unknown',
    })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/exited 1/)
    expect(result.error).toContain('model alias unknown')
  })

  it('resolves failed on a clean exit with no session id on the stream', async () => {
    const fake = makeFakeOpencode({
      raw: ['not json at all', '{"role": 42'],
      writeStore: false,
    })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/without a session id/)
  })

  it('resolves failed when the binary does not exist', async () => {
    const executor = new OpencodeExecutor({ binary: '/nonexistent/opencode-nope' })
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/Failed to spawn/)
  })

  it('degrades to zero usage rather than failing when the transcript is unreadable', async () => {
    // No store, and the stream has no step_finish tokens either.
    const fake = makeFakeOpencode({
      lines: [
        {
          type: 'text',
          timestamp: 1,
          sessionID: SESSION,
          part: { type: 'text', text: 'All done.' },
        },
      ],
      sessionId: SESSION,
      writeStore: false,
    })
    const executor = new OpencodeExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      opencodeHome: fake.dir,
      killGraceMs: 200,
    })
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.usage.totalTokens).toBe(0)
  })

  it('uses stream step_finish tokens when the data dir has no messages', async () => {
    const fake = makeFakeOpencode({
      lines: [
        ...successLines('All done.', SESSION).slice(0, -1),
        {
          type: 'step_finish',
          timestamp: 9,
          sessionID: SESSION,
          part: {
            type: 'step_finish',
            tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 10, write: 0 } },
          },
        },
      ],
      sessionId: SESSION,
      writeStore: false,
    })
    const executor = new OpencodeExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      opencodeHome: fake.dir, // not fake.home — disk reconcile finds nothing
      killGraceMs: 200,
    })
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.usage.inputTokens).toBe(110)
    expect(result.usage.outputTokens).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('canonicalOpencodeSessionId', () => {
  it('canonicalizes native ids, and only when it honestly can', () => {
    expect(canonicalOpencodeSessionId('ses_abc')).toBe('opencode:ses_abc')
    expect(canonicalOpencodeSessionId('opencode:ses_abc')).toBe('opencode:ses_abc')
    expect(canonicalOpencodeSessionId(' padded ')).toBe(' padded ')
    expect(canonicalOpencodeSessionId('')).toBeUndefined()
    expect(canonicalOpencodeSessionId(undefined)).toBeUndefined()
  })
})

describe('buildTurnPrompt', () => {
  it('puts the scaffold first so a slash-shaped goal cannot hijack the spawn', () => {
    const prompt = buildTurnPrompt({ scaffold: '## Task Context', message: '/goal do a thing' })
    expect(prompt.startsWith('## Task Context')).toBe(true)
    expect(prompt).toContain('## This turn\n/goal do a thing')
  })

  it('includes the rendered transcript when one is supplied', () => {
    const prompt = buildTurnPrompt({
      scaffold: 'S',
      transcript: '### Prior conversation (task resumed — do NOT redo completed work)\n[user]\nq',
      message: 'go on',
    })
    expect(prompt).toContain('Prior conversation')
  })
})

describe('buildTaskScaffold', () => {
  it('carries context, criteria and the TASK_RESULT contract', () => {
    const scaffold = buildTaskScaffold(
      makeConformanceSpec({
        resolvedContext: 'some context',
        acceptanceCriteria: [{ id: 'c1', description: 'it works', kind: 'manual' }],
        systemPromptAppend: 'extra instruction',
      }),
    )
    expect(scaffold).toContain('some context')
    expect(scaffold).toContain('[c1] it works')
    expect(scaffold).toContain('extra instruction')
    expect(scaffold).toContain('TASK_RESULT')
  })
})

describe('renderResumeTranscript', () => {
  it('renders role-labeled turns and skips non-chat rows', () => {
    const out = renderResumeTranscript([
      { role: 'user', content: 'q1' },
      { role: 'tool', content: 'noise' },
      { role: 'assistant', content: 'a1' },
    ])
    expect(out).toContain('[user]\nq1')
    expect(out).toContain('[assistant]\na1')
    expect(out).not.toContain('noise')
  })

  it('drops oldest turns over budget and notes the omission', () => {
    const big = 'x'.repeat(2_500)
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `${String(i)}-${big}`,
    }))
    const out = renderResumeTranscript(history)
    expect(out.length).toBeLessThan(30_000)
    expect(out).toContain('earlier message(s) omitted')
    expect(out).toContain('19-')
    expect(out).not.toContain('[user]\n0-')
  })

  it('returns empty for unusable history', () => {
    expect(renderResumeTranscript([{ role: 'tool', content: 'x' }])).toBe('')
  })
})
