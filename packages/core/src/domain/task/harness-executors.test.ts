/**
 * Per-harness executor tests — the harness-id registry keying, the
 * `claude-cli` → `claude-code` deprecation window, and the honest
 * not-implemented executors (Phase 3).
 *
 * The end-to-end assertion is the last describe: a task row aimed at
 * `kimi-code` reaches a terminal 'failed' with the typed
 * `capability_unsupported` code and a reason, instead of the anonymous
 * `executor_not_registered` a missing registration produces.
 */

import { describe, expect, it, vi } from 'vitest'
import { HARNESS_IDS, HarnessError } from '@rivetos/types'
import type { HarnessExecutor, TaskEvent } from '@rivetos/types'
import {
  DEPRECATED_EXECUTOR_TARGETS,
  HARNESS_EXECUTOR_GAPS,
  canonicalizeExecutorTarget,
  createNotImplementedHarnessExecutor,
  harnessExecutorCoverage,
  harnessExecutorGap,
  harnessExecutorUnsupported,
  isHarnessExecutorTarget,
  isNotImplementedHarnessExecutor,
} from './harness-executors.js'
import { createExecutorRegistry, createTaskHandler } from './runner.js'
import { InMemoryTaskStore } from './store.js'
import { makeConformanceSpec } from './test/executor-conformance.js'

function fakeExecutor(name: string): HarnessExecutor {
  return {
    name,
    capabilities: () => ({
      steerable: true,
      multiTurn: true,
      structuredStream: true,
      usageInResult: true,
      sessionIdCapture: true,
      slashCommands: false,
      effortSelection: false,
      mcpInjection: 'none',
    }),
    start: () => {
      throw new Error('not executed here')
    },
  }
}

// ---------------------------------------------------------------------------
// Target vocabulary + the rename alias
// ---------------------------------------------------------------------------

describe('executor targets', () => {
  it('accepts every harness id as a target', () => {
    for (const id of HARNESS_IDS) expect(isHarnessExecutorTarget(id)).toBe(true)
    // The provider-plugin name is NOT a harness id — that is the whole point
    // of the rename.
    expect(isHarnessExecutorTarget('claude-cli')).toBe(false)
  })

  it('canonicalizes the deprecated claude-cli target and names the alias', () => {
    expect(canonicalizeExecutorTarget('claude-cli')).toEqual({
      target: 'claude-code',
      deprecatedAlias: 'claude-cli',
    })
    expect(DEPRECATED_EXECUTOR_TARGETS['claude-cli']).toBe('claude-code')
  })

  it('passes through canonical, unknown and absent targets untouched', () => {
    expect(canonicalizeExecutorTarget('claude-code')).toEqual({ target: 'claude-code' })
    expect(canonicalizeExecutorTarget('something-else')).toEqual({ target: 'something-else' })
    expect(canonicalizeExecutorTarget(undefined)).toEqual({ target: undefined })
  })
})

// ---------------------------------------------------------------------------
// Registry: harness-id keying + deprecation window
// ---------------------------------------------------------------------------

