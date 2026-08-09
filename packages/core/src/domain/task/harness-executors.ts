/**
 * Per-harness `harness-session` executors — the task engine's half of the
 * harness control plane (docs/plans/harness-control-plane.md § Phase 3).
 *
 * The executor registry keys `harness-session` on a HARNESS ID, the same
 * `claude-code | grok-build | kimi-code | hermes` vocabulary `SessionId`,
 * `HarnessDriver` and the gateway already speak. Before this, the one CLI
 * executor registered under the PROVIDER name `claude-cli`, so a task row and
 * a session id disagreed about what to call the same harness.
 *
 * Two things live here:
 *
 *   - **Alias resolution.** `claude-cli` is accepted as a deprecated alias for
 *     `claude-code` for one window — same treatment the doc gives legacy
 *     session keys: resolve it, warn once, keep reads working while the rows
 *     that predate the rename drain. Nothing writes the legacy target anymore.
 *
 *   - **Honest not-implemented executors.** grok-build, kimi-code and hermes
 *     cannot spawn a session for a task to run in — the grok driver spawns a
 *     PTY, and hermes and kimi-code can only ADOPT a session the roster started
 *     (neither has a flag to pin a new id) — so their executors are
 *     explicit rejections, not absences. A task aimed at one fails immediately with the typed
 *     `capability_unsupported` code and a message that says what is missing,
 *     rather than the registry's anonymous `executor_not_registered` miss, and
 *     `GET /api/catalog` lists the harness with `implemented: false` so a UI
 *     can grey the option instead of offering a trap.
 */

import { HarnessError, HARNESS_IDS } from '@rivetos/types'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  HarnessId,
  TaskEvent,
  TaskHandle,
  TaskResult,
  TaskSpec,
  TaskUsage,
} from '@rivetos/types'

// ---------------------------------------------------------------------------
// Harness-id executor targets + the rename alias
// ---------------------------------------------------------------------------

/**
 * Retired executor targets → the harness id that replaced them.
 *
 * `claude-cli` was the provider-plugin name doing duty as an executor id. Rows
 * queued before the rename still carry it, so the registry keeps resolving it
 * (with a warning) until they drain; nothing writes it.
 */
export const DEPRECATED_EXECUTOR_TARGETS: Readonly<Partial<Record<string, HarnessId>>> =
  Object.freeze({
    'claude-cli': 'claude-code',
  })

/** `true` when `target` names a harness on the control plane. */
export function isHarnessExecutorTarget(target: string): target is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(target)
}

/**
 * Canonicalize an executor target. Returns the target unchanged unless it is a
 * retired alias, in which case `deprecatedAlias` carries what the caller said
 * so the log line can name it.
 */
export function canonicalizeExecutorTarget(target: string | undefined): {
  target: string | undefined
  deprecatedAlias?: string
} {
  if (target === undefined) return { target }
  const canonical = DEPRECATED_EXECUTOR_TARGETS[target]
  return canonical ? { target: canonical, deprecatedAlias: target } : { target }
}

// ---------------------------------------------------------------------------
// Not-implemented executors
// ---------------------------------------------------------------------------

/** Marks an executor as a registered rejection rather than a real harness. */
const NOT_IMPLEMENTED = Symbol.for('rivetos.task.not-implemented-executor')

/** `true` for executors built by `createNotImplementedHarnessExecutor`. */
export function isNotImplementedHarnessExecutor(executor: HarnessExecutor): boolean {
  return (executor as unknown as Record<symbol, unknown>)[NOT_IMPLEMENTED] === true
}

export interface NotImplementedHarnessExecutorOptions {
  /** Why this harness cannot run a task here — surfaced to the requester. */
  reason: string
}

/** The typed rejection a not-implemented harness executor reports. */
export function harnessExecutorUnsupported(harnessId: string, reason: string): HarnessError {
  return new HarnessError(
    'capability_unsupported',
    `no task executor for harness "${harnessId}": ${reason}`,
    { harnessId, context: { executor: 'harness-session', executorTarget: harnessId } },
  )
}

function emptyUsage(): TaskUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, wallClockMs: 0 }
}

/** Every capability off — there is nothing behind this executor to do them. */
function noCapabilities(): HarnessExecutorCapabilities {
  return {
    steerable: false,
    multiTurn: false,
    structuredStream: false,
    usageInResult: false,
    sessionIdCapture: false,
    slashCommands: false,
    effortSelection: false,
    mcpInjection: 'none',
  }
}

