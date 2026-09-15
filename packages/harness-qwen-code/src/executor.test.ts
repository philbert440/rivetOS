/**
 * QwenCodeExecutor tests — the shared HarnessExecutor conformance suite plus
 * qwen-code specifics, all driven by a FAKE `qwen` binary writing a
 * qwen-shaped session jsonl into a throwaway data dir. The real binary is
 * never invoked: no provider tokens, no live store, no `~/.qwen`.
 *
 * Covered: lifecycle, kill → 'killed', result-never-rejects (nonzero exit,
 * malformed stream, missing session/result), post-hoc usage reconcile
 * (assistant usageMetadata on disk), canonical session id on turn.end,
 * `--resume` on steered turns, the resume-rejected fallback, the #467 env
 * contract, and the prompt scaffold.
 */

import { afterAll, describe, expect, it } from 'vitest'
import type { TaskEvent } from '@rivetos/types'
import {
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalQwenCodeSessionId,
  defaultWorkspaceDir,
  QwenCodeExecutor,
  QWEN_CODE_HARNESS_ID,
  renderResumeTranscript,
} from './executor.js'
import {
  cleanupFakeQwen,
  makeFakeQwen,
  successLines,
  toolTurnLines,
  type FakeQwen,
} from './test/fake-qwen.js'
import {
  runExecutorConformance,
  makeConformanceSpec,
} from '../../core/src/domain/task/test/executor-conformance.js'

afterAll(() => {
  cleanupFakeQwen()
})

const SESSION = '857b4b7d-3d13-4281-a648-11947cf530ed'

function makeExecutor(fake: FakeQwen): QwenCodeExecutor {
  return new QwenCodeExecutor({
    binary: fake.binary,
    cwd: fake.cwd,
    qwenHome: fake.home,
    killGraceMs: 200,
  })
}

function successFake(text = 'All done.'): FakeQwen {
  return makeFakeQwen({ lines: successLines(text, SESSION), sessionId: SESSION })
}

async function drain(events: AsyncIterable<TaskEvent>): Promise<TaskEvent[]> {
  const seen: TaskEvent[] = []
  for await (const e of events) seen.push(e)
  return seen
}

// ---------------------------------------------------------------------------
// Shared conformance suite
// ---------------------------------------------------------------------------

runExecutorConformance('qwen-code', {
  makeSuccess: () => ({ executor: makeExecutor(successFake()), spec: makeConformanceSpec() }),
  makeError: () => ({
    executor: makeExecutor(
      makeFakeQwen({ lines: [], exitCode: 1, stderr: 'error: provider auth failed' }),
    ),
    spec: makeConformanceSpec(),
  }),
  makeSlow: () => ({
    executor: makeExecutor(makeFakeQwen({ slow: true })),
    spec: makeConformanceSpec(),
  }),
})

// ---------------------------------------------------------------------------
// qwen-code specifics
// ---------------------------------------------------------------------------

