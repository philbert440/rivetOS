/**
 * Compile-level checks for the task engine contract (task.ts).
 * The value assertions are trivial — the point is that these typed literals
 * typecheck against the exported interfaces.
 */

import { describe, it, expect } from 'vitest'
import type {
  HarnessExecutor,
  TaskEvent,
  TaskResult,
  TaskSpec,
  TaskStatus,
  TaskVerdict,
} from './index.js'
import { buildLocalSessionContext } from './index.js'

describe('task contract types', () => {
  it('TaskSpec / TaskResult / TaskEvent literals compile and round-trip', () => {
    const spec: TaskSpec = {
      taskId: 't-1',
      agentId: 'opus',
      goal: 'compile',
      resolvedContext: '',
      acceptanceCriteria: [{ id: 'c1', description: 'types compile', kind: 'automated' }],
      budget: { maxTurns: 1, maxUsd: 0.1 },
      session: buildLocalSessionContext({
        agentId: 'opus',
        nodeId: 'n1',
        conversationId: 'conv',
        userId: 'phil',
      }),
    }

    const event: TaskEvent = {
      ts: Date.now(),
      type: 'turn.end',
      turn: 1,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, turns: 1, wallClockMs: 10 },
    }

    const result: TaskResult = {
      verdict: 'completed',
      summary: 'ok',
      artifacts: [{ kind: 'commit', ref: 'abc123' }],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, turns: 1, wallClockMs: 10 },
    }

    const statuses: TaskStatus[] = [
      'queued',
      'running',
      'awaiting-input',
      'completed',
      'failed',
      'killed',
      'timeout',
    ]
    const verdicts: TaskVerdict[] = ['completed', 'failed', 'killed', 'timeout', 'budget-exceeded']

    expect(spec.taskId).toBe('t-1')
    expect(event.type).toBe('turn.end')
    expect(result.verdict).toBe('completed')
    expect(statuses).toHaveLength(7)
    expect(verdicts).toHaveLength(5)
  })

  it('HarnessExecutor shape is implementable', async () => {
    const executor: HarnessExecutor = {
      name: 'noop',
      capabilities: () => ({
        steerable: false,
        multiTurn: false,
        structuredStream: false,
        usageInResult: true,
        sessionIdCapture: false,
        slashCommands: false,
        effortSelection: false,
        mcpInjection: 'none',
      }),
      start: () => ({
        events: (async function* (): AsyncGenerator<TaskEvent> {
          yield { ts: 0, type: 'turn.start', turn: 1 }
        })(),
        steer: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        result: Promise.resolve({
          verdict: 'completed',
          summary: '',
          artifacts: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, wallClockMs: 0 },
        }),
      }),
    }
    expect(executor.capabilities().mcpInjection).toBe('none')
    await expect(
      executor.start({} as TaskSpec, { signal: new AbortController().signal }).result,
    ).resolves.toMatchObject({ verdict: 'completed' })
  })
})