/**
 * An executor that exists solely to reject, typed and out loud.
 *
 * Contract-faithful where it matters: `result` resolves (never rejects) with
 * verdict 'failed' carrying the `capability_unsupported` code, and the events
 * iterable completes after one error log — so the runner records a normal
 * terminal row and the requester reads a real reason. `steer` is the one
 * method that throws: steering something that never started is a caller bug,
 * and the typed error says so.
 */
export function createNotImplementedHarnessExecutor(
  harnessId: HarnessId,
  opts: NotImplementedHarnessExecutorOptions,
): HarnessExecutor {
  const error = harnessExecutorUnsupported(harnessId, opts.reason)
  const executor: HarnessExecutor = {
    name: harnessId,
    capabilities: noCapabilities,
    start(_spec: TaskSpec): TaskHandle {
      // Live-stream only: the task engine persists turn.end and the terminal
      // result, never 'log' events. The reason reaches durable storage through
      // result.summary / result.error below — do not rely on this event for
      // observability after the fact.
      const event: TaskEvent = {
        ts: Date.now(),
        type: 'log',
        level: 'error',
        message: error.message,
      }
      const result: TaskResult = {
        verdict: 'failed',
        summary: error.message,
        artifacts: [],
        usage: emptyUsage(),
        error: `${error.code}: ${error.message}`,
      }
      return {
        // eslint-disable-next-line @typescript-eslint/require-await
        events: (async function* () {
          yield event
        })(),
        steer: () => Promise.reject(error),
        kill: () => Promise.resolve(),
        result: Promise.resolve(result),
      }
    },
  }
  Object.defineProperty(executor, NOT_IMPLEMENTED, { value: true, enumerable: false })
  return executor
}

// ---------------------------------------------------------------------------
// Coverage sheet
// ---------------------------------------------------------------------------

export interface HarnessExecutorCoverage {
  harnessId: HarnessId
  /** An executor is registered for this harness id (real or rejecting). */
  registered: boolean
  /** The registered executor actually runs the harness. */
  implemented: boolean
}

/**
 * One row per harness id: what the node can actually execute. Backs the
 * catalog sheet and the boot summary line.
 */
export function harnessExecutorCoverage(
  resolve: (target: HarnessId) => HarnessExecutor | undefined,
): HarnessExecutorCoverage[] {
  return HARNESS_IDS.map((harnessId) => {
    const executor = resolve(harnessId)
    return {
      harnessId,
      registered: executor !== undefined,
      implemented: executor !== undefined && !isNotImplementedHarnessExecutor(executor),
    }
  })
}

/**
 * Why each harness has no executor here. Kept beside the registrations so the
 * message a failing task shows is the same one the code review can check.
 *
 * Not aspirational text: each line is what the repo actually has today.
 */
export const HARNESS_EXECUTOR_GAPS: Readonly<Partial<Record<string, string>>> = Object.freeze({
  'grok-build':
    'no node-side headless machinery: the Grok Build integration on this node drives an ' +
    'interactive PTY (den term manager --session-id/--resume) with hook-fed capture. The ' +
    'headless protocol that WOULD carry an executor is ACP (`grok agent stdio`) — it streams ' +
    'tool_call/tool_call_update, thought chunks and real token usage, unlike the ' +
    'streaming-json output, which carries thought/text/end only. It is driven today solely ' +
    'from the Android bridge rootfs, so wiring ACP node-side is the future executor basis',
  'kimi-code':
    'the kimi-code driver cannot START a session for a task to run in: kimi has no flag ' +
    'to pin a new session id (-S/--session resumes an existing one), so it only ever adopts ' +
    'sessions the roster spawned. Its Stop hook also carries no assistant reply to parse a ' +
    'result from — a task result would have to come from the wire.jsonl transcript',
  hermes:
    'the hermes driver cannot START a session for a task to run in: hermes has no flag ' +
    'to pin a new session id, so it only ever adopts sessions the roster spawned ' +
    '(HermesDriver.startSession answers capability_unsupported for the same reason)',
})

/** The recorded gap for a harness, or a generic one for an unlisted id. */
export function harnessExecutorGap(harnessId: string): string {
  return (
    HARNESS_EXECUTOR_GAPS[harnessId] ?? 'no task executor is wired for this harness on this node'
  )
}