describe('QwenCodeExecutor', () => {
  it('reports the promised capability set', () => {
    expect(makeExecutor(successFake()).capabilities()).toEqual({
      steerable: true,
      multiTurn: true,
      structuredStream: true,
      usageInResult: true,
      sessionIdCapture: true,
      slashCommands: false,
      effortSelection: false,
      mcpInjection: 'persistent-config',
    })
  })

  it('registers under the harness id', () => {
    expect(QWEN_CODE_HARNESS_ID).toBe('qwen-code')
    expect(makeExecutor(successFake()).name).toBe('qwen-code')
  })

  it('translates the runtime stdout stream into den events, text, and usage', async () => {
    const fake = makeFakeQwen({
      lines: successLines('All done.', SESSION),
      sessionId: SESSION,
    })
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const den = events.filter((e) => e.type === 'den').map((e) => e.event)
    const agentText = den
      .filter((e) => e.type === 'message.agent')
      .map((e) => ('text' in e ? e.text : ''))
      .join('')
    expect(agentText).toBe('All done.')
    expect(den).toContainEqual({ type: 'thinking.delta', text: 'plan' })

    expect(events.find((e) => e.type === 'turn.end')).toMatchObject({
      harnessSessionId: `qwen-code:${SESSION}`,
      // last non-zero assistant usage: 100 in (cacheRead 10 is a subset), 25 out.
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125, turns: 1 },
    })
    expect(result.verdict).toBe('completed')
    expect(result.usage.totalTokens).toBe(125)
    expect(events.some((e) => e.type === 'cost')).toBe(false)
    expect(result.usage.costUsd).toBeUndefined()
  })

  it('emits tool start/end from assistant tool_use + user tool_result', async () => {
    const fake = makeFakeQwen({
      lines: toolTurnLines(SESSION, 'tool-sample-ok'),
      sessionId: SESSION,
    })
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    const events = await drain(handle.events)
    const den = events.filter((e) => e.type === 'den').map((e) => e.event)
    expect(den).toContainEqual({ type: 'tool.start', tool: 'run_shell_command' })
    expect(den).toContainEqual({ type: 'tool.end', tool: 'run_shell_command' })
    const agentText = den
      .filter((e) => e.type === 'message.agent')
      .map((e) => ('text' in e ? e.text : ''))
      .join('')
    expect(agentText).toContain('tool-sample-ok')
  })

  it('spawns with the #467 env contract and the fixed flag set', async () => {
    const previous = process.env.RIVETOS_SESSION_KEY
    process.env.RIVETOS_SESSION_KEY = 'chat-20260809-dead'
    try {
      const fake = successFake()
      const spec = makeConformanceSpec({ taskId: 'task-env-check', model: 'qwen-27b' })
      await makeExecutor(fake).start(spec, { signal: new AbortController().signal }).result

      const env = fake.env()
      expect(env.RIVETOS_TASK_ID).toBe('task-env-check')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
      expect(env.QWEN_CODE_SUPPRESS_YOLO_WARNING).toBe('1')

      const args = fake.args()
      expect(args[0]).toBe('-p')
      expect(args[args.indexOf('-m') + 1]).toBe('qwen-27b')
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
      expect(args).toContain('--include-partial-messages')
      expect(args[args.indexOf('--approval-mode') + 1]).toBe('yolo')
      expect(args).toContain('--append-system-prompt')
      expect(args).toContain('--session-id')
      expect(args).not.toContain('--resume')
      expect(args).not.toContain('--thinking')
      expect(args).not.toContain('--effort')
    } finally {
      if (previous === undefined) delete process.env.RIVETOS_SESSION_KEY
      else process.env.RIVETOS_SESSION_KEY = previous
    }
  })

  it('carries the task scaffold via --append-system-prompt, including cwd', async () => {
    const fake = successFake()
    const spec = makeConformanceSpec({
      goal: '/goal ship the widget',
      acceptanceCriteria: [{ id: 'c1', description: 'widget ships', kind: 'manual' }],
    })
    await makeExecutor(fake).start(spec, { signal: new AbortController().signal }).result

    const args = fake.args()
    expect(args).toContain('--append-system-prompt')
    // fake.args() splits on newlines, so multi-line argv values are not one
    // element there. invocationTexts() is the full recorded argv.
    const recorded = fake.invocationTexts()[0]
    expect(recorded).toContain('## Task Context')
    expect(recorded).toContain(`Working directory: ${fake.cwd}`)
    expect(recorded).toContain('[c1] widget ships')
    expect(recorded).toContain('TASK_RESULT')
    expect(recorded).toContain('/goal ship the widget')
  })

  it('steers onto the SAME native session with --resume', async () => {
    const fake = successFake()
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('and one more thing')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    expect(result.usage.turns).toBe(2)
    const invocations = fake.invocations()
    expect(invocations).toHaveLength(2)
    expect(invocations[0]).toContain('--session-id')
    expect(invocations[0]).not.toContain('--resume')
    expect(invocations[1][invocations[1].indexOf('--resume') + 1]).toBe(SESSION)
    const ids = events
      .filter((e) => e.type === 'turn.end')
      .map((e) => (e as { harnessSessionId?: string }).harnessSessionId)
    expect(ids).toEqual([`qwen-code:${SESSION}`, `qwen-code:${SESSION}`])
  })

  it('falls back to a fresh session when qwen refuses the resume', async () => {
    const fake = makeFakeQwen({
      lines: successLines('done', SESSION),
      sessionId: SESSION,
      onResume: {
        stdout: `No saved session found with ID ${SESSION}. Run \`qwen --resume\` to list available sessions.`,
        exitCode: 0,
      },
    })
    const memory = {
      getSessionHistory: () => Promise.resolve([]),
      getTaskHistory: () =>
        Promise.resolve([{ role: 'assistant', content: 'what turn one already did' }]),
    }
    const executor = new QwenCodeExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      qwenHome: fake.home,
      killGraceMs: 200,
      memory,
    })
    const handle = executor.start(makeConformanceSpec(), { signal: new AbortController().signal })
    await handle.steer('carry on')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const invocations = fake.invocations()
    // turn 1 pin, turn 2 rejected on --resume, turn 2 retried with a fresh pin.
    expect(invocations).toHaveLength(3)
    expect(invocations[1]).toContain('--resume')
    expect(invocations[2]).toContain('--session-id')
    expect(invocations[2]).not.toContain('--resume')
    expect(fake.invocationTexts()[2]).toContain('what turn one already did')
    expect(result.verdict).toBe('completed')
    expect(events.some((e) => e.type === 'log' && e.message.includes('fresh session'))).toBe(true)
  })

  it('does not retry a resume that exits nonzero with no system/init', async () => {
    const fake = makeFakeQwen({
      lines: successLines('done', SESSION),
      sessionId: SESSION,
      onResume: {
        stdout: 'error: provider auth failed',
        exitCode: 1,
      },
    })
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('carry on')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const invocations = fake.invocations()
    expect(invocations).toHaveLength(2)
    expect(invocations[1]).toContain('--resume')
    expect(invocations[1]).not.toContain('--session-id')
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/exited 1/)
    expect(events.some((e) => e.type === 'log' && e.message.includes('fresh session'))).toBe(false)
  })

  it('retries a resume that exits 0 with no system/init even without the rejection string', async () => {
    const fake = makeFakeQwen({
      lines: successLines('done', SESSION),
      sessionId: SESSION,
      onResume: { stdout: '', exitCode: 0 },
    })
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('carry on')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const invocations = fake.invocations()
    expect(invocations).toHaveLength(3)
    expect(invocations[1]).toContain('--resume')
    expect(invocations[2]).toContain('--session-id')
    expect(invocations[2]).not.toContain('--resume')
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
    const fake = makeFakeQwen({ lines: [], exitCode: 1, stderr: 'error: model alias unknown' })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/exited 1/)
    expect(result.error).toContain('model alias unknown')
  })

  it('resolves failed on a clean exit with no terminal event', async () => {
    const fake = makeFakeQwen({ raw: ['not json at all', '{"role": 42'] })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/without a terminal event/)
  })

  it('fails the turn when result.is_error / subtype is not success', async () => {
    const fake = makeFakeQwen({
      lines: [
        {
          type: 'system',
          subtype: 'init',
          uuid: SESSION,
          session_id: SESSION,
          cwd: '/home/example',
          model: 'qwen-27b',
        },
        {
          type: 'result',
          subtype: 'error_max_turns',
          uuid: SESSION,
          session_id: SESSION,
          is_error: true,
          result: 'stopped',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      ],
      sessionId: SESSION,
    })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/qwen result: error_max_turns/)
  })

  it('resolves failed when the binary does not exist', async () => {
    const executor = new QwenCodeExecutor({ binary: '/nonexistent/qwen-nope' })
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/Failed to spawn/)
  })

  it('degrades to zero usage rather than failing when the transcript is unreadable', async () => {
    const zero = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      total_tokens: 0,
    }
    const fake = makeFakeQwen({
      lines: successLines('Just prose.', SESSION, zero),
      sessionId: SESSION,
    })
    const executor = new QwenCodeExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      qwenHome: fake.dir,
      killGraceMs: 200,
    })
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.usage.totalTokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('canonicalQwenCodeSessionId', () => {
  it('canonicalizes native ids, and only when it honestly can', () => {
    expect(canonicalQwenCodeSessionId(SESSION)).toBe(`qwen-code:${SESSION}`)
    expect(canonicalQwenCodeSessionId(`qwen-code:${SESSION}`)).toBe(`qwen-code:${SESSION}`)
    expect(canonicalQwenCodeSessionId(' padded ')).toBe(' padded ')
    expect(canonicalQwenCodeSessionId('')).toBeUndefined()
    expect(canonicalQwenCodeSessionId(undefined)).toBeUndefined()
  })
})

