/**
 * KimiCodeExecutor — HarnessExecutor over headless `kimi -p` spawns.
 *
 * Closes the `kimi-code` gap #476 recorded honestly ("hooks + capture only —
 * nothing in this repo spawns the kimi binary"). That was true of the
 * integration, not of the CLI: kimi 0.34.0 ships `--output-format stream-json`,
 * and its own transcript carries the usage the stream does not.
 *
 * Shape per start():
 *   - Turn 1 runs `spec.resumeMessage ?? spec.goal` in a FRESH kimi session.
 *     `steer()` queues follow-up turns; turn N spawns `kimi -S <native-id> -p`,
 *     so every turn of a task shares ONE native session and its context —
 *     the claude-cli executor still stitches independent one-shots.
 *   - There is no `--append-system-prompt` on kimi, so the task scaffold
 *     (context + acceptance criteria + the TASK_RESULT fence contract) is
 *     PREPENDED to the prompt text of every turn. Same contract text the
 *     claude executor puts in the system append. `--agent-file` was rejected
 *     as the alternative: it replaces the agent definition wholesale, tool
 *     instructions included, which is a clobber rather than an append.
 *   - stream-json → TaskEvent: assistant text → den message.agent,
 *     `tool_calls[]` → den tool.start, `role:"tool"` → den tool.end.
 *     `session.resume_hint` (the last line of a successful turn) carries the
 *     native session id, canonicalized onto `kimi-code:session_<uuid>`.
 *   - Usage arrives POST-HOC from the session's `wire.jsonl` after the child
 *     exits — see wire.ts for why that beats tailing. A reconcile that finds
 *     nothing degrades to zero usage and a warning; it can never fail a turn.
 *     No `cost` events: kimi records tokens, not money.
 *   - Structured result: `parseTaskResultBlock` over the turn's text, falling
 *     back to {verdict:'completed', summary:<last text>}. There is no
 *     `--json-schema` on this CLI. `result` NEVER rejects.
 *   - kill(): SIGTERM then SIGKILL after the grace period → verdict 'killed'.
 *     A killed turn's usage may be partial — kimi's cleanup has 8s to flush
 *     the last wire batch and a SIGKILL gives it none. Tolerated by design.
 *
 * Task association (#467) is the claude contract verbatim: `RIVETOS_TASK_ID`
 * on the child env, the inherited `RIVETOS_SESSION_KEY` explicitly DELETED,
 * `RIVETOS_DEN_HOOK_DISABLED=1` because this executor owns den emission. kimi
 * itself reads none of them (zero `RIVETOS_` references in the bundle) — the
 * consumer is the hook launcher it spawns, which inherits this env, which is
 * how the deployed rivet-memory capture stamps the task onto the conversation.
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
import {
  RESUME_HINT_TYPE,
  RETRYING_TYPE,
  RESUME_REJECTED_RE,
  spawnKimiTurn,
  type SpawnedTurn,
} from './spawn-turn.js'
import {
  emptyWireTurnFacts,
  kimiHome,
  listSessionIds,
  reconcileTurn,
  resolveSessionDir,
  type WireTurnFacts,
} from './wire.js'

/** Harness id this executor registers under (`HARNESS_IDS`). */
export const KIMI_HARNESS_ID: HarnessId = 'kimi-code'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface KimiCodeExecutorConfig {
  /** Path to the `kimi` binary. */
  binary: string
  /** Default model alias (spec.model overrides). Empty = the CLI's default. */
  modelId?: string
  /**
   * Default reasoning effort (spec.effort overrides). Passed as
   * `KIMI_MODEL_THINKING_EFFORT` — kimi has no effort FLAG, and that env
   * override deliberately bypasses the model's `support_efforts` list, so an
   * effort the provider rejects surfaces as a failed turn rather than a
   * clamped one. Unset by default; nothing is passed when neither side sets it.
   */
  effort?: 'low' | 'medium' | 'high'
  /**
   * Default working directory (spec.workingDir overrides). Pins the wire
   * bucket and scopes `-S` resume — every turn of a task uses the same one.
   */
  cwd?: string
  /**
   * KIMI_CODE_HOME for the child. Also where the reconcile reads transcripts,
   * so the two can never drift. Default: the ambient home (`~/.kimi-code`),
   * which is what keeps the deployed rivet-memory hooks and `mcp.json` in play.
   */
  kimiHome?: string
  /** Override the SIGTERM→SIGKILL grace (tests use a short one). */
  killGraceMs?: number
  /**
   * Task-conversation source for resume rehydration. Used when a task resumes
   * from awaiting-input in a NEW process (no native session in hand) and when
   * a `-S` resume is rejected — see `renderResumeTranscript`.
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
 * kimi has no append-system-prompt).
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
 * The scaffold going first is load-bearing beyond readability: `kimi -p`
 * intercepts a prompt that STARTS with `/goal` and runs goal mode instead of a
 * normal turn (different lifecycle, different exit codes). A task whose goal
 * text happens to begin with a slash command can therefore never hijack the
 * spawn, because the scaffold always precedes it.
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
 * Canonicalize kimi's native `session_<uuid>` onto the control plane's one id
 * format, `kimi-code:session_<uuid>` — the same key the den hooks and the
 * memory capture already write, so a task row's `harness_session_ids` join
 * with the conversation.
 *
 * Adoption, not pinning: kimi has no `--session-id`, so the id is whatever the
 * CLI minted. An id already carrying a prefix, or one the codec rejects,
 * passes through verbatim — a non-canonical breadcrumb beats none.
 */
export function canonicalKimiSessionId(nativeId: string | undefined): string | undefined {
  if (nativeId === undefined || nativeId === '') return undefined
  if (isSessionId(nativeId)) return nativeId
  try {
    return formatSessionId(KIMI_HARNESS_ID, nativeId)
  } catch {
    return nativeId
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
  /** kimi refused the `-S` session — the caller may retry on a fresh one. */
  resumeRejected: boolean
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class KimiCodeExecutor implements HarnessExecutor {
  readonly name = KIMI_HARNESS_ID
  private readonly cfg: KimiCodeExecutorConfig
  private readonly log: HarnessLogger

  constructor(cfg: KimiCodeExecutorConfig) {
    this.cfg = cfg
    this.log = createLogger('kimi-code-executor')
  }

  capabilities(): HarnessExecutorCapabilities {
    return {
      steerable: true, // between turns — no mid-spawn steering
      multiTurn: true, // native `-S` resume, one session across the task
      structuredStream: true, // stream-json assistant/tool_calls/tool lines
      usageInResult: true, // reconciled from wire.jsonl, not from stdout
      sessionIdCapture: true, // session.resume_hint, plus a disk fallback
      // Only `/goal` is parsed in headless prompt mode, and this executor
      // deliberately keeps out of goal mode (its own lifecycle and exit codes).
      slashCommands: false,
      effortSelection: true, // KIMI_MODEL_THINKING_EFFORT override
      // No `--mcp-config` on this CLI: servers come from mcp.json in
      // KIMI_CODE_HOME, shared with the interactive harness.
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

    // Resume from awaiting-input in a fresh process: there is no native kimi
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

      // A `-S` kimi refuses (session pruned, or the task moved directory) is
      // not a failed turn: fall back to a fresh session seeded with the task's
      // rendered history, exactly like a cross-process resume, and adopt the
      // new native id from there on.
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
          message: `kimi refused to resume ${String(nativeSessionId)} — starting a fresh session`,
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
        harnessSessionId: canonicalKimiSessionId(nativeSessionId),
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
   * One `kimi -p` spawn: translate stream-json into den TaskEvents, then read
   * the session's transcript for the usage the stream never carried. Failures
   * come back as `error` (never thrown) so the caller's result contract holds.
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
    const home = this.cfg.kimiHome ?? kimiHome()
    const effort = spec.effort ?? this.cfg.effort

    // Ids that exist BEFORE the spawn. A turn that throws never reaches
    // kimi's resume-hint line, so this snapshot is the only way back to the
    // session it did create.
    const idsBefore = turn.resumeSessionId === undefined ? listSessionIds(home, cwd) : undefined

    let spawned: SpawnedTurn
    try {
      spawned = spawnKimiTurn(
        {
          binary: this.cfg.binary,
          modelId: spec.model ?? this.cfg.modelId,
          resumeSessionId: turn.resumeSessionId,
          cwd,
        },
        turn.prompt,
        {
          killGraceMs: this.cfg.killGraceMs,
          env: {
            // Task association for capture (#467). kimi ignores it; the hook
            // launcher it spawns inherits it, and that is what stamps the task
            // onto the captured conversation.
            RIVETOS_TASK_ID: spec.taskId,
            // Explicitly cleared, not merely unset: an executor running inside
            // a den terminal inherits that terminal's key, and capture would
            // file the task's turns into the den chat's conversation.
            RIVETOS_SESSION_KEY: undefined,
            // This executor owns den emission — the den hook must stay quiet.
            RIVETOS_DEN_HOOK_DISABLED: '1',
            ...(this.cfg.kimiHome ? { KIMI_CODE_HOME: this.cfg.kimiHome } : {}),
            ...(effort ? { KIMI_MODEL_THINKING_EFFORT: effort } : {}),
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
    let sawResumeHint = false
    let error: string | undefined
    const toolNamesById = new Map<string, string>()

    try {
      for await (const line of spawned.events()) {
        const role = typeof line.role === 'string' ? line.role : undefined

        if (role === 'assistant') {
          const content = (line as { content?: unknown }).content
          if (typeof content === 'string' && content !== '') {
            text += text === '' ? content : `\n${content}`
            den({ type: 'message.agent', text: content })
          }
          const calls = (line as { tool_calls?: unknown }).tool_calls
          if (Array.isArray(calls)) {
            for (const call of calls) {
              if (typeof call !== 'object' || call === null) continue
              const fn = (call as { function?: { name?: unknown } }).function
              const name = typeof fn?.name === 'string' ? fn.name : undefined
              if (name === undefined) continue
              const id = (call as { id?: unknown }).id
              if (typeof id === 'string') toolNamesById.set(id, name)
              den({ type: 'tool.start', tool: name })
            }
          }
          continue
        }

        if (role === 'tool') {
          const id = (line as { tool_call_id?: unknown }).tool_call_id
          den({
            type: 'tool.end',
            tool: typeof id === 'string' ? toolNamesById.get(id) : undefined,
          })
          continue
        }

        if (role === 'meta') {
          const rawType = (line as { type?: unknown }).type
          const type = typeof rawType === 'string' ? rawType : ''
          if (type === RESUME_HINT_TYPE) {
            const id = (line as { session_id?: unknown }).session_id
            if (typeof id === 'string' && id !== '') sessionId = id
            sawResumeHint = true
          } else if (type === RETRYING_TYPE) {
            const detail = (line as { error_message?: unknown }).error_message
            run.events.push({
              ts: Date.now(),
              type: 'log',
              level: 'warn',
              message: `kimi retrying a step: ${
                typeof detail === 'string' ? detail : 'provider error'
              }`,
            })
          }
          continue
        }
      }

      const exitCode = await spawned.waitExit()
      error ??= spawnFailure
      const stderrTail = spawned.stderrText().slice(0, 500)
      if (exitCode !== 0 && error === undefined && !run.isKilled()) {
        error = `kimi CLI exited ${String(exitCode)}: ${stderrTail}`
      }
      if (!sawResumeHint && error === undefined && !run.isKilled()) {
        // Clean exit with no resume hint means the stream ended somewhere it
        // should not have — the hint is written unconditionally after a turn.
        error = 'kimi CLI stream ended without a session resume_hint'
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

    // Usage: the process has exited, so its transcript is complete and there
    // is nothing to race. Session id first — from the hint, else recovered
    // from disk for the failure path that never printed one.
    sessionId ??= turn.resumeSessionId ?? this.recoverSessionId(home, cwd, idsBefore)
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

    return { text, sessionId, error, resumeRejected: false }
  }

  /**
   * The session a failed turn created, when exactly one appeared. Concurrent
   * same-cwd spawns make this ambiguous, and an ambiguous id is worse than
   * none — it would attribute another task's tokens to this one.
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
  }): WireTurnFacts {
    if (opts.sessionId === undefined) return emptyWireTurnFacts()
    try {
      const sessionDir = resolveSessionDir({
        home: opts.home,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      })
      if (sessionDir === undefined) return emptyWireTurnFacts()
      return reconcileTurn({ sessionDir, sinceMs: opts.sinceMs })
    } catch (err: unknown) {
      this.log.warn('task.usage.reconcile.failed', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return emptyWireTurnFacts()
    }
  }
}
