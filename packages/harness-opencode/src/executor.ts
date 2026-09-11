/**
 * OpencodeExecutor — HarnessExecutor over headless `opencode run` spawns.
 *
 * Shape per start():
 *   - Turn 1 runs `spec.resumeMessage ?? spec.goal` in a FRESH opencode
 *     session (`opencode run --format json <prompt>`, no `--session`).
 *     `steer()` queues follow-up turns; turn N spawns
 *     `opencode run --session <native-id> --format json`, so every turn of a
 *     task shares ONE native session and its context.
 *   - There is no `--append-system-prompt`, so the task scaffold (context +
 *     acceptance criteria + the TASK_RESULT fence contract) is PREPENDED to
 *     the prompt text of every turn.
 *   - JSON stream → TaskEvent: text parts → den message.agent, tool-use
 *     running → den tool.start, tool-use completed → den tool.end.
 *     Session id is adopted from SQLite (newest `session` row for this cwd
 *     created after spawn start) or, if present, from a json event.
 *     Canonicalized onto `opencode:<native-id>`. There is no flag to pin a
 *     NEW session id.
 *   - Usage arrives POST-HOC from the session's message rows after the child
 *     exits — see wire.ts. Stream `step-finish` / assistant-envelope tokens
 *     are a fallback when the store is empty. A reconcile that finds nothing
 *     degrades to zero usage and a warning; it can never fail a turn.
 *   - Structured result: `parseTaskResultBlock` over the turn's text, falling
 *     back to {verdict:'completed', summary:<last text>}. `result` NEVER
 *     rejects.
 *   - kill(): SIGTERM then SIGKILL after the grace period → verdict 'killed'.
 *
 * A refused `--session` (any non-zero exit while `-s` was passed) retries
 * once fresh. A fresh spawn that exits non-zero is a failed turn.
 *
 * Task association (#467) is the claude contract verbatim: `RIVETOS_TASK_ID`
 * on the child env, the inherited `RIVETOS_SESSION_KEY` explicitly DELETED,
 * `RIVETOS_DEN_HOOK_DISABLED=1` because this executor owns den emission.
 *
 * Locked constraint: NO RivetOS-side per-turn timeout. The runner enforces
 * budget between turns via the abort signal.
 */

import type {
  AgentEventBody,
  HarnessExecutor,
  HarnessExecutorCapabilities,
  HarnessId,
  Memory,
  TaskEvent,
  TaskHandle,
  TaskResult,
  TaskSpec,
  TaskUsage,
} from '@rivetos/types'
import {
  formatSessionId,
  isSessionId,
  parseTaskResultBlock,
  taskResultFenceInstructions,
} from '@rivetos/types'
import { createLogger, type HarnessLogger } from './log.js'
import { spawnOpencodeTurn, type SpawnedTurn } from './spawn-turn.js'
import {
  emptyWireTurnFacts,
  newestSessionAfter,
  opencodeHome,
  parseOpencodeEvent,
  reconcileTurn,
  xdgDataHomeFor,
  type WireTurnFacts,
} from './wire.js'

/**
 * Harness id this executor registers under (`HARNESS_IDS`).
 *
 * Types PR may land in parallel; the cast keeps this package typechecking
 * if `opencode` is not in the union yet. `canonicalOpencodeSessionId` still
 * emits the `opencode:` prefix when `formatSessionId` rejects.
 */
