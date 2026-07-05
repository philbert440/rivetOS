/**
 * ClaudeCliExecutor tests — shared HarnessExecutor conformance suite plus
 * claude-cli specifics, all driven by a FAKE claude binary (a shell script
 * emitting canned stream-json). The real claude binary is never invoked.
 *
 * Covered: lifecycle, kill → 'killed', result-never-rejects (malformed
 * stream, nonzero exit, missing TASK_RESULT), cost event emission,
 * TASK_RESULT parsing (good + malformed), spawn env (RIVETOS_SESSION_KEY,
 * RIVETOS_DEN_HOOK_DISABLED), effort/model flag passthrough.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { TaskEvent } from '@rivetos/types'
import { ClaudeCliExecutor, parseTaskResultBlock } from './executor.js'
import {
  runExecutorConformance,
  makeConformanceSpec,
} from '../../../../packages/core/src/domain/task/test/executor-conformance.js'

// ---------------------------------------------------------------------------
// Fake claude binary fixtures
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

interface FakeClaude {
  binary: string
  dir: string
  /** argv the fake was last spawned with (one arg per line). */
  args: () => string[]
  /** env of the last spawn as a name→value map. */
  env: () => Record<string, string>
}

/**
 * Write a fake `claude` shell script that records argv + env, swallows
 * stdin, prints the given stream-json lines, and exits with `exitCode`.
 */
