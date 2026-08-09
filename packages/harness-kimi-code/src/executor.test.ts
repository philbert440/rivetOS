/**
 * KimiCodeExecutor tests — the shared HarnessExecutor conformance suite plus
 * kimi specifics, all driven by a FAKE `kimi` binary writing a kimi-shaped
 * `wire.jsonl` into a throwaway KIMI_CODE_HOME. The real binary is never
 * invoked: no Moonshot tokens, no live store, no `~/.kimi-code`.
 *
 * Covered: lifecycle, kill → 'killed', result-never-rejects (nonzero exit,
 * malformed stream, missing resume hint), post-hoc usage reconcile (including
 * the session-scoped rollup it must ignore), canonical session id on turn.end,
 * `-S` resume on steered turns, the resume-rejected fallback, the #467 env
 * contract, and the prompt scaffold.
 */

import { afterAll, describe, expect, it } from 'vitest'
import type { TaskEvent } from '@rivetos/types'
import {
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalKimiSessionId,
  KimiCodeExecutor,
  KIMI_HARNESS_ID,
  renderResumeTranscript,
} from './executor.js'
import { cleanupFakeKimi, makeFakeKimi, successLines, type FakeKimi } from './test/fake-kimi.js'
import {
  runExecutorConformance,
  makeConformanceSpec,
} from '../../core/src/domain/task/test/executor-conformance.js'

afterAll(() => {
  cleanupFakeKimi()
})

const SESSION = 'session_11111111-2222-3333-4444-555555555555'

function makeExecutor(fake: FakeKimi): KimiCodeExecutor {
  return new KimiCodeExecutor({
    binary: fake.binary,
    cwd: fake.cwd,
    kimiHome: fake.home,
    // Tests must not sit through kimi's real 8s cleanup budget.
    killGraceMs: 200,
  })
}

function successFake(text = 'All done.'): FakeKimi {
  return makeFakeKimi({ lines: successLines(text, SESSION), sessionId: SESSION })
}

async function drain(events: AsyncIterable<TaskEvent>): Promise<TaskEvent[]> {
  const seen: TaskEvent[] = []
  for await (const e of events) seen.push(e)
  return seen
}

// ---------------------------------------------------------------------------
// Shared conformance suite
// ---------------------------------------------------------------------------

runExecutorConformance('kimi-code', {
  makeSuccess: () => ({ executor: makeExecutor(successFake()), spec: makeConformanceSpec() }),
  makeError: () => ({
    executor: makeExecutor(
      makeFakeKimi({ lines: [], exitCode: 1, stderr: 'error: provider auth failed' }),
    ),
    spec: makeConformanceSpec(),
  }),
  makeSlow: () => ({ executor: makeExecutor(makeFakeKimi({ slow: true })), spec: makeConformanceSpec() }),
})

// ---------------------------------------------------------------------------
// kimi specifics
// ---------------------------------------------------------------------------

