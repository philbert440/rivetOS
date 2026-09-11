/**
 * PiExecutor tests — the shared HarnessExecutor conformance suite plus pi
 * specifics, all driven by a FAKE `pi` binary writing a pi-shaped
 * session jsonl into a throwaway data dir. The real binary is never
 * invoked: no provider tokens, no live store, no `~/.pi`.
 *
 * Covered: lifecycle, kill → 'killed', result-never-rejects (nonzero exit,
 * malformed stream, missing session/result), post-hoc usage reconcile
 * (assistant message.usage on disk), canonical session id
 * on turn.end, `--session` resume on steered turns, the resume-rejected
 * fallback, the #467 env contract, and the prompt scaffold.
 */

import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { TaskEvent } from '@rivetos/types'
import {
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalPiSessionId,
  PiExecutor,
  PI_HARNESS_ID,
  renderResumeTranscript,
} from './executor.js'
import { cleanupFakePi, makeFakePi, successLines, type FakePi } from './test/fake-pi.js'
import {
  runExecutorConformance,
  makeConformanceSpec,
} from '../../core/src/domain/task/test/executor-conformance.js'

afterAll(() => {
  cleanupFakePi()
})

const SESSION = '01a090db-c402-71cb-a954-6066b9493630'

function makeExecutor(fake: FakePi): PiExecutor {
  return new PiExecutor({
    binary: fake.binary,
    cwd: fake.cwd,
    piHome: fake.home,
    // Tests must not sit through a real cleanup budget.
    killGraceMs: 200,
  })
}

function successFake(text = 'All done.'): FakePi {
  return makeFakePi({ lines: successLines(text, SESSION), sessionId: SESSION })
}

async function drain(events: AsyncIterable<TaskEvent>): Promise<TaskEvent[]> {
  const seen: TaskEvent[] = []
  for await (const e of events) seen.push(e)
  return seen
}

// ---------------------------------------------------------------------------
// Shared conformance suite
// ---------------------------------------------------------------------------

runExecutorConformance('pi', {
  makeSuccess: () => ({ executor: makeExecutor(successFake()), spec: makeConformanceSpec() }),
  makeError: () => ({
    executor: makeExecutor(
      makeFakePi({ lines: [], exitCode: 1, stderr: 'error: provider auth failed' }),
    ),
    spec: makeConformanceSpec(),
  }),
  makeSlow: () => ({ executor: makeExecutor(makeFakePi({ slow: true })), spec: makeConformanceSpec() }),
})

// ---------------------------------------------------------------------------
// pi specifics
// ---------------------------------------------------------------------------

