/**
 * HarnessExecutor conformance suite — shared contract tests every executor
 * implementation must pass (design doc eval plan). Consumed by
 * chat-loop-executor.test.ts today; claude-cli/grok-cli/hermes-cli executors
 * run the same suite at their cutover steps.
 *
 * Lives under `test/` (not `*.test.ts`) so it is importable as a helper
 * rather than collected as a suite of its own.
 *
 * Contract points exercised:
 *   - start → result resolves on success, internal-error, and kill paths
 *   - result NEVER rejects
 *   - kill() → verdict 'killed'
 *   - the events iterable completes once the task is terminal
 */

import { describe, it, expect } from 'vitest'
import type { HarnessExecutor, TaskEvent, TaskSpec } from '@rivetos/types'
import { buildLocalSessionContext } from '@rivetos/types'

export interface ExecutorConformanceTargets {
  /** Executor + spec that completes successfully. */
  makeSuccess(): { executor: HarnessExecutor; spec: TaskSpec }
  /** Executor + spec whose execution fails internally (must still resolve). */
  makeError(): { executor: HarnessExecutor; spec: TaskSpec }
  /** Executor + spec that runs long enough to be killed mid-flight. */
  makeSlow(): { executor: HarnessExecutor; spec: TaskSpec }
}

export function makeConformanceSpec(overrides?: Partial<TaskSpec>): TaskSpec {
  const taskId = overrides?.taskId ?? `conformance-${Math.random().toString(36).slice(2, 10)}`
  const agentId = overrides?.agentId ?? 'conformance-agent'
  return {
    taskId,
    agentId,
    goal: 'Say hello',
    resolvedContext: '',
    acceptanceCriteria: [],
    budget: {},
    session: buildLocalSessionContext({
      agentId,
      nodeId: 'test-node',
      conversationId: taskId,
      userId: 'conformance',
    }),
    ...overrides,
  }
}

async function drain(events: AsyncIterable<TaskEvent>): Promise<TaskEvent[]> {
  const seen: TaskEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

export function runExecutorConformance(name: string, targets: ExecutorConformanceTargets): void {
  describe(`HarnessExecutor conformance: ${name}`, () => {
    it('reports coherent capabilities', () => {
      const { executor } = targets.makeSuccess()
      const caps = executor.capabilities()
      expect(typeof caps.steerable).toBe('boolean')
      expect(['flag', 'cwd-file', 'persistent-config', 'none']).toContain(caps.mcpInjection)
    })

    it('resolves result on the success path and completes the events iterable', async () => {
      const { executor, spec } = targets.makeSuccess()
      const handle = executor.start(spec, { signal: new AbortController().signal })
      const [events, result] = await Promise.all([drain(handle.events), handle.result])
      expect(result.verdict).toBe('completed')
      expect(result.usage.turns).toBeGreaterThanOrEqual(1)
      expect(events.some((e) => e.type === 'turn.start')).toBe(true)
      expect(events.some((e) => e.type === 'turn.end')).toBe(true)
      // Iterable must be complete (drain returned) — and stay complete.
      expect(await drain(handle.events)).toEqual([])
    })

    it('resolves (never rejects) on the internal-error path', async () => {
      const { executor, spec } = targets.makeError()
      const handle = executor.start(spec, { signal: new AbortController().signal })
      await drain(handle.events)
      const result = await handle.result // a rejection fails the test naturally
      expect(result.verdict).toBe('failed')
      expect(result.error).toBeTruthy()
    })

    it('kill() yields verdict killed and still resolves result', async () => {
      const { executor, spec } = targets.makeSlow()
      const handle = executor.start(spec, { signal: new AbortController().signal })
      await handle.kill('conformance kill')
      const result = await handle.result
      expect(result.verdict).toBe('killed')
      await drain(handle.events) // iterable must complete after kill too
    })

    it('external abort signal resolves result with verdict killed', async () => {
      const { executor, spec } = targets.makeSlow()
      const abort = new AbortController()
      const handle = executor.start(spec, { signal: abort.signal })
      abort.abort('runner abort')
      const result = await handle.result
      expect(result.verdict).toBe('killed')
    })
  })
}