describe('KimiCodeExecutor', () => {
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
    expect(KIMI_HARNESS_ID).toBe('kimi-code')
    expect(makeExecutor(successFake()).name).toBe('kimi-code')
  })

  it('translates stream-json into den events and reconciles usage off wire.jsonl', async () => {
    const fake = makeFakeKimi({
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
    expect(den).toContainEqual({ type: 'tool.start', tool: 'Bash' })
    expect(den).toContainEqual({ type: 'tool.end', tool: 'Bash' })

    expect(events.find((e) => e.type === 'turn.end')).toMatchObject({
      harnessSessionId: `kimi-code:${SESSION}`,
      // 100+10 + 40 in, 25+5 out. The usageScope:'session' rollup the fake
      // also writes (99999/99999) must NOT be counted.
      usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180, turns: 1 },
    })
    expect(result.verdict).toBe('completed')
    expect(result.usage.totalTokens).toBe(180)
    // kimi reports tokens, never money — no cost events, no costUsd.
    expect(events.some((e) => e.type === 'cost')).toBe(false)
    expect(result.usage.costUsd).toBeUndefined()
  })

  it('spawns with the #467 env contract and the fixed flag set', async () => {
    const previous = process.env.RIVETOS_SESSION_KEY
    process.env.RIVETOS_SESSION_KEY = 'chat-20260809-dead'
    try {
      const fake = successFake()
      const spec = makeConformanceSpec({ taskId: 'task-env-check', model: 'kimi-k3', effort: 'high' })
      await makeExecutor(fake).start(spec, { signal: new AbortController().signal }).result

      const env = fake.env()
      expect(env.RIVETOS_TASK_ID).toBe('task-env-check')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
      expect(env.RIVETOS_DEN_HOOK_DISABLED).toBe('1')
      expect(env.KIMI_CODE_HOME).toBe(fake.home)
      expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('high')

      const args = fake.args()
      expect(args[args.indexOf('-m') + 1]).toBe('kimi-k3')
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
      // Turn 1 opens a fresh session; prompt mode forbids --auto/--yolo.
      expect(args).not.toContain('-S')
      expect(args).not.toContain('--auto')
      expect(args).not.toContain('--yolo')
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

    // The prompt is a multi-line argv value, so assert against the raw
    // recording rather than the line-split view.
    const args = fake.args()
    expect(args[args.indexOf('-p') + 1]).toBe('## Task Context')
    const prompt = fake.invocationTexts()[0]
    expect(prompt).toContain('[c1] widget ships')
    expect(prompt).toContain('TASK_RESULT')
    expect(prompt).toContain('/goal ship the widget')
  })

  it('steers onto the SAME native session with -S', async () => {
    const fake = successFake()
    const handle = makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('and one more thing')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    expect(result.usage.turns).toBe(2)
    const invocations = fake.invocations()
    expect(invocations).toHaveLength(2)
    expect(invocations[0]).not.toContain('-S')
    expect(invocations[1][invocations[1].indexOf('-S') + 1]).toBe(SESSION)
    // One session id across both turns — the point of native resume.
    const ids = events
      .filter((e) => e.type === 'turn.end')
      .map((e) => (e as { harnessSessionId?: string }).harnessSessionId)
    expect(ids).toEqual([`kimi-code:${SESSION}`, `kimi-code:${SESSION}`])
  })

  it('falls back to a fresh session when kimi refuses the resume', async () => {
    const fake = makeFakeKimi({
      lines: successLines('done', SESSION),
      sessionId: SESSION,
      onResume: { stderr: `Session "${SESSION}" not found.`, exitCode: 1 },
    })
    const memory = {
      getSessionHistory: () => Promise.resolve([]),
      getTaskHistory: () =>
        Promise.resolve([{ role: 'assistant', content: 'what turn one already did' }]),
    }
    const executor = new KimiCodeExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      kimiHome: fake.home,
      killGraceMs: 200,
      memory,
    })
    const handle = executor.start(makeConformanceSpec(), { signal: new AbortController().signal })
    await handle.steer('carry on')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const invocations = fake.invocations()
    // turn 1 fresh, turn 2 rejected on -S, turn 2 retried fresh.
    expect(invocations).toHaveLength(3)
    expect(invocations[1]).toContain('-S')
    expect(invocations[2]).not.toContain('-S')
    // The retry carries the task's rendered history, since the native context
    // it would have resumed into is gone.
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
    const fake = makeFakeKimi({ lines: [], exitCode: 1, stderr: 'error: model alias unknown' })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/exited 1/)
    expect(result.error).toContain('model alias unknown')
  })

  it('resolves failed on a clean exit with no resume hint', async () => {
    const fake = makeFakeKimi({ raw: ['not json at all', '{"role": 42'] })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/without a session resume_hint/)
  })

  it('resolves failed when the binary does not exist', async () => {
    const executor = new KimiCodeExecutor({ binary: '/nonexistent/kimi-nope' })
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/Failed to spawn/)
  })

  it('degrades to zero usage rather than failing when the transcript is unreadable', async () => {
    // Reconcile against a home that holds no transcript at all.
    const fake = successFake()
    const executor = new KimiCodeExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      kimiHome: fake.dir, // not fake.home — nothing was written here
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

describe('canonicalKimiSessionId', () => {
  it('canonicalizes native ids, and only when it honestly can', () => {
    expect(canonicalKimiSessionId('session_abc')).toBe('kimi-code:session_abc')
    expect(canonicalKimiSessionId('kimi-code:session_abc')).toBe('kimi-code:session_abc')
    expect(canonicalKimiSessionId(' padded ')).toBe(' padded ')
    expect(canonicalKimiSessionId('')).toBeUndefined()
    expect(canonicalKimiSessionId(undefined)).toBeUndefined()
  })
})

describe('buildTurnPrompt', () => {
  it('puts the scaffold first so a /goal-shaped goal cannot hijack prompt mode', () => {
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
