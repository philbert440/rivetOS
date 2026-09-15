/**
 * QwenCodeExecutor — HarnessExecutor over headless
 * `qwen -p --output-format stream-json` spawns.
 *
 * Shape per start():
 *   - Turn 1 pins `--session-id <uuid>` in a FRESH qwen session.
 *     `steer()` queues follow-up turns; turn N spawns
 *     `qwen -p … --resume <native-id>` in the SAME cwd, so every turn of a
 *     task shares ONE native session and its context.
 *   - The task scaffold (context + acceptance criteria + the TASK_RESULT
 *     fence contract + the pinned cwd) is passed as `--append-system-prompt`.
 *     The turn message is the `-p` argv value.
 *   - stream-json stdout is a Claude-shaped runtime event stream (not the
 *     on-disk gemini-style jsonl). `system/init` carries the native UUID;
 *     `stream_event` thinking/text deltas map to den `thinking.delta` /
 *     `message.agent`; `assistant` `tool_use` → `tool.start`; `user`
 *     `tool_result` → `tool.end`. Canonical id is `qwen-code:<uuid>`.
 *   - Per-turn usage is the LAST `assistant` line with non-zero usage.
 *     `result.usage` is the whole-run total and is only the fallback.
 *     `result.is_error` / `subtype !== 'success'` fails the turn. If stdout
 *     carried no usage, reconcile POST-HOC from the session jsonl. A
 *     reconcile that finds nothing degrades to zero usage and a warning; it
 *     can never fail a turn. No `cost` events: tokens, not money.
 *   - Structured result: `parseTaskResultBlock` over the turn's text, falling
 *     back to {verdict:'completed', summary:<last text>}. `result` NEVER rejects.
 *   - kill(): SIGTERM then SIGKILL after the grace period → verdict 'killed'.
 *
 * Task association (#467): `RIVETOS_TASK_ID` on the child env, the inherited
 * `RIVETOS_SESSION_KEY` explicitly DELETED. No `RIVETOS_DEN_HOOK_DISABLED` —
 * this integration ships no qwen den hook (unlike claude/kimi).
 * `QWEN_CODE_SUPPRESS_YOLO_WARNING=1` is set by spawn-turn.
 *
 * Locked constraint: NO RivetOS-side per-turn timeout. The runner enforces
 * budget between turns via the abort signal.
 */

import { randomUUID } from 'node:crypto'
import os from 'node:os'
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
import { RESUME_REJECTED_RE, spawnQwenTurn, type SpawnedTurn } from './spawn-turn.js'
import {
  assistantMessage,
  emptyQwenTurnFacts,
  findSessionFile,
  isFatalQwenResult,
  listSessionIds,
  qwenHome,
  reconcileTurn,
  RUNTIME_TERMINAL_TYPES,
  SESSION_TYPE,
  sessionIdFromEvent,
  streamEventInner,
  usageFromEvent,
  type QwenJsonEvent,
  type QwenTurnFacts,
} from './wire.js'

/** Harness id this executor registers under (`HARNESS_IDS`). */
export const QWEN_CODE_HARNESS_ID: HarnessId = 'qwen-code'