describe('executor registry harness keying', () => {
  it('resolves a claude-code registration through the legacy claude-cli target', () => {
    const onDeprecatedTarget = vi.fn()
    const registry = createExecutorRegistry({ onDeprecatedTarget })
    const executor = fakeExecutor('claude-code')
    registry.register('harness-session', executor, 'claude-code')

    expect(registry.resolve('harness-session', 'claude-cli')).toBe(executor)
    expect(onDeprecatedTarget).toHaveBeenCalledWith('claude-cli', 'claude-code')
  })

  it('canonicalizes on register too, so a legacy registration keys as claude-code', () => {
    const registry = createExecutorRegistry({ onDeprecatedTarget: vi.fn() })
    const executor = fakeExecutor('claude-code')
    registry.register('harness-session', executor, 'claude-cli')

    expect(registry.resolve('harness-session', 'claude-code')).toBe(executor)
    expect(registry.entries().map((e) => e.key)).toEqual(['harness-session:claude-code'])
  })

  it('warns once per legacy target, not once per task', () => {
    const onDeprecatedTarget = vi.fn()
    const registry = createExecutorRegistry({ onDeprecatedTarget })
    registry.register('harness-session', fakeExecutor('claude-code'), 'claude-code')

    for (let i = 0; i < 5; i++) registry.resolve('harness-session', 'claude-cli')

    expect(onDeprecatedTarget).toHaveBeenCalledTimes(1)
  })

  it('leaves non-harness kinds alone — the alias is harness-session vocabulary', () => {
    const onDeprecatedTarget = vi.fn()
    const registry = createExecutorRegistry({ onDeprecatedTarget })
    const executor = fakeExecutor('mesh-thing')
    registry.register('mesh', executor, 'claude-cli')

    expect(registry.resolve('mesh', 'claude-cli')).toBe(executor)
    expect(registry.resolve('mesh', 'claude-code')).toBeUndefined()
    expect(onDeprecatedTarget).not.toHaveBeenCalled()
  })

  it('reports per-harness coverage without the kind-level fallback', () => {
    const registry = createExecutorRegistry()
    // A kind-level harness-session registration must NOT make every harness
    // look covered — resolve() would fall back to it, harnesses() must not.
    registry.register('harness-session', fakeExecutor('kind-level'))
    registry.register('harness-session', fakeExecutor('claude-code'), 'claude-code')
    registry.register(
      'harness-session',
      createNotImplementedHarnessExecutor('kimi-code', { reason: 'no spawn machinery' }),
      'kimi-code',
    )

    expect(registry.harnesses()).toEqual([
      { harnessId: 'claude-code', registered: true, implemented: true },
      { harnessId: 'grok-build', registered: false, implemented: false },
      { harnessId: 'kimi-code', registered: true, implemented: false },
      { harnessId: 'hermes', registered: false, implemented: false },
    ])
  })

  it('harnessExecutorCoverage covers every harness id exactly once', () => {
    const rows = harnessExecutorCoverage(() => undefined)
    expect(rows.map((r) => r.harnessId)).toEqual([...HARNESS_IDS])
  })
})

// ---------------------------------------------------------------------------
// Not-implemented executors
// ---------------------------------------------------------------------------

describe('not-implemented harness executor', () => {
  const make = (): HarnessExecutor =>
    createNotImplementedHarnessExecutor('grok-build', {
      reason: harnessExecutorGap('grok-build'),
    })

  it('is flagged as a rejection, not a harness', () => {
    expect(isNotImplementedHarnessExecutor(make())).toBe(true)
    expect(isNotImplementedHarnessExecutor(fakeExecutor('claude-code'))).toBe(false)
  })

  it('declares no capabilities and names the harness', () => {
    const executor = make()
    expect(executor.name).toBe('grok-build')
    expect(executor.capabilities()).toEqual({
      steerable: false,
      multiTurn: false,
      structuredStream: false,
      usageInResult: false,
      sessionIdCapture: false,
      slashCommands: false,
      effortSelection: false,
      mcpInjection: 'none',
    })
  })

  it('resolves (never rejects) with a typed, actionable failure', async () => {
    const handle = make().start(makeConformanceSpec(), { signal: new AbortController().signal })
    const result = await handle.result

    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/^capability_unsupported: /)
    // Actionable: it says which harness and what is missing, not just "no".
    expect(result.summary).toContain('grok-build')
    expect(result.summary).toContain('interactive PTY')
    expect(result.usage.turns).toBe(0)
  })

  it('logs the reason once on the events iterable, then completes', async () => {
    const handle = make().start(makeConformanceSpec(), { signal: new AbortController().signal })
    const seen: TaskEvent[] = []
    for await (const event of handle.events) seen.push(event)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'log', level: 'error' })
    await expect(handle.kill('no-op')).resolves.toBeUndefined()
  })

  it('rejects steering with the typed harness error', async () => {
    const handle = make().start(makeConformanceSpec(), { signal: new AbortController().signal })
    await expect(handle.steer('carry on')).rejects.toBeInstanceOf(HarnessError)
    await expect(handle.steer('carry on')).rejects.toMatchObject({
      code: 'capability_unsupported',
      harnessId: 'grok-build',
      retryable: false,
    })
  })

  it('carries a caller-supplied reason verbatim — boot overrides the recorded gap', () => {
    // The mechanism boot uses to report the REAL cause (unresolvable binary,
    // provider package that would not load) instead of the generic gap text.
    const probeFailure = 'the `claude` binary is not resolvable on this node (tried "claude")'
    const executor = createNotImplementedHarnessExecutor('claude-code', { reason: probeFailure })
    const handle = executor.start(makeConformanceSpec(), { signal: new AbortController().signal })
    return handle.result.then((result) => {
      expect(result.summary).toContain(probeFailure)
      expect(result.summary).not.toContain('no task executor is wired')
    })
  })

  it('harnessExecutorUnsupported carries the dispatch context', () => {
    const err = harnessExecutorUnsupported('hermes', 'no driver yet')
    expect(err).toBeInstanceOf(HarnessError)
    expect(err.code).toBe('capability_unsupported')
    expect(err.context).toMatchObject({
      executor: 'harness-session',
      executorTarget: 'hermes',
      harnessId: 'hermes',
    })
  })

  it('every gap reason is real prose, one per unimplemented harness', () => {
    for (const id of ['grok-build', 'hermes']) {
      expect(harnessExecutorGap(id).length).toBeGreaterThan(40)
    }
    // claude-code and kimi-code are implemented — no recorded gap, so they
    // fall back to the generic reason rather than keeping stale prose. A
    // rejection for either can only come from boot's probe, which supplies
    // its own reason (see the boot-override case below).
    for (const id of ['claude-code', 'kimi-code']) {
      expect(HARNESS_EXECUTOR_GAPS[id]).toBeUndefined()
      expect(harnessExecutorGap(id)).toContain('no task executor is wired')
    }
  })
})