export const OPENCODE_HARNESS_ID = 'opencode' as HarnessId

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpencodeExecutorConfig {
  /** Path to the `opencode` binary. */
  binary: string
  /** Default model id (spec.model overrides). Empty = the CLI's default. */
  modelId?: string
  /** Default RivetOS effort (spec.effort overrides). Mapped to `--variant`. */
  effort?: string
  /**
   * Default working directory (spec.workingDir overrides). Pins the storage
   * project and scopes `--session` resume — every turn of a task uses the
   * same one.
   */
  cwd?: string
  /**
   * Data dir for SQLite reconcile (`opencode.db`). Default: the ambient home
   * (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). Also sets the
   * child's `XDG_DATA_HOME` so the CLI writes the same place.
   */
  opencodeHome?: string
  /** Override the SIGTERM→SIGKILL grace (tests use a short one). */
  killGraceMs?: number
  /**
   * Task-conversation source for resume rehydration. Used when a task resumes
   * from awaiting-input in a NEW process (no native session in hand) and when
   * a `--session` resume is rejected — see `renderResumeTranscript`.
   */
  memory?: Pick<Memory, 'getSessionHistory' | 'getTaskHistory'>
}

/** Caps for the rendered resume transcript — keep the prompt sane. */
const RESUME_TRANSCRIPT_MAX_CHARS = 24_000
const RESUME_MESSAGE_MAX_CHARS = 2_000
const RESUME_HISTORY_LIMIT = 1000

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * The task scaffold. Mirrors the claude executor's system append field for
 * field — same contract, different delivery channel (prompt text, because
 * `opencode run` has no append-system-prompt).
 */
export function buildTaskScaffold(spec: TaskSpec): string {
  const parts = [
    '## Task Context',
    'You are executing a delegated RivetOS task. Complete it thoroughly.',
    spec.resolvedContext ? `### Context\n${spec.resolvedContext}` : '',
    spec.acceptanceCriteria.length > 0
      ? `### Acceptance criteria\n${spec.acceptanceCriteria
          .map((c) => `- [${c.id}] ${c.description}`)
          .join('\n')}`
      : '',
    spec.systemPromptAppend ?? '',
    taskResultFenceInstructions(),
  ]
  return parts.filter(Boolean).join('\n\n')
}

/**
 * One turn's prompt: scaffold, optional rehydrated transcript, then the turn's
 * message under a heading.
 *
 * The scaffold going first is load-bearing beyond readability: a task whose
 * goal text happens to begin with a slash command cannot hijack the spawn,
 * because the scaffold always precedes it.
 */
