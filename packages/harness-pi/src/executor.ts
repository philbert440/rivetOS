/**
 * PiExecutor — HarnessExecutor over headless `pi --print --mode json` spawns.
 *
 * Shape per start():
 *   - Turn 1 runs `spec.resumeMessage ?? spec.goal` in a FRESH pi session.
 *     `steer()` queues follow-up turns; turn N spawns
 *     `pi --print --mode json --session <native-id>`, so every turn of a task
 *     shares ONE native session and its context.
 *   - There is no `--append-system` on the confirmed flag set, so the task
 *     scaffold (context + acceptance criteria + the TASK_RESULT fence
 *     contract) is PREPENDED to the prompt text of every turn.
 *   - print/JSON is the session JSONL on stdout. `type:session` (first line)
 *     carries the native UUID; `type:message` assistant content maps to den
 *     `message.agent` / `tool.start` / `tool.end`. Canonical id is `pi:<uuid>`.
 *   - Usage arrives from assistant `message.usage` on stdout when present,
 *     else POST-HOC from the session jsonl after the child exits. A reconcile
 *     that finds nothing degrades to zero usage and a warning; it can never
 *     fail a turn. No `cost` events: tokens, not money.
 *   - Structured result: `parseTaskResultBlock` over the turn's text, falling
 *     back to {verdict:'completed', summary:<last text>}. `result` NEVER rejects.
 *   - kill(): SIGTERM then SIGKILL after the grace period → verdict 'killed'.
 *
 * Task association (#467) is the claude contract verbatim: `RIVETOS_TASK_ID`
 * on the child env, the inherited `RIVETOS_SESSION_KEY` explicitly DELETED,
 * `RIVETOS_DEN_HOOK_DISABLED=1` because this executor owns den emission.
 *
 * Locked constraint: NO RivetOS-side per-turn timeout. The runner enforces
 * budget between turns via the abort signal.
 */

import path from 'node:path'
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
import { RESUME_REJECTED_RE, spawnPiTurn, type SpawnedTurn } from './spawn-turn.js'
import {
  emptyPiTurnFacts,
  findSessionFile,
  listSessionIds,
  piHome,
  reconcileTurn,
  SESSION_TYPE,
  sessionIdFromEvent,
  usageFromEvent,
  type PiJsonEvent,
  type PiMessageEvent,
  type PiTurnFacts,
} from './wire.js'

/** Harness id this executor registers under (`HARNESS_IDS`). */
export const PI_HARNESS_ID: HarnessId = 'pi'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PiExecutorConfig {
  /** Path to the `pi` binary. */
  binary: string
  /** Default model id (spec.model overrides). Empty = the CLI's default. */
  modelId?: string
  /**
   * Default reasoning effort (spec.effort overrides). Passed as `--thinking`.
   * Unset by default; nothing is passed when neither side sets it.
   */
  effort?: 'low' | 'medium' | 'high'
  /**
   * Default working directory (spec.workingDir overrides). Pins resume —
   * every turn of a task uses the same one (sessions are cwd-bucketed).
   */
  cwd?: string
  /**
   * Data dir used to find session jsonl for post-hoc usage (`~/.pi/agent`
   * layout). When set, also passed as `--session-dir <home>/sessions` so the
   * child writes where we will read. pi does not honour `$PI_HOME`.
   */
  piHome?: string
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
 * this package does not assume `--append-system`).
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
 * The scaffold going first is load-bearing beyond readability: a prompt that
 * STARTS with a slash command must not be able to hijack print mode.
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
 * Canonicalize pi's native session id onto the control plane's one id
 * format, `pi:<native>`. The native half is a UUID (any version).
 *
 * Headless turns adopt the id from the first stdout `session` line (print
 * mode always emits it). The den PTY driver pins a new id with `--session-id`
 * instead. An id already carrying a prefix, or one the codec rejects, passes
 * through verbatim — a non-canonical breadcrumb beats none.
 */