/** Default cwd when neither the spec nor config sets one. Sessions are cwd-scoped. */
export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), '.rivetos', 'workspace')
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface QwenCodeExecutorConfig {
  /** Path to the `qwen` binary. */
  binary: string
  /** Default model id (spec.model overrides). Empty = the CLI's default. */
  modelId?: string
  /**
   * Default working directory (spec.workingDir overrides). Pins resume —
   * every turn of a task uses the same one (sessions are cwd-scoped).
   * Unset → `~/.rivetos/workspace`.
   */
  cwd?: string
  /**
   * Data dir used to find session jsonl for post-hoc usage (`~/.qwen`
   * layout). Tests redirect this; qwen itself always writes `~/.qwen`
   * unless HOME is changed.
   */
  qwenHome?: string
  /** Override the SIGTERM→SIGKILL grace (tests use a short one). */
  killGraceMs?: number
  /** Optional `--max-session-turns N` on every spawn. */
  maxSessionTurns?: number
  /**
   * Task-conversation source for resume rehydration. Used when a task resumes
   * from awaiting-input in a NEW process (no native session in hand) and when
   * a `--resume` is rejected — see `renderResumeTranscript`.
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
 * The task scaffold. Delivered via `--append-system-prompt` (same contract
 * as the claude executor's system append). Includes the pinned cwd because
 * qwen sessions are project-scoped — every turn MUST stay in it.
 */
export function buildTaskScaffold(spec: TaskSpec, cwd: string): string {
  const parts = [
    '## Task Context',
    'You are executing a delegated RivetOS task. Complete it thoroughly.',
    spec.resolvedContext ? `### Context\n${spec.resolvedContext}` : '',
    spec.acceptanceCriteria.length > 0
      ? `### Acceptance criteria\n${spec.acceptanceCriteria
          .map((c) => `- [${c.id}] ${c.description}`)
          .join('\n')}`
      : '',
    `Working directory: ${cwd}`,
    spec.systemPromptAppend ?? '',
    taskResultFenceInstructions(),
  ]
  return parts.filter(Boolean).join('\n\n')
}

/**
 * One turn's prompt: optional rehydrated transcript, then the turn's message
 * under a heading. The task scaffold is NOT inlined — it goes out as
 * `--append-system-prompt`.
 */
export function buildTurnPrompt(parts: {
  scaffold?: string
  transcript?: string
  message: string
}): string {
  return [parts.scaffold ?? '', parts.transcript ?? '', `## This turn\n${parts.message}`]
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
 * Canonicalize qwen's native session id onto the control plane's one id
 * format, `qwen-code:<native>`. The native half is a UUID (any version).
 *
 * Headless turns pin `--session-id` on turn 1 and adopt the id from the
 * first stdout `system/init` line. An id already carrying a prefix, or one
 * the codec rejects, passes through verbatim — a non-canonical breadcrumb
 * beats none.
 */
export function canonicalQwenCodeSessionId(nativeId: string | undefined): string | undefined {
  if (nativeId === undefined || nativeId === '') return undefined
  if (isSessionId(nativeId)) return nativeId
  try {
    return formatSessionId(QWEN_CODE_HARNESS_ID, nativeId)
  } catch {
    if (nativeId !== nativeId.trim()) return nativeId
    return `${QWEN_CODE_HARNESS_ID}:${nativeId}`
  }
}

function resolveCwd(spec: TaskSpec, cfg: QwenCodeExecutorConfig): string {
  return spec.workingDir ?? cfg.cwd ?? defaultWorkspaceDir()
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
  /** qwen refused the `--resume` — the caller may retry on a fresh pin. */
  resumeRejected: boolean
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class QwenCodeExecutor implements HarnessExecutor {
  readonly name = QWEN_CODE_HARNESS_ID
  private readonly cfg: QwenCodeExecutorConfig
  private readonly log: HarnessLogger

  constructor(cfg: QwenCodeExecutorConfig) {
    this.cfg = cfg
    this.log = createLogger('qwen-code-executor')
  }

  capabilities(): HarnessExecutorCapabilities {
    return {
      steerable: true, // between turns — no mid-spawn steering
      multiTurn: true, // native `--resume`, one session across the task
      structuredStream: true, // stream-json runtime event stream
      usageInResult: true, // last non-zero assistant.usage or session jsonl
      sessionIdCapture: true, // system/init session_id, plus a disk fallback
      slashCommands: false,
      effortSelection: false, // no --effort / --thinking CLI flag
      // Servers come from qwen's own persistent settings.json.
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
    const cwd = resolveCwd(spec, this.cfg)
    const scaffold = buildTaskScaffold(spec, cwd)

    let transcript = spec.resumeMessage !== undefined ? await this.renderTaskTranscript(spec) : ''

    let lastText = ''
    let lastError: string | undefined
    let nativeSessionId: string | undefined
    let message: string | undefined = spec.resumeMessage ?? spec.goal

    while (message !== undefined && !run.isKilled()) {
      usage.turns += 1
      run.events.push({ ts: Date.now(), type: 'turn.start', turn: usage.turns })

      let turn = await this.runOneSpawn(spec, run, usage, {
        prompt: buildTurnPrompt({ transcript, message }),
        systemText: scaffold,
        resumeSessionId: nativeSessionId,
        pinSessionId: nativeSessionId === undefined ? randomUUID() : undefined,
        cwd,
      })

      // A `--resume` qwen refuses (unknown id, or the task moved directory)
      // is not a failed turn: fall back to a fresh `--session-id` seeded with
      // the task's rendered history, exactly like a cross-process resume.
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
          message: `qwen refused to resume ${String(nativeSessionId)} — starting a fresh session`,
        })
        nativeSessionId = undefined
        transcript = await this.renderTaskTranscript(spec)
        turn = await this.runOneSpawn(spec, run, usage, {
          prompt: buildTurnPrompt({ transcript, message }),
          systemText: scaffold,
          pinSessionId: randomUUID(),
          cwd,
        })
      }

      if (turn.sessionId) nativeSessionId = turn.sessionId
      usage.wallClockMs = Date.now() - startedAt
      run.events.push({
        ts: Date.now(),
        type: 'turn.end',
        turn: usage.turns,
        usage: { ...usage },
        harnessSessionId: canonicalQwenCodeSessionId(nativeSessionId),
      })

      if (turn.text) lastText = turn.text
      if (turn.error) {
        lastError = turn.error
        break
      }
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
   * One `qwen -p` spawn: translate stream-json into den TaskEvents, then
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
    turn: {
      prompt: string
      resumeSessionId?: string
      pinSessionId?: string
      systemText?: string
      cwd: string
    },
  ): Promise<SpawnOutcome> {
    const den = (event: AgentEventBody): void => {
      run.events.push({ ts: Date.now(), type: 'den', event })
    }

    const cwd = turn.cwd
    const home = this.cfg.qwenHome ?? qwenHome()

    const idsBefore = turn.resumeSessionId === undefined ? listSessionIds(home, cwd) : undefined

    let spawned: SpawnedTurn
    try {
      spawned = spawnQwenTurn(
        {
          binary: this.cfg.binary,
          modelId: spec.model ?? this.cfg.modelId,
          resumeSessionId: turn.resumeSessionId,
          pinSessionId: turn.pinSessionId,
          appendSystemPrompt: turn.systemText,
          maxSessionTurns: this.cfg.maxSessionTurns,
          cwd,
        },
        turn.prompt,
        {
          killGraceMs: this.cfg.killGraceMs,
          env: {
            RIVETOS_TASK_ID: spec.taskId,
            RIVETOS_SESSION_KEY: undefined,
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
      cwd,
      resume: turn.resumeSessionId ?? null,
      pin: turn.pinSessionId ?? null,
    })

    let spawnFailure: string | undefined
    spawned.proc.once('error', (err) => {
      spawnFailure ??= `Failed to spawn ${this.cfg.binary}: ${err.message}`
    })

    let text = ''
    let sessionId: string | undefined
    let sawInit = false
    let sawTerminal = false
    let sawTextDelta = false
    let sawThinkingDelta = false
    let error: string | undefined
    const toolNamesById = new Map<string, string>()
    const startedTools = new Set<string>()
    let stdoutInput = 0
    let stdoutOutput = 0
    let stdoutUsageRecords = 0
    let resultUsage: { inputTokens: number; outputTokens: number; cacheRead: number } | undefined

    try {
      for await (const line of spawned.events()) {
        this.consumeLine(line, {
          den,
          onTextDelta: (chunk) => {
            sawTextDelta = true
            text += chunk
            den({ type: 'message.agent', text: chunk })
          },
          onTextSnapshot: (chunk) => {
            if (sawTextDelta || chunk === '') return
            text += text === '' ? chunk : `\n${chunk}`
            den({ type: 'message.agent', text: chunk })
          },
          onThinkingDelta: (chunk) => {
            sawThinkingDelta = true
            den({ type: 'thinking.delta', text: chunk })
          },
          onThinkingSnapshot: (chunk) => {
            if (sawThinkingDelta || chunk === '') return
            den({ type: 'thinking.delta', text: chunk })
          },
          onTextBlockStart: () => {
            if (text !== '') text += '\n'
          },
          onSessionId: (id) => {
            sessionId = id
          },
          onInit: () => {
            sawInit = true
          },
          onTerminal: () => {
            sawTerminal = true
          },
          onAssistantUsage: (tokens) => {
            // cacheRead is a subset of inputTokens, not extra.
            stdoutInput = tokens.inputTokens
            stdoutOutput = tokens.outputTokens
            stdoutUsageRecords += 1
          },
          onResultUsage: (tokens) => {
            resultUsage = tokens
          },
          onFatalResult: (subtype) => {
            error ??= `qwen result: ${subtype}`
          },
          onErrorMessage: (msg) => {
            run.events.push({
              ts: Date.now(),
              type: 'log',
              level: 'warn',
              message: `qwen error event: ${msg}`,
            })
          },
          toolNamesById,
          startedTools,
        })
      }

      const exitCode = await spawned.waitExit()
      error ??= spawnFailure
      const stderrTail = spawned.stderrText().slice(0, 500)
      const stdoutTail = spawned.stdoutText()
      // Measured contract: retry a fresh session only when stdout contained
      // `No saved session found with ID`. Empty exit-0 with no system/init is
      // a failed turn (stderr tail on the error), not a retry.
      const resumeRejected =
        turn.resumeSessionId !== undefined && RESUME_REJECTED_RE.test(stdoutTail)

      if (resumeRejected && !run.isKilled()) {
        return {
          text,
          error: `qwen refused to resume ${turn.resumeSessionId}`,
          resumeRejected: true,
        }
      }

      if (exitCode !== 0 && error === undefined && !run.isKilled()) {
        error = `qwen CLI exited ${String(exitCode)}: ${stderrTail}`
      }
      if (!sawTerminal && error === undefined && !run.isKilled()) {
        error = stderrTail
          ? `qwen CLI stream ended without a terminal event: ${stderrTail}`
          : 'qwen CLI stream ended without a terminal event'
      }
    } catch (err: unknown) {
      error ??= err instanceof Error ? err.message : String(err)
    } finally {
      run.setActiveSpawn(undefined)
      spawned.kill()
    }

    sessionId ??=
      turn.resumeSessionId ?? turn.pinSessionId ?? this.recoverSessionId(home, cwd, idsBefore)

    if (stdoutUsageRecords > 0) {
      usage.inputTokens += stdoutInput
      usage.outputTokens += stdoutOutput
      usage.totalTokens = usage.inputTokens + usage.outputTokens
    } else if (resultUsage) {
      usage.inputTokens += resultUsage.inputTokens
      usage.outputTokens += resultUsage.outputTokens
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
    }

    return { text, sessionId, error, resumeRejected: false }
  }

  private consumeLine(
    line: QwenJsonEvent,
    into: {
      den: (event: AgentEventBody) => void
      onTextDelta: (chunk: string) => void
      onTextSnapshot: (chunk: string) => void
      onThinkingDelta: (chunk: string) => void
      onThinkingSnapshot: (chunk: string) => void
      onTextBlockStart: () => void
      onSessionId: (id: string) => void
      onInit: () => void
      onTerminal: () => void
      onAssistantUsage: (tokens: {
        inputTokens: number
        outputTokens: number
        cacheRead: number
      }) => void
      onResultUsage: (tokens: {
        inputTokens: number
        outputTokens: number
        cacheRead: number
      }) => void
      onFatalResult: (subtype: string) => void
      onErrorMessage: (msg: string) => void
      toolNamesById: Map<string, string>
      startedTools: Set<string>
    },
  ): void {
    if (line.type === SESSION_TYPE) {
      const subtype = (line as { subtype?: unknown }).subtype
      if (subtype === undefined || subtype === 'init') {
        into.onInit()
        const id = sessionIdFromEvent(line)
        if (id) into.onSessionId(id)
      }
      return
    }
    if (RUNTIME_TERMINAL_TYPES.has(line.type)) {
      into.onTerminal()
      const rec = line as { is_error?: boolean; subtype?: string; result?: string }
      if (isFatalQwenResult(rec)) into.onFatalResult(rec.subtype ?? 'error')
      const tokens = usageFromEvent(line)
      if (tokens) into.onResultUsage(tokens)
      return
    }
    if (line.type === 'stream_event') {
      const inner = streamEventInner(line)
      if (!inner) return
      if (inner.type === 'content_block_start') {
        const block = inner.content_block
        if (block && block.type === 'text') into.onTextBlockStart()
        return
      }
      if (inner.type !== 'content_block_delta' || !inner.delta) return
      const t = inner.delta.type
      if (t === 'text_delta' && typeof inner.delta.text === 'string' && inner.delta.text !== '') {
        into.onTextDelta(inner.delta.text)
      } else if (
        t === 'thinking_delta' &&
        typeof inner.delta.thinking === 'string' &&
        inner.delta.thinking !== ''
      ) {
        into.onThinkingDelta(inner.delta.thinking)
      }
      return
    }
    if (line.type === 'assistant') {
      const tokens = usageFromEvent(line)
      if (tokens) into.onAssistantUsage(tokens)
      const msg = assistantMessage(line)
      const content = Array.isArray(msg?.content) ? msg.content : []
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Record<string, unknown>
        const t = item.type
        if (t === 'text' && typeof item.text === 'string' && item.text !== '') {
          into.onTextSnapshot(item.text)
        } else if (t === 'thinking' && typeof item.thinking === 'string' && item.thinking !== '') {
          into.onThinkingSnapshot(item.thinking)
        } else if (t === 'tool_use') {
          this.emitToolStart(item, into)
        }
      }
      return
    }
    if (line.type === 'user') {
      const msg = (line as { message?: { content?: unknown } }).message
      const content = Array.isArray(msg?.content) ? msg.content : []
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Record<string, unknown>
        if (item.type === 'tool_result') this.emitToolEnd(item, into)
      }
    }
  }

  private emitToolStart(
    rec: Record<string, unknown>,
    into: {
      den: (event: AgentEventBody) => void
      toolNamesById: Map<string, string>
      startedTools: Set<string>
    },
  ): void {
    const name = str(rec.name) || ''
    const id = str(rec.id)
    if (!name) return
    if (id) into.toolNamesById.set(id, name)
    const key = id ?? name
    if (into.startedTools.has(key)) return
    into.startedTools.add(key)
    into.den({ type: 'tool.start', tool: name })
  }

  private emitToolEnd(
    rec: Record<string, unknown>,
    into: {
      den: (event: AgentEventBody) => void
      toolNamesById: Map<string, string>
    },
  ): void {
    const id = str(rec.tool_use_id) || str(rec.id)
    const named = str(rec.name) || (id ? into.toolNamesById.get(id) : undefined)
    if (id && named) into.toolNamesById.set(id, named)
    into.den({ type: 'tool.end', tool: named })
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
  }): QwenTurnFacts {
    if (opts.sessionId === undefined) return emptyQwenTurnFacts()
    try {
      const sessionFile = findSessionFile({
        home: opts.home,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      })
      if (sessionFile === undefined) return emptyQwenTurnFacts()
      return reconcileTurn({ sessionDir: sessionFile, sinceMs: opts.sinceMs })
    } catch (err: unknown) {
      this.log.warn('task.usage.reconcile.failed', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return emptyQwenTurnFacts()
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