export function buildTurnPrompt(parts: {
  scaffold: string
  transcript?: string
  message: string
}): string {
  return [parts.scaffold, parts.transcript ?? '', `## This turn\n${parts.message}`]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Read a task's transcript: the union of every conversation the task spawned.
 * `getTaskHistory` is optional on Memory; the fallback reads the legacy
 * `task:<id>` key, which degrades to "no rehydration", never to wrong context.
 */
export async function readTaskHistory(
  memory: Pick<Memory, 'getSessionHistory' | 'getTaskHistory'>,
  taskId: string,
): Promise<Array<{ role: string; content: unknown }>> {
  const options = { limit: RESUME_HISTORY_LIMIT }
  return memory.getTaskHistory
    ? await memory.getTaskHistory(taskId, options)
    : await memory.getSessionHistory(`task:${taskId}`, options)
}

/**
 * Render prior conversation for a spawn that has no native session to resume:
 * role-labeled, newest-preserved, each message truncated. '' when unusable.
 */
export function renderResumeTranscript(history: Array<{ role: string; content: unknown }>): string {
  const lines: string[] = []
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (typeof m.content !== 'string' || m.content.trim() === '') continue
    const body =
      m.content.length > RESUME_MESSAGE_MAX_CHARS
        ? m.content.slice(0, RESUME_MESSAGE_MAX_CHARS) + '\n…[truncated]'
        : m.content
    lines.push(`[${m.role}]\n${body}`)
  }
  if (lines.length === 0) return ''
  let total = lines.reduce((n, l) => n + l.length + 2, 0)
  let start = 0
  while (total > RESUME_TRANSCRIPT_MAX_CHARS && start < lines.length - 1) {
    total -= lines[start].length + 2
    start++
  }
  const kept = lines.slice(start)
  const dropped = start > 0 ? `(${String(start)} earlier message(s) omitted)\n\n` : ''
  return `### Prior conversation (task resumed — do NOT redo completed work)\n${dropped}${kept.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

/**
 * Canonicalize opencode's native session id onto the control plane's one id
 * format, `opencode:<native>`.
 *
 * Adoption, not pinning: a fresh `run` mints the id. An id already carrying a
 * prefix, or one the codec rejects because `opencode` is not yet in
 * `HARNESS_IDS`, still gets the `opencode:` prefix — a non-canonical
 * breadcrumb beats none, and the prefix is what capture joins on.
 */
export function canonicalOpencodeSessionId(nativeId: string | undefined): string | undefined {
  if (nativeId === undefined || nativeId === '') return undefined
  if (nativeId.startsWith('opencode:')) return nativeId
  if (isSessionId(nativeId)) return nativeId
  try {
    return formatSessionId(OPENCODE_HARNESS_ID, nativeId)
  } catch {
    // formatSessionId rejects unknown harness ids AND malformed native ids.
    // If the only problem is `opencode` missing from HARNESS_IDS, still prefix.
    // Whitespace / empty native ids pass through verbatim — same as kimi.
    if (nativeId !== nativeId.trim()) return nativeId
    return `opencode:${nativeId}`
  }
}

// ---------------------------------------------------------------------------
// Event queue — unbounded push queue exposed as an AsyncIterable
// ---------------------------------------------------------------------------

class EventQueue implements AsyncIterable<TaskEvent> {
  private buffer: TaskEvent[] = []
  private waiters: Array<(r: IteratorResult<TaskEvent>) => void> = []
  private closed = false

  push(event: TaskEvent): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.buffer.push(event)
  }

  done(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TaskEvent> {
    return {
      next: (): Promise<IteratorResult<TaskEvent>> => {
        const buffered = this.buffer.shift()
        if (buffered) return Promise.resolve({ value: buffered, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

function emptyUsage(): TaskUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, wallClockMs: 0 }
}

interface SpawnOutcome {
  text: string
  sessionId?: string
  error?: string
  /** opencode refused the `--session` — the caller may retry on a fresh one. */
  resumeRejected: boolean
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class OpencodeExecutor implements HarnessExecutor {
  readonly name = OPENCODE_HARNESS_ID
  private readonly cfg: OpencodeExecutorConfig
  private readonly log: HarnessLogger

  constructor(cfg: OpencodeExecutorConfig) {
    this.cfg = cfg
    this.log = createLogger('opencode-executor')
  }

  capabilities(): HarnessExecutorCapabilities {
    return {
      steerable: true, // between turns — no mid-spawn steering
      multiTurn: true, // native `--session` resume, one session across the task
      structuredStream: true, // --format json text/tool/step-finish lines
      usageInResult: true, // reconciled from sqlite, stream as fallback
      sessionIdCapture: true, // sqlite session row, json events as fallback
      slashCommands: false,
      effortSelection: true, // --variant via spec.effort
      // No per-turn MCP flag: servers come from opencode.json, shared with the TUI.
      mcpInjection: 'persistent-config',
    }
  }

  start(spec: TaskSpec, opts: { signal: AbortSignal }): TaskHandle {
    const events = new EventQueue()
    const steered: string[] = []
    let killed = false
    let killReason: string | undefined
    let finished = false
    let activeSpawn: SpawnedTurn | undefined

    const killNow = (reason?: string): void => {
      killed = true
      killReason ??= reason
      activeSpawn?.kill()
    }

    if (opts.signal.aborted) killNow(String(opts.signal.reason ?? 'aborted'))
    else {
      opts.signal.addEventListener(
        'abort',
        () => {
          killNow(String(opts.signal.reason ?? 'aborted'))
        },
        { once: true },
      )
    }

    const result: Promise<TaskResult> = this.runTask(spec, {
      events,
      nextSteer: () => steered.shift(),
      isKilled: () => killed,
      killReason: () => killReason,
      setActiveSpawn: (s) => {
        activeSpawn = s
        if (killed) s?.kill()
      },
    })
      .catch((err: unknown) => {
        // Belt-and-braces: runTask already catches; result must never reject.
        const msg = err instanceof Error ? err.message : String(err)
        this.log.error('executor.crashed', { taskId: spec.taskId, error: msg })
        const fallback: TaskResult = {
          verdict: killed ? 'killed' : 'failed',
          summary: `Executor crashed: ${msg}`,
          artifacts: [],
          usage: emptyUsage(),
          error: msg,
        }
        return fallback
      })
      .finally(() => {
        finished = true
        events.done()
      })

    return {
      events,
      steer(message: string): Promise<void> {
        if (!finished) steered.push(message)
        return Promise.resolve()
      },
      kill(reason?: string): Promise<void> {
        killNow(reason ?? 'killed')
        return Promise.resolve()
      },
      result,
    }
  }

  // -------------------------------------------------------------------------
  // Turn loop
  // -------------------------------------------------------------------------

  private async runTask(
    spec: TaskSpec,
    run: {
      events: EventQueue
      nextSteer: () => string | undefined
      isKilled: () => boolean
      killReason: () => string | undefined
      setActiveSpawn: (s: SpawnedTurn | undefined) => void
    },
  ): Promise<TaskResult> {
    const startedAt = Date.now()
    const usage = emptyUsage()
    const scaffold = buildTaskScaffold(spec)

    // Resume from awaiting-input in a fresh process: there is no native
    // session to attach to, so the task's own transcript is rendered into the
    // opening prompt. Failure degrades to no transcript — losing context is
    // survivable, failing the resume is not.
    let transcript = spec.resumeMessage !== undefined ? await this.renderTaskTranscript(spec) : ''

    let lastText = ''
    let lastError: string | undefined
    let nativeSessionId: string | undefined
    let message: string | undefined = spec.resumeMessage ?? spec.goal

    while (message !== undefined && !run.isKilled()) {
      usage.turns += 1
      run.events.push({ ts: Date.now(), type: 'turn.start', turn: usage.turns })

      let turn = await this.runOneSpawn(spec, run, usage, {
        prompt: buildTurnPrompt({ scaffold, transcript, message }),
        resumeSessionId: nativeSessionId,
      })

      // A `--session` opencode refuses (session pruned, or the known
      // "Session not found" quirk) is not a failed turn when we WERE
      // resuming: fall back to a fresh session seeded with the task's
      // rendered history, exactly like a cross-process resume, and adopt
      // the new native id from there on.
      if (turn.resumeRejected && !run.isKilled()) {
        this.log.warn('task.resume.rejected', {
          taskId: spec.taskId,
          sessionId: nativeSessionId,
          error: turn.error,
        })
        run.events.push({
          ts: Date.now(),
          type: 'log',
          level: 'warn',
          message: `opencode refused to resume ${String(nativeSessionId)} — starting a fresh session`,
        })
        nativeSessionId = undefined
        transcript = await this.renderTaskTranscript(spec)
        turn = await this.runOneSpawn(spec, run, usage, {
          prompt: buildTurnPrompt({ scaffold, transcript, message }),
        })
      }

      if (turn.sessionId) nativeSessionId = turn.sessionId
      usage.wallClockMs = Date.now() - startedAt
      run.events.push({
        ts: Date.now(),
        type: 'turn.end',
        turn: usage.turns,
        usage: { ...usage },
        harnessSessionId: canonicalOpencodeSessionId(nativeSessionId),
      })

      if (turn.text) lastText = turn.text
      if (turn.error) {
        lastError = turn.error
        break
      }
      // Native context now carries everything; the rendered transcript would
      // only duplicate it on the resumed turns that follow.
      transcript = ''
      message = run.nextSteer()
    }

    usage.wallClockMs = Date.now() - startedAt

    if (run.isKilled()) {
      return {
        verdict: 'killed',
        summary: run.killReason() ?? 'Killed',
        output: lastText || undefined,
        artifacts: [],
        usage,
        error: run.killReason(),
      }
    }

    if (lastError !== undefined) {
      return {
        verdict: 'failed',
        summary: lastError,
        output: lastText || undefined,
        artifacts: [],
        usage,
        error: lastError,
      }
    }

    const parsed = parseTaskResultBlock(lastText)
    if (parsed) return { ...parsed, output: parsed.output ?? lastText, usage }
    return {
      verdict: 'completed',
      summary: lastText,
      output: lastText || undefined,
      artifacts: [],
      usage,
    }
  }

  private async renderTaskTranscript(spec: TaskSpec): Promise<string> {
    if (!this.cfg.memory) return ''
    try {
      return renderResumeTranscript(await readTaskHistory(this.cfg.memory, spec.taskId))
    } catch (err: unknown) {
      this.log.warn('task.resume.rehydration.failed', {
        taskId: spec.taskId,
        error: err instanceof Error ? err.message : String(err),
      })
      return ''
    }
  }

  /**
   * One `opencode run` spawn: translate JSON events into den TaskEvents, then
   * read the session's message records for usage. Failures come back as
   * `error` (never thrown) so the caller's result contract holds.
   */
  private async runOneSpawn(
    spec: TaskSpec,
    run: {
      events: EventQueue
      isKilled: () => boolean
      setActiveSpawn: (s: SpawnedTurn | undefined) => void
    },
    usage: TaskUsage,
    turn: { prompt: string; resumeSessionId?: string },
  ): Promise<SpawnOutcome> {
    const den = (event: AgentEventBody): void => {
      run.events.push({ ts: Date.now(), type: 'den', event })
    }

    const cwd = spec.workingDir ?? this.cfg.cwd ?? process.cwd()
    const home = this.cfg.opencodeHome ?? opencodeHome()

    let spawned: SpawnedTurn
    try {
      spawned = spawnOpencodeTurn(
        {
          binary: this.cfg.binary,
          modelId: spec.model ?? this.cfg.modelId,
          resumeSessionId: turn.resumeSessionId,
          effort: spec.effort ?? this.cfg.effort,
          cwd,
        },
        turn.prompt,
        {
          killGraceMs: this.cfg.killGraceMs,
          env: {
            // Task association for capture (#467).
            RIVETOS_TASK_ID: spec.taskId,
            // Explicitly cleared, not merely unset: an executor running inside
            // a den terminal inherits that terminal's key, and capture would
            // file the task's turns into the den chat's conversation.
            RIVETOS_SESSION_KEY: undefined,
            // This executor owns den emission — the den hook must stay quiet.
            RIVETOS_DEN_HOOK_DISABLED: '1',
            ...(this.cfg.opencodeHome
              ? { XDG_DATA_HOME: xdgDataHomeFor(this.cfg.opencodeHome) }
              : {}),
          },
        },
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        text: '',
        error: `Failed to spawn ${this.cfg.binary}: ${msg}`,
        resumeRejected: false,
      }
    }

    run.setActiveSpawn(spawned)
    this.log.info('task.spawn', {
      taskId: spec.taskId,
      pid: spawned.proc.pid,
      resume: turn.resumeSessionId ?? null,
    })

    let spawnFailure: string | undefined
    spawned.proc.once('error', (err) => {
      spawnFailure ??= `Failed to spawn ${this.cfg.binary}: ${err.message}`
    })
    spawned.proc.stdin.on('error', () => {
      /* EPIPE on a dead child — the proc 'error'/exit path reports it */
    })

    let text = ''
    let sessionId: string | undefined
    let error: string | undefined
    const toolNamesById = new Map<string, string>()
    const streamUsage = { input: 0, output: 0, records: 0 }

    try {
      for await (const line of spawned.events()) {
        const ev = parseOpencodeEvent(line)
        if (ev === undefined) continue
        if (ev.sessionId) {
          sessionId = ev.sessionId
        }

        if (ev.kind === 'text' && ev.text) {
          text += text === '' ? ev.text : `\n${ev.text}`
          den({ type: 'message.agent', text: ev.text })
          continue
        }

        if (ev.kind === 'tool-start' && ev.tool) {
          if (ev.toolCallId) toolNamesById.set(ev.toolCallId, ev.tool)
          den({ type: 'tool.start', tool: ev.tool })
          continue
        }

        if (ev.kind === 'tool-end') {
          const name = ev.toolCallId ? (toolNamesById.get(ev.toolCallId) ?? ev.tool) : ev.tool
          if (ev.toolCallId && ev.tool && !toolNamesById.has(ev.toolCallId)) {
            toolNamesById.set(ev.toolCallId, ev.tool)
            den({ type: 'tool.start', tool: ev.tool })
          }
          den({ type: 'tool.end', tool: name })
          continue
        }

        if (ev.kind === 'usage' && ev.usage) {
          streamUsage.input += ev.usage.inputTokens
          streamUsage.output += ev.usage.outputTokens
          streamUsage.records += 1
          continue
        }

        if (ev.kind === 'error' && ev.error) {
          run.events.push({
            ts: Date.now(),
            type: 'log',
            level: 'warn',
            message: `opencode: ${ev.error}`,
          })
        }
      }

      const exitCode = await spawned.waitExit()
      error ??= spawnFailure
      const stderrTail = spawned.stderrText().slice(0, 500)
      if (exitCode !== 0 && error === undefined && !run.isKilled()) {
        error = `opencode CLI exited ${String(exitCode)}: ${stderrTail}`
      }
      // A missing `-s` id (or any failure while resuming) is session_not_found.
      if (exitCode !== 0 && turn.resumeSessionId !== undefined) {
        return { text, error, resumeRejected: true }
      }
    } catch (err: unknown) {
      error ??= err instanceof Error ? err.message : String(err)
    } finally {
      run.setActiveSpawn(undefined)
      spawned.kill() // no-op when already exited — reaps every path
    }

    const fromStore =
      turn.resumeSessionId === undefined
        ? newestSessionAfter(home, cwd, spawned.startedAtMs)
        : undefined
    sessionId = fromStore ?? sessionId ?? turn.resumeSessionId
    if (!sessionId && error === undefined && !run.isKilled()) {
      error = 'opencode CLI stream ended without a session id'
    }
    const facts = this.reconcile({ home, sessionId, sinceMs: spawned.startedAtMs })
    if (facts.usageRecords > 0) {
      usage.inputTokens += facts.usage.inputTokens
      usage.outputTokens += facts.usage.outputTokens
    } else if (streamUsage.records > 0) {
      usage.inputTokens += streamUsage.input
      usage.outputTokens += streamUsage.output
    } else {
      this.log.warn('task.usage.unreconciled', {
        taskId: spec.taskId,
        sessionId: sessionId ?? null,
        files: facts.files,
      })
    }
    usage.totalTokens = usage.inputTokens + usage.outputTokens
    if (facts.turnEnded && facts.turnEnded.reason !== 'completed') {
      this.log.info('task.turn.ended', {
        taskId: spec.taskId,
        reason: facts.turnEnded.reason,
        durationMs: facts.turnEnded.durationMs ?? null,
      })
    }

    return { text, sessionId, error, resumeRejected: false }
  }

  /** Read the turn's usage off disk. Any failure degrades to zero, never throws. */
  private reconcile(opts: {
    home: string
    sessionId: string | undefined
    sinceMs: number
  }): WireTurnFacts {
    if (opts.sessionId === undefined) return emptyWireTurnFacts()
    try {
      return reconcileTurn({ home: opts.home, sessionId: opts.sessionId, sinceMs: opts.sinceMs })
    } catch (err: unknown) {
      this.log.warn('task.usage.reconcile.failed', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return emptyWireTurnFacts()
    }
  }
}