export function canonicalPiSessionId(nativeId: string | undefined): string | undefined {
  if (nativeId === undefined || nativeId === '') return undefined
  if (isSessionId(nativeId)) return nativeId
  try {
    return formatSessionId(PI_HARNESS_ID, nativeId)
  } catch {
    if (nativeId !== nativeId.trim()) return nativeId
    return `${PI_HARNESS_ID}:${nativeId}`
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
  /** pi refused the `--session` — the caller may retry on a fresh one. */
  resumeRejected: boolean
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class PiExecutor implements HarnessExecutor {
  readonly name = PI_HARNESS_ID
  private readonly cfg: PiExecutorConfig
  private readonly log: HarnessLogger

  constructor(cfg: PiExecutorConfig) {
    this.cfg = cfg
    this.log = createLogger('pi-executor')
  }

  capabilities(): HarnessExecutorCapabilities {
    return {
      steerable: true, // between turns — no mid-spawn steering
      multiTurn: true, // native `--session` resume, one session across the task
      structuredStream: true, // print/JSON session + message lines
      usageInResult: true, // assistant message.usage or session jsonl
      sessionIdCapture: true, // session.id on the first stdout line, plus a disk fallback
      slashCommands: false,
      effortSelection: true, // `--thinking`
      // Confirmed flag set has no --mcp-config; servers come from pi's own
      // persistent config, shared with the interactive harness.
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

    // Resume from awaiting-input in a fresh process: there is no native pi
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

      // A `--session` pi refuses (session pruned, or the task moved directory)
      // is not a failed turn: fall back to a fresh session seeded with the
      // task's rendered history, exactly like a cross-process resume, and
      // adopt the new native id from there on.
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
          message: `pi refused to resume ${String(nativeSessionId)} — starting a fresh session`,
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
        harnessSessionId: canonicalPiSessionId(nativeSessionId),
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
   * One `pi --print` spawn: translate print/JSON into den TaskEvents, then
   * fill usage from stdout or the session transcript. Failures come back as
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
    const home = this.cfg.piHome ?? piHome()
    const effort = spec.effort ?? this.cfg.effort

    const idsBefore = turn.resumeSessionId === undefined ? listSessionIds(home, cwd) : undefined

    let spawned: SpawnedTurn
    try {
      spawned = spawnPiTurn(
        {
          binary: this.cfg.binary,
          modelId: spec.model ?? this.cfg.modelId,
          resumeSessionId: turn.resumeSessionId,
          sessionDir: this.cfg.piHome ? path.join(this.cfg.piHome, 'sessions') : undefined,
          thinking: effort,
          cwd,
        },
        turn.prompt,
        {
          killGraceMs: this.cfg.killGraceMs,
          env: {
            RIVETOS_TASK_ID: spec.taskId,
            RIVETOS_SESSION_KEY: undefined,
            RIVETOS_DEN_HOOK_DISABLED: '1',
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
    let sawTerminal = false
    let error: string | undefined
    const toolNamesById = new Map<string, string>()
    let stdoutInput = 0
    let stdoutOutput = 0
    let stdoutUsageRecords = 0

    try {
      for await (const line of spawned.events()) {
        this.consumeLine(line, {
          den,
          onText: (chunk) => {
            text += text === '' ? chunk : `\n${chunk}`
          },
          onSessionId: (id) => {
            sessionId = id
          },
          onTerminal: () => {
            sawTerminal = true
          },
          onUsage: (tokens) => {
            stdoutInput += tokens.inputTokens
            stdoutOutput += tokens.outputTokens
            stdoutUsageRecords += 1
          },
          onErrorMessage: (msg) => {
            run.events.push({
              ts: Date.now(),
              type: 'log',
              level: 'warn',
              message: `pi error event: ${msg}`,
            })
          },
          toolNamesById,
        })
      }

      const exitCode = await spawned.waitExit()
      error ??= spawnFailure
      const stderrTail = spawned.stderrText().slice(0, 500)
      if (exitCode !== 0 && error === undefined && !run.isKilled()) {
        error = `pi CLI exited ${String(exitCode)}: ${stderrTail}`
      }
      if (!sawTerminal && error === undefined && !run.isKilled()) {
        error = 'pi CLI stream ended without a session event'
      }
      if (error !== undefined && RESUME_REJECTED_RE.test(spawned.stderrText())) {
        return { text, error, resumeRejected: turn.resumeSessionId !== undefined }
      }
    } catch (err: unknown) {
      error ??= err instanceof Error ? err.message : String(err)
    } finally {
      run.setActiveSpawn(undefined)
      spawned.kill() // no-op when already exited — reaps every path
    }

    sessionId ??= turn.resumeSessionId ?? this.recoverSessionId(home, cwd, idsBefore)

    if (stdoutUsageRecords > 0) {
      usage.inputTokens += stdoutInput
      usage.outputTokens += stdoutOutput
      usage.totalTokens = usage.inputTokens + usage.outputTokens
    } else {
      const facts = this.reconcile({ home, cwd, sessionId, sinceMs: spawned.startedAtMs })
      usage.inputTokens += facts.usage.inputTokens
      usage.outputTokens += facts.usage.outputTokens
      usage.totalTokens = usage.inputTokens + usage.outputTokens
      if (facts.usageRecords === 0) {
        this.log.warn('task.usage.unreconciled', {
          taskId: spec.taskId,
          sessionId: sessionId ?? null,
          files: facts.files,
        })
      }
      if (facts.turnEnded && facts.turnEnded.reason !== 'completed') {
        this.log.info('task.turn.ended', {
          taskId: spec.taskId,
          reason: facts.turnEnded.reason,
          durationMs: facts.turnEnded.durationMs ?? null,
        })
      }
    }

    return { text, sessionId, error, resumeRejected: false }
  }

  private consumeLine(
    line: PiJsonEvent,
    into: {
      den: (event: AgentEventBody) => void
      onText: (chunk: string) => void
      onSessionId: (id: string) => void
      onTerminal: () => void
      onUsage: (tokens: { inputTokens: number; outputTokens: number }) => void
      onErrorMessage: (msg: string) => void
      toolNamesById: Map<string, string>
    },
  ): void {
    const tokens = usageFromEvent(line)
    if (tokens) into.onUsage(tokens)

    switch (line.type) {
      case 'message': {
        const msg = (line as PiMessageEvent).message
        if (!msg || typeof msg !== 'object') return
        const content = Array.isArray(msg.content)
          ? msg.content
          : typeof msg.content === 'string'
            ? [{ type: 'text', text: msg.content }]
            : []
        if (msg.role !== 'assistant') return
        for (const raw of content) {
          if (!raw || typeof raw !== 'object') continue
          const item = raw as Record<string, unknown>
          const t = item.type
          if (t === 'text' && typeof item.text === 'string' && item.text !== '') {
            into.onText(item.text)
            into.den({ type: 'message.agent', text: item.text })
          } else if (t === 'toolCall' || t === 'tool_call' || t === 'toolUse' || t === 'tool_use') {
            const name =
              (typeof item.name === 'string' && item.name) ||
              (typeof item.toolName === 'string' && item.toolName) ||
              ''
            if (!name) continue
            const id =
              (typeof item.id === 'string' && item.id) ||
              (typeof item.toolCallId === 'string' && item.toolCallId) ||
              undefined
            if (id) into.toolNamesById.set(id, name)
            into.den({ type: 'tool.start', tool: name })
          } else if (t === 'toolResult' || t === 'tool_result') {
            const id =
              (typeof item.id === 'string' && item.id) ||
              (typeof item.toolCallId === 'string' && item.toolCallId) ||
              undefined
            into.den({
              type: 'tool.end',
              tool: typeof id === 'string' ? into.toolNamesById.get(id) : undefined,
            })
          }
        }
        return
      }
      case SESSION_TYPE: {
        const id = sessionIdFromEvent(line)
        if (id) into.onSessionId(id)
        into.onTerminal()
        return
      }
      case 'error': {
        const msg = (line as { message?: unknown }).message
        if (typeof msg === 'string' && msg !== '') into.onErrorMessage(msg)
        return
      }
      default:
        return
    }
  }

  /**
   * The session a failed turn created, when exactly one appeared. Concurrent
   * spawns make this ambiguous, and an ambiguous id is worse than none — it
   * would attribute another task's tokens to this one.
   */
  private recoverSessionId(
    home: string,
    cwd: string,
    idsBefore: Set<string> | undefined,
  ): string | undefined {
    if (idsBefore === undefined) return undefined
    const fresh = [...listSessionIds(home, cwd)].filter((id) => !idsBefore.has(id))
    return fresh.length === 1 ? fresh[0] : undefined
  }

  /** Read the turn's usage off disk. Any failure degrades to zero, never throws. */
  private reconcile(opts: {
    home: string
    cwd: string
    sessionId: string | undefined
    sinceMs: number
  }): PiTurnFacts {
    if (opts.sessionId === undefined) return emptyPiTurnFacts()
    try {
      const sessionFile = findSessionFile({
        home: opts.home,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      })
      if (sessionFile === undefined) return emptyPiTurnFacts()
      return reconcileTurn({ sessionDir: sessionFile, sinceMs: opts.sinceMs })
    } catch (err: unknown) {
      this.log.warn('task.usage.reconcile.failed', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return emptyPiTurnFacts()
    }
  }
}