describe('PiExecutor', () => {
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
    expect(PI_HARNESS_ID).toBe('pi')
    expect(makeExecutor(successFake()).name).toBe('pi')
  })

  it('translates print/JSON into den events and reconciles usage off the session jsonl', async () => {
    const fake = makeFakePi({
      lines: successLines('All done.', SESSION),
      sessionId: SESSION,
      usage: [
        { input: 100, output: 25, cacheRead: 10 },
        { input: 40, output: 5, cacheRead: 0 },
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
      harnessSessionId: `pi:${SESSION}`,
      // 100+10 + 40 in, 25+5 out, summed onto the on-disk assistant message.
      usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180, turns: 1 },
    })
    expect(result.verdict).toBe('completed')
    expect(result.usage.totalTokens).toBe(180)
    expect(events.some((e) => e.type === 'cost')).toBe(false)
    expect(result.usage.costUsd).toBeUndefined()
  })

  it('spawns with the #467 env contract and the fixed flag set', async () => {
    const previous = process.env.RIVETOS_SESSION_KEY
    process.env.RIVETOS_SESSION_KEY = 'chat-20260809-dead'
    try {
      const fake = successFake()
      const spec = makeConformanceSpec({ taskId: 'task-env-check', model: 'glm-4.5', effort: 'high' })
      await makeExecutor(fake).start(spec, { signal: new AbortController().signal }).result

      const env = fake.env()
      expect(env.RIVETOS_TASK_ID).toBe('task-env-check')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
      expect(env.RIVETOS_DEN_HOOK_DISABLED).toBe('1')
      expect(env.PI_HOME).toBeUndefined()

      const args = fake.args()
      expect(args[args.indexOf('--model') + 1]).toBe('glm-4.5')
      expect(args[args.indexOf('--thinking') + 1]).toBe('high')
      expect(args[args.indexOf('--mode') + 1]).toBe('json')
      expect(args).toContain('--print')
      expect(args).toContain('--')
      expect(args).toContain('--append-system-prompt')
      expect(args[args.indexOf('--session-dir') + 1]).toBe(path.join(fake.home, 'sessions'))
      // Turn 1 opens a fresh session (den pinning uses --session-id; the
      // executor adopts the id from the stdout session line).
      expect(args).not.toContain('--session')
      expect(args).not.toContain('--session-id')
      expect(args).not.toContain('--auto')
      expect(args).not.toContain('--yolo')
    } finally {
      if (previous === undefined) delete process.env.RIVETOS_SESSION_KEY
      else process.env.RIVETOS_SESSION_KEY = previous
    }
  })

  it('carries the task scaffold via --append-system-prompt, prompt after --', async () => {
    const fake = successFake()
    const spec = makeConformanceSpec({
      goal: '/goal ship the widget',
      acceptanceCriteria: [{ id: 'c1', description: 'widget ships', kind: 'manual' }],
    })
    await makeExecutor(fake).start(spec, { signal: new AbortController().signal }).result

    const args = fake.args()
    expect(args).toContain('--append-system-prompt')
    expect(args).toContain('--')
    const sys = args[args.indexOf('--append-system-prompt') + 1]
    expect(sys).toContain('## Task Context')
    const prompt = fake.invocationTexts()[0]
    expect(prompt).toContain('[c1] widget ships')
    expect(prompt).toContain('TASK_RESULT')
    expect(prompt).toContain('/goal ship the widget')
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
    expect(ids).toEqual([`pi:${SESSION}`, `pi:${SESSION}`])
  })

  it('falls back to a fresh session when pi refuses the resume', async () => {
    const fake = makeFakePi({
      lines: successLines('done', SESSION),
      sessionId: SESSION,
      onResume: { stderr: `Session "${SESSION}" not found.`, exitCode: 1 },
    })
    const memory = {
      getSessionHistory: () => Promise.resolve([]),
      getTaskHistory: () =>
        Promise.resolve([{ role: 'assistant', content: 'what turn one already did' }]),
    }
    const executor = new PiExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      piHome: fake.home,
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
    const fake = makeFakePi({ lines: [], exitCode: 1, stderr: 'error: model alias unknown' })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/exited 1/)
    expect(result.error).toContain('model alias unknown')
  })

  it('resolves failed on a clean exit with no session event', async () => {
    const fake = makeFakePi({ raw: ['not json at all', '{"role": 42'] })
    const result = await makeExecutor(fake).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/without a session event/)
  })

  it('resolves failed when the binary does not exist', async () => {
    const executor = new PiExecutor({ binary: '/nonexistent/pi-nope' })
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/Failed to spawn/)
  })

  it('degrades to zero usage rather than failing when the transcript is unreadable', async () => {
    const fake = successFake()
    const executor = new PiExecutor({
      binary: fake.binary,
      cwd: fake.cwd,
      piHome: fake.dir, // not fake.home — nothing was written here
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

describe('canonicalPiSessionId', () => {
  it('canonicalizes native ids, and only when it honestly can', () => {
    expect(canonicalPiSessionId(SESSION)).toBe(`pi:${SESSION}`)
    expect(canonicalPiSessionId(`pi:${SESSION}`)).toBe(`pi:${SESSION}`)
    expect(canonicalPiSessionId(' padded ')).toBe(' padded ')
    expect(canonicalPiSessionId('')).toBeUndefined()
    expect(canonicalPiSessionId(undefined)).toBeUndefined()
  })
})

describe('buildTurnPrompt', () => {
  it('wraps the turn message; scaffold is optional (goes out as --append-system-prompt)', () => {
    const prompt = buildTurnPrompt({ message: '/goal do a thing' })
    expect(prompt).toBe('## This turn\n/goal do a thing')
    const withScaffold = buildTurnPrompt({ scaffold: '## Task Context', message: '/goal do a thing' })
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