function makeFakeClaude(lines: unknown[], opts?: { exitCode?: number; raw?: string[] }): FakeClaude {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
  tmpDirs.push(dir)
  const stdout = (opts?.raw ?? lines.map((l) => JSON.stringify(l))).join('\n')
  fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout + '\n')
  const binary = path.join(dir, 'claude')
  fs.writeFileSync(
    binary,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > "${dir}/args.txt"`,
      `env > "${dir}/env.txt"`,
      'cat > /dev/null',
      `cat "${dir}/stdout.txt"`,
      `exit ${String(opts?.exitCode ?? 0)}`,
    ].join('\n'),
    { mode: 0o755 },
  )
  return {
    binary,
    dir,
    args: () => fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trimEnd().split('\n'),
    env: () => {
      const out: Record<string, string> = {}
      for (const line of fs.readFileSync(path.join(dir, 'env.txt'), 'utf8').split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1)
      }
      return out
    },
  }
}

/** Fake that hangs until signaled — for kill/abort paths. */
function makeSlowClaude(): FakeClaude {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-slow-'))
  tmpDirs.push(dir)
  const binary = path.join(dir, 'claude')
  fs.writeFileSync(binary, '#!/usr/bin/env bash\ncat > /dev/null\nexec sleep 60\n', {
    mode: 0o755,
  })
  return { binary, dir, args: () => [], env: () => ({}) }
}

const SESSION = 'fake-session-42'

function successLines(finalText: string): unknown[] {
  return [
    {
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      model: 'fake',
      apiKeySource: 'none',
      tools: [],
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Bash' },
          { type: 'text', text: finalText },
        ],
      },
      session_id: SESSION,
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] },
      session_id: SESSION,
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: finalText,
      session_id: SESSION,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 100, output_tokens: 25 },
    },
  ]
}

function makeExecutor(binary: string): ClaudeCliExecutor {
  return new ClaudeCliExecutor({ binary })
}

async function drain(events: AsyncIterable<TaskEvent>): Promise<TaskEvent[]> {
  const seen: TaskEvent[] = []
  for await (const e of events) seen.push(e)
  return seen
}

// ---------------------------------------------------------------------------
// Shared conformance suite
// ---------------------------------------------------------------------------

runExecutorConformance('claude-cli', {
  makeSuccess: () => ({
    executor: makeExecutor(makeFakeClaude(successLines('All done.')).binary),
    spec: makeConformanceSpec(),
  }),
  makeError: () => ({
    // Nonzero exit, no result event → failed (still resolves).
    executor: makeExecutor(makeFakeClaude([], { exitCode: 3 }).binary),
    spec: makeConformanceSpec(),
  }),
  makeSlow: () => ({
    executor: makeExecutor(makeSlowClaude().binary),
    spec: makeConformanceSpec(),
  }),
})

// ---------------------------------------------------------------------------
// claude-cli specifics
// ---------------------------------------------------------------------------

describe('ClaudeCliExecutor', () => {
  it('reports the promised capability set', () => {
    const caps = makeExecutor('claude').capabilities()
    expect(caps).toEqual({
      steerable: true,
      multiTurn: true,
      structuredStream: true,
      usageInResult: true,
      sessionIdCapture: true,
      slashCommands: true,
      effortSelection: true,
      mcpInjection: 'flag',
    })
  })

  it('emits cost + den events and surfaces harnessSessionId/usage on turn.end', async () => {
    const fake = makeFakeClaude(successLines('All done.'))
    const handle = makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    const [events, result] = await Promise.all([drain(handle.events), handle.result])

    const cost = events.find((e) => e.type === 'cost')
    expect(cost).toMatchObject({ deltaUsd: 0.0123, totalUsd: 0.0123 })

    const turnEnd = events.find((e) => e.type === 'turn.end')
    expect(turnEnd).toMatchObject({
      harnessSessionId: SESSION,
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125, costUsd: 0.0123, turns: 1 },
    })

    const den = events.filter((e) => e.type === 'den').map((e) => e.event)
    expect(den).toContainEqual({ type: 'message.agent', text: 'All done.' })
    expect(den).toContainEqual({ type: 'tool.start', tool: 'Bash' })
    expect(den).toContainEqual({ type: 'tool.end', tool: 'Bash' })

    expect(result.usage.costUsd).toBeCloseTo(0.0123)
  })

  it('passes model/effort through as --model/--effort flags', async () => {
    const fake = makeFakeClaude(successLines('ok'))
    const spec = makeConformanceSpec({ model: 'fable-5', effort: 'high' })
    await makeExecutor(fake.binary).start(spec, { signal: new AbortController().signal }).result
    const args = fake.args()
    expect(args[args.indexOf('--model') + 1]).toBe('fable-5')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--permission-mode')
  })

  it('spawns with RIVETOS_SESSION_KEY=task:<id> and RIVETOS_DEN_HOOK_DISABLED=1', async () => {
    const fake = makeFakeClaude(successLines('ok'))
    const spec = makeConformanceSpec({ taskId: 'task-env-check' })
    await makeExecutor(fake.binary).start(spec, { signal: new AbortController().signal }).result
    const env = fake.env()
    expect(env.RIVETOS_SESSION_KEY).toBe('task:task-env-check')
    expect(env.RIVETOS_DEN_HOOK_DISABLED).toBe('1')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('parses a well-formed TASK_RESULT block', async () => {
    const finalText = [
      'Work complete.',
      '',
      '```TASK_RESULT',
      JSON.stringify({
        verdict: 'completed',
        summary: 'Fixed the widget',
        artifacts: [{ kind: 'commit', ref: 'abc123', note: 'the fix' }],
        criteriaSelfReport: [{ id: 'c1', met: true, evidence: 'tests pass' }],
      }),
      '```',
    ].join('\n')
    const fake = makeFakeClaude(successLines(finalText))
    const result = await makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.summary).toBe('Fixed the widget')
    expect(result.artifacts).toEqual([{ kind: 'commit', ref: 'abc123', note: 'the fix' }])
    expect(result.criteriaSelfReport).toEqual([{ id: 'c1', met: true, evidence: 'tests pass' }])
  })

  it('falls back to completed/<last text> on a malformed TASK_RESULT block', async () => {
    const finalText = 'Did things.\n\n```TASK_RESULT\n{not json at all\n```'
    const fake = makeFakeClaude(successLines(finalText))
    const result = await makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.summary).toBe(finalText)
  })

  it('falls back to completed/<last text> when TASK_RESULT is missing', async () => {
    const fake = makeFakeClaude(successLines('Just some prose, no block.'))
    const result = await makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
    expect(result.summary).toBe('Just some prose, no block.')
  })

  it('resolves failed (never rejects) on a malformed stream with clean exit', async () => {
    const fake = makeFakeClaude([], { raw: ['this is not json', '{"type": 42', '<<<garbage>>>'] })
    const result = await makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/without a result event/)
  })

  it('resolves failed (never rejects) on nonzero exit without a result event', async () => {
    const fake = makeFakeClaude([], { exitCode: 7 })
    const result = await makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/exited 7/)
  })

  it('resolves failed on an is_error result', async () => {
    const fake = makeFakeClaude([
      {
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'boom',
        session_id: SESSION,
      },
    ])
    const result = await makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/boom/)
  })

  it('resolves failed when the binary does not exist', async () => {
    const result = await makeExecutor('/nonexistent/claude-nope').start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/Failed to spawn/)
  })

  it('steer() queues a follow-up turn on the same handle', async () => {
    const fake = makeFakeClaude(successLines('turn output'))
    const handle = makeExecutor(fake.binary).start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('and another thing')
    const [events, result] = await Promise.all([drain(handle.events), handle.result])
    expect(result.verdict).toBe('completed')
    expect(result.usage.turns).toBe(2)
    expect(events.filter((e) => e.type === 'turn.start')).toHaveLength(2)
    // Cost accumulates across turns.
    expect(result.usage.costUsd).toBeCloseTo(0.0246)
  })
})

describe('parseTaskResultBlock', () => {
  it('takes the LAST fenced block and validates the verdict', () => {
    const text = [
      '```TASK_RESULT\n{"verdict":"failed","summary":"first"}\n```',
      'more text',
      '```TASK_RESULT\n{"verdict":"completed","summary":"second"}\n```',
    ].join('\n')
    expect(parseTaskResultBlock(text)?.summary).toBe('second')
    expect(parseTaskResultBlock('```TASK_RESULT\n{"verdict":"nope","summary":"x"}\n```')).toBe(
      undefined,
    )
    expect(parseTaskResultBlock('no block here')).toBe(undefined)
  })
})