describe('defaultWorkspaceDir', () => {
  it('defaults to ~/.rivetos/workspace', () => {
    expect(defaultWorkspaceDir()).toMatch(/\.rivetos[/\\]workspace$/)
  })
})

describe('buildTurnPrompt', () => {
  it('wraps the turn message; scaffold is optional (goes out as --append-system-prompt)', () => {
    const prompt = buildTurnPrompt({ message: '/goal do a thing' })
    expect(prompt).toBe('## This turn\n/goal do a thing')
    const withScaffold = buildTurnPrompt({
      scaffold: '## Task Context',
      message: '/goal do a thing',
    })
    expect(withScaffold.startsWith('## Task Context')).toBe(true)
    expect(withScaffold).toContain('## This turn\n/goal do a thing')
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
  it('carries context, criteria, cwd and the TASK_RESULT contract', () => {
    const scaffold = buildTaskScaffold(
      makeConformanceSpec({
        resolvedContext: 'some context',
        acceptanceCriteria: [{ id: 'c1', description: 'it works', kind: 'manual' }],
        systemPromptAppend: 'extra instruction',
      }),
      '/home/example',
    )
    expect(scaffold).toContain('some context')
    expect(scaffold).toContain('[c1] it works')
    expect(scaffold).toContain('extra instruction')
    expect(scaffold).toContain('TASK_RESULT')
    expect(scaffold).toContain('Working directory: /home/example')
    expect(scaffold).toContain('/home/example')
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