// ---------------------------------------------------------------------------
// Through the runner: a registered rejection beats a silent absence
// ---------------------------------------------------------------------------

describe('task handler with a not-implemented harness executor', () => {
  it('fails the row with the typed code and the reason', async () => {
    // kimi-code has a real executor now, so the realistic rejection is boot's
    // probe reason on a node where the binary is missing — the shape a task
    // row actually sees there.
    const probeFailure =
      'the `kimi` binary is not resolvable on this node (tried "kimi"): install Kimi Code'
    const store = new InMemoryTaskStore()
    const executors = createExecutorRegistry()
    executors.register(
      'harness-session',
      createNotImplementedHarnessExecutor('kimi-code', { reason: probeFailure }),
      'kimi-code',
    )
    const handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
    const task = await store.create({
      goal: 'Do the thing',
      executor: 'harness-session',
      executorTarget: 'kimi-code',
      agentId: 'kimi',
      origin: 'tool',
    })

    await handler(task.id)

    const row = await store.get(task.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toMatch(/^capability_unsupported: /)
    expect(row?.result?.summary).toContain('kimi-code')
    // Not the anonymous miss the old silent-absence path produced.
    expect(row?.error).not.toBe('executor_not_registered')
  })

  it('a legacy claude-cli row still reaches the claude-code executor', async () => {
    const store = new InMemoryTaskStore()
    const onDeprecatedTarget = vi.fn()
    const executors = createExecutorRegistry({ onDeprecatedTarget })
    const started: string[] = []
    executors.register(
      'harness-session',
      {
        ...fakeExecutor('claude-code'),
        start: () => {
          started.push('claude-code')
          return {
            events: (async function* () {
              await Promise.resolve()
            })(),
            steer: () => Promise.resolve(),
            kill: () => Promise.resolve(),
            result: Promise.resolve({
              verdict: 'completed' as const,
              summary: 'done',
              artifacts: [],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
                turns: 1,
                wallClockMs: 1,
              },
            }),
          }
        },
      },
      'claude-code',
    )
    const handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
    const task = await store.create({
      goal: 'Do the thing',
      executor: 'harness-session',
      executorTarget: 'claude-cli', // queued before the rename
      agentId: 'claude',
      origin: 'tool',
    })

    await handler(task.id)

    expect(started).toEqual(['claude-code'])
    expect((await store.get(task.id))?.status).toBe('completed')
    expect(onDeprecatedTarget).toHaveBeenCalledWith('claude-cli', 'claude-code')
  })
})
