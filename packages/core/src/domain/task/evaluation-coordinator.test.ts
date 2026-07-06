/**
 * EvaluationCoordinator (2d) — the verifier pass driven end-to-end over the
 * InMemoryTaskStore + real task handler, with a fake executor playing the
 * verifier (its criteriaSelfReport is scripted per test).
 */

import { describe, it, expect, afterEach } from 'vitest'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  TaskResult,
  TaskSpec,
  TaskUsage,
} from '@rivetos/types'
import { InMemoryTaskStore, type TaskRow } from './store.js'
import { createExecutorRegistry, createTaskHandler } from './runner.js'
import { createTaskCompletionWaiter, type TaskCompletionWaiter } from './completion-waiter.js'
import { createEvaluationCoordinator, mapVerifierResult } from './evaluation-coordinator.js'

const usage: TaskUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, wallClockMs: 1 }
const caps: HarnessExecutorCapabilities = {
  steerable: true,
  multiTurn: true,
  structuredStream: true,
  usageInResult: true,
  sessionIdCapture: false,
  slashCommands: false,
  effortSelection: false,
  mcpInjection: 'none',
}

/** Executor whose result is computed from the spec — verifier children see
 *  their own goal (the audit brief), so tests script reports per call. */
function scriptedExecutor(fn: (spec: TaskSpec) => TaskResult): HarnessExecutor {
  return {
    name: 'scripted',
    capabilities: () => caps,
    start: (spec: TaskSpec) => ({
      events: (async function* () {
        await Promise.resolve()
      })(),
      steer: () => Promise.resolve(),
      kill: () => Promise.resolve(),
      result: Promise.resolve(fn(spec)),
    }),
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function makeRig(verify: (spec: TaskSpec) => TaskResult) {
  const executors = createExecutorRegistry()
  executors.register('chat-loop', scriptedExecutor(verify))
  let handler: (taskId: string) => Promise<void>
  const store = new InMemoryTaskStore((taskId) => {
    void handler(taskId)
  })
  const waiter: TaskCompletionWaiter = createTaskCompletionWaiter({ store, pollFallbackMs: 5 })
  cleanups.push(() => waiter.stop())
  const coordinator = createEvaluationCoordinator({
    store,
    waiter,
    nodeId: 'test-node',
    config: { skipOrigins: ['heartbeat'] },
  })
  handler = createTaskHandler({ store, executors, nodeId: 'test-node', evaluation: coordinator })
  return { store, waiter, coordinator }
}

const CRITERIA = [
  { id: 'c1', description: 'tests pass', kind: 'manual' as const },
  { id: 'c2', description: 'docs updated', kind: 'manual' as const },
]

async function runParent(rig: ReturnType<typeof makeRig>): Promise<TaskRow> {
  const row = await rig.store.create({
    goal: 'do the thing',
    executor: 'chat-loop',
    agentId: 'a',
    origin: 'api',
    acceptanceCriteria: CRITERIA,
  })
  const terminal = await rig.waiter.wait(row.id, { deadlineMs: 5_000 })
  expect(terminal).toBeDefined()
  return terminal as TaskRow
}

describe('EvaluationCoordinator end-to-end', () => {
  it('verified when the verifier reports every criterion met — child row is auditable', async () => {
    const rig = makeRig((spec) => ({
      verdict: 'completed',
      summary: spec.goal.startsWith('You are an adversarial VERIFIER')
        ? 'verified everything'
        : 'did the work',
      artifacts: [],
      usage,
      ...(spec.goal.startsWith('You are an adversarial VERIFIER')
        ? {
            criteriaSelfReport: [
              { id: 'c1', met: true, evidence: 'suite green' },
              { id: 'c2', met: true, evidence: 'README diff' },
            ],
          }
        : {}),
    }))
    const parent = await runParent(rig)
    expect(parent.status).toBe('completed')
    expect(parent.eval?.verdict).toBe('verified')
    expect(parent.eval?.diverged).toBe(false)
    expect(parent.eval?.verifierTaskIds).toHaveLength(1)

    const child = await rig.store.get(parent.eval!.verifierTaskIds[0])
    expect(child?.origin).toBe('eval')
    expect(child?.parentTaskId).toBe(parent.id)
    expect(child?.acceptanceCriteria).toEqual([]) // structurally exempt (2b)
    expect(child?.eval).toBeUndefined() // a verifier is never verified
  })

  it('refuted + diverged when a criterion is unmet; parent status stays completed (verify-only)', async () => {
    const rig = makeRig((spec) => ({
      verdict: 'completed',
      summary: 'looked into it',
      artifacts: [],
      usage,
      ...(spec.goal.startsWith('You are an adversarial VERIFIER')
        ? {
            criteriaSelfReport: [
              { id: 'c1', met: true, evidence: 'ok' },
              { id: 'c2', met: false, evidence: 'no docs commit found' },
            ],
          }
        : {}),
    }))
    const parent = await runParent(rig)
    expect(parent.status).toBe('completed') // 2d does not change the terminal status
    expect(parent.eval?.verdict).toBe('refuted')
    expect(parent.eval?.diverged).toBe(true)
    expect(parent.eval?.criteriaReport.find((c) => c.id === 'c2')?.met).toBe(false)
  })

  it('verifier omitting a criterion refutes (skeptical default)', async () => {
    const rig = makeRig((spec) => ({
      verdict: 'completed',
      summary: 's',
      artifacts: [],
      usage,
      ...(spec.goal.startsWith('You are an adversarial VERIFIER')
        ? { criteriaSelfReport: [{ id: 'c1', met: true, evidence: 'ok' }] }
        : {}),
    }))
    const parent = await runParent(rig)
    expect(parent.eval?.verdict).toBe('refuted')
    expect(parent.eval?.criteriaReport.find((c) => c.id === 'c2')?.evidence).toContain(
      'did not report',
    )
  })

  it('no criteria / failed verdict / eval origin / interactive → no verifier spawned', async () => {
    const rig = makeRig(() => ({ verdict: 'completed', summary: 's', artifacts: [], usage }))
    const bare = await rig.store.create({
      goal: 'no criteria',
      executor: 'chat-loop',
      agentId: 'a',
      origin: 'api',
    })
    const terminal = await rig.waiter.wait(bare.id, { deadlineMs: 5_000 })
    expect(terminal?.eval).toBeUndefined()
    const all = await rig.store.list()
    expect(all.filter((r) => r.origin === 'eval')).toHaveLength(0)
  })
})

describe('inline verifier run (deadlock guard)', () => {
  it('verifies even when the job queue never fires (all slots blocked)', async () => {
    const executors = createExecutorRegistry()
    executors.register(
      'chat-loop',
      scriptedExecutor((spec) => ({
        verdict: 'completed',
        summary: 's',
        artifacts: [],
        usage,
        ...(spec.goal.startsWith('You are an adversarial VERIFIER')
          ? { criteriaSelfReport: CRITERIA.map((c) => ({ id: c.id, met: true, evidence: 'e' })) }
          : {}),
      })),
    )
    // Enqueue callback: fire the handler for the PARENT only — child jobs
    // are dropped, simulating a queue with no free slots.
    let handler: (taskId: string) => Promise<void>
    const fired = new Set<string>()
    const store = new InMemoryTaskStore((taskId) => {
      if (fired.size === 0) {
        fired.add(taskId)
        void handler(taskId)
      }
    })
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 5 })
    cleanups.push(() => waiter.stop())
    const coordinator = createEvaluationCoordinator({
      store,
      waiter,
      nodeId: 'test-node',
      config: { skipOrigins: [] },
      runTask: (taskId) => handler(taskId),
    })
    handler = createTaskHandler({ store, executors, nodeId: 'test-node', evaluation: coordinator })

    const row = await store.create({
      goal: 'do it',
      executor: 'chat-loop',
      agentId: 'a',
      origin: 'api',
      acceptanceCriteria: CRITERIA,
    })
    const terminal = await waiter.wait(row.id, { deadlineMs: 5_000 })
    expect(terminal?.eval?.verdict).toBe('verified')
  })
})

describe('mapVerifierResult', () => {
  const criteria = CRITERIA
  it('all met → verified', () => {
    const r = mapVerifierResult('t', criteria, {
      verdict: 'completed',
      summary: 's',
      artifacts: [],
      usage,
      criteriaSelfReport: [
        { id: 'c1', met: true, evidence: 'e' },
        { id: 'c2', met: true, evidence: 'e' },
      ],
    })
    expect(r.verdict).toBe('verified')
  })

  it('no self-report at all → refuted with per-criterion evidence gaps', () => {
    const r = mapVerifierResult('t', criteria, {
      verdict: 'completed',
      summary: 's',
      artifacts: [],
      usage,
    })
    expect(r.verdict).toBe('refuted')
    expect(r.refutation).toContain('c1')
    expect(r.refutation).toContain('c2')
  })
})
