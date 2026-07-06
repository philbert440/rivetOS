/**
 * ClaudeCliExecutor — HarnessExecutor over headless `claude -p` spawns.
 *
 * Phase 1 step (b) of the task engine (design doc Appendix B): the runner
 * hands us a TaskSpec, we drive one claude spawn per turn through the shared
 * spawn-turn layer and translate the CLI's stream-json into TaskEvents.
 *
 * Shape per start():
 *   - Turn 1 runs `spec.resumeMessage ?? spec.goal`; steer() queues follow-up
 *     turns on the same handle (steer applies BETWEEN turns — each turn is a
 *     fresh spawn, no --resume stitching yet). After result resolves,
 *     steering is a no-op.
 *   - Per spawn: the per-spawn MCP bridge (embedMcpServerForTurn) exposes the
 *     task's allowed RivetOS tools via --mcp-config; the child env carries
 *     RIVETOS_SESSION_KEY=task:<taskId> (the contracted join key for the
 *     task's memory conversation — capture hooks stamp it into the spool and
 *     both ingest paths key on it, so every spawn files under task:<id>) and
 *     RIVETOS_DEN_HOOK_DISABLED=1 (this executor owns den emission — the
 *     hook must not double-report).
 *   - stream-json → TaskEvent: assistant text → den message.agent, thinking
 *     deltas → den thinking.delta/thinking.end, tool_use/tool_result → den
 *     tool.start/tool.end. CliResult → {type:'cost'} (total_cost_usd) and
 *     turn.end carrying cumulative usage (incl. costUsd) + the spawn's
 *     session_id as harnessSessionId.
 *   - Structured result: the system append asks the model to end with a
 *     fenced TASK_RESULT JSON block; we parse it, falling back to
 *     {verdict:'completed', summary:<last text>} on any parse failure.
 *     `result` NEVER rejects.
 *   - kill(): SIGTERM then SIGKILL after the grace period → verdict 'killed'.
 *
 * Locked constraint: NO RivetOS-side per-turn timeout. The runner enforces
 * budget between turns via the abort signal.
 */

import type {
  AgentEventBody,
  HarnessExecutor,
  Memory,
  HarnessExecutorCapabilities,
  TaskEvent,
  TaskHandle,
  TaskResult,
  TaskSpec,
  TaskUsage,
  Tool,
} from '@rivetos/types'
import {
  taskResultFenceInstructions,
  parseTaskResultJson,
  parseTaskResultBlock,
  TASK_RESULT_JSON_SCHEMA,
} from '@rivetos/types'
import { embedMcpServerForTurn, type EmbeddedMcpHandle } from './mcp-bridge.js'
import {
  spawnClaudeTurn,
  type ClaudeCliEffort,
  type CliResult,
  type CliStreamEvent,
  type CliSystemInit,
  type SpawnedTurn,
} from './spawn-turn.js'
import { createLogger, type BridgeLogger } from './log.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClaudeCliExecutorConfig {
  /** Path to the `claude` binary. */
  binary: string
  /** Default model (spec.model overrides). Empty = CLI default. */
  modelId?: string
  /** Built-in tool list passed via --tools. */
  toolsArg?: string
  /** Default reasoning effort (spec.effort overrides). */
  effort?: ClaudeCliEffort
  /** Permission mode passed via --permission-mode. */
  permissionMode?: string
  /** When true, append --exclude-dynamic-system-prompt-sections. */
  excludeDynamicSections?: boolean
  /** Default working directory (spec.workingDir overrides). */
  cwd?: string
  /** Live RivetOS tools for the per-spawn MCP bridge; filtered per task by
   *  spec.tools (tool names). Resolved at start() time. */
  tools?: () => Tool[]
  /** Pass --json-schema for structured TASK_RESULT (default true). Boot
   *  probes the CLI's --help and disables this for older CLIs — an unknown
   *  flag would hard-fail every spawn with no fence fallback ever reached. */
  structuredResult?: boolean
  /** Task-conversation source for resume rehydration: on resume-from-
   *  awaiting-input the prior transcript (session_key task:<id>, written by
   *  the capture hooks) is rendered into the system append so the resumed
   *  spawn sees what already happened — parity with chat-loop (step (c)). */
  memory?: Pick<Memory, 'getSessionHistory'>
}

/** Caps for the rendered resume transcript — keep the system append sane. */
const RESUME_TRANSCRIPT_MAX_CHARS = 24_000
const RESUME_MESSAGE_MAX_CHARS = 2_000

/**
 * Render the task's prior conversation for a resumed spawn: role-labeled,
 * newest-preserved (oldest turns drop first when over budget), each message
 * truncated. Returns '' when there is nothing usable.
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
  // Keep the newest turns: drop from the front until under budget.
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

/** Mirrors the provider default — curated file/shell/web set. */
const DEFAULT_TOOLS_ARG = 'Bash,Read,Edit,Grep,Glob,WebFetch,WebSearch,TodoWrite,Write'

// ---------------------------------------------------------------------------
// TASK_RESULT scaffold + parsing — shared shape logic lives in @rivetos/types
// (task-result.ts, phase 2c) so chat-loop emits the identical contract.
// Re-exported here for existing consumers/tests.
// ---------------------------------------------------------------------------

export { TASK_RESULT_FENCE } from '@rivetos/types'
export { TASK_RESULT_JSON_SCHEMA, parseTaskResultJson, parseTaskResultBlock }

/** System-append scaffold: task context + the structured-result contract. */
export function buildTaskSystemAppend(spec: TaskSpec): string {
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

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class ClaudeCliExecutor implements HarnessExecutor {
  readonly name = 'claude-cli'
  private readonly cfg: ClaudeCliExecutorConfig
  private readonly log: BridgeLogger

  constructor(cfg: ClaudeCliExecutorConfig) {
    this.cfg = cfg
    this.log = createLogger('claude-cli-executor')
  }

  capabilities(): HarnessExecutorCapabilities {
    return {
      steerable: true, // between turns — no mid-spawn steering
      multiTurn: true,
      structuredStream: true,
      usageInResult: true,
      sessionIdCapture: true,
      slashCommands: true,
      effortSelection: true,
      mcpInjection: 'flag',
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
    let systemText = buildTaskSystemAppend(spec)
    // Resume rehydration (step-(c) parity): render the task conversation the
    // capture hooks wrote under task:<id> into the system append. Failure
    // degrades to an empty transcript — losing context is survivable,
    // failing the resume is not.
    if (spec.resumeMessage !== undefined && this.cfg.memory) {
      try {
        const history = await this.cfg.memory.getSessionHistory(`task:${spec.taskId}`, {
          limit: 1000,
        })
        const transcript = renderResumeTranscript(history)
        if (transcript) systemText = `${systemText}\n\n${transcript}`
      } catch (err: unknown) {
        this.log.warn('task.resume.rehydration.failed', {
          taskId: spec.taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    let lastText = ''
    let lastStructured: string | undefined
    let lastError: string | undefined

    const allowedTools = (): Tool[] => {
      const all = this.cfg.tools?.() ?? []
      if (!spec.tools) return all
      const names = new Set(spec.tools)
      return all.filter((t) => names.has(t.name))
    }

    let message: string | undefined = spec.resumeMessage ?? spec.goal

    while (message !== undefined && !run.isKilled()) {
      usage.turns += 1
      run.events.push({ ts: Date.now(), type: 'turn.start', turn: usage.turns })

      const turn = await this.runOneSpawn(spec, systemText, message, allowedTools(), run, usage)
      usage.wallClockMs = Date.now() - startedAt
      run.events.push({
        ts: Date.now(),
        type: 'turn.end',
        turn: usage.turns,
        usage: { ...usage },
        harnessSessionId: turn.sessionId,
      })

      if (turn.text) lastText = turn.text
      if (turn.structured) lastStructured = turn.structured
      if (turn.error) {
        lastError = turn.error
        break
      }
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

    // Structured result: the --json-schema result is authoritative; the
    // fenced TASK_RESULT block is the fallback (older CLI / missing result);
    // last resort is a plain 'completed' result carrying the final text.
    const parsed =
      (lastStructured ? parseTaskResultJson(lastStructured) : undefined) ??
      parseTaskResultBlock(lastText)
    if (parsed) {
      return { ...parsed, output: parsed.output ?? lastText, usage }
    }
    return {
      verdict: 'completed',
      summary: lastText,
      output: lastText || undefined,
      artifacts: [],
      usage,
    }
  }

  /**
   * One `claude -p` spawn: MCP bridge up, spawn, translate stream-json into
   * den TaskEvents, accumulate usage/cost, tear the bridge down. Returns the
   * turn's final text plus the spawn's session id; failures come back as
   * `error` (never thrown) so the caller's result contract holds.
   */
  private async runOneSpawn(
    spec: TaskSpec,
    systemText: string,
    message: string,
    tools: Tool[],
    run: {
      events: EventQueue
      isKilled: () => boolean
      setActiveSpawn: (s: SpawnedTurn | undefined) => void
    },
    usage: TaskUsage,
  ): Promise<{ text: string; structured?: string; sessionId?: string; error?: string }> {
    const den = (event: AgentEventBody): void => {
      run.events.push({ ts: Date.now(), type: 'den', event })
    }

    // Per-spawn MCP bridge — soft-fail like the model wrapper: without it
    // claude keeps its native tools but won't see RivetOS tools this turn.
    let bridge: EmbeddedMcpHandle | undefined
    if (tools.length > 0 && process.env.RIVETOS_DISABLE_MCP_BRIDGE !== '1') {
      try {
        bridge = await embedMcpServerForTurn({ tools, agentId: spec.agentId, log: this.log })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log.warn('mcp.bridge.bringup.failed', { taskId: spec.taskId, error: msg })
      }
    }

    let spawned: SpawnedTurn
    try {
      spawned = spawnClaudeTurn(
        {
          binary: this.cfg.binary,
          modelId: spec.model ?? this.cfg.modelId ?? '',
          toolsArg: this.cfg.toolsArg ?? DEFAULT_TOOLS_ARG,
          effort: spec.effort ?? this.cfg.effort ?? 'medium',
          permissionMode: this.cfg.permissionMode ?? 'default',
          excludeDynamicSections: this.cfg.excludeDynamicSections ?? true,
          systemText,
          mcpConfigPath: bridge?.configPath,
          jsonSchema: (this.cfg.structuredResult ?? true) ? TASK_RESULT_JSON_SCHEMA : undefined,
          cwd: spec.workingDir ?? this.cfg.cwd,
        },
        message,
        {
          env: {
            // Contracted join key for the task's memory conversation —
            // capture hooks carry it through the spool as a verbatim key
            // override, so every CLI session this task spawns files under
            // one task:<id> conversation (rehydrated on resume).
            RIVETOS_SESSION_KEY: `task:${spec.taskId}`,
            // This executor owns den emission — the den hook must stay quiet.
            RIVETOS_DEN_HOOK_DISABLED: '1',
          },
        },
      )
    } catch (err: unknown) {
      if (bridge) await bridge.close().catch(() => undefined)
      const msg = err instanceof Error ? err.message : String(err)
      return { text: '', error: `Failed to spawn ${this.cfg.binary}: ${msg}` }
    }

    run.setActiveSpawn(spawned)
    this.log.info('task.spawn', { taskId: spec.taskId, pid: spawned.proc.pid, hasMcp: !!bridge })

    let sessionId: string | undefined
    let spawnFailure: string | undefined
    // spawn() failures (ENOENT etc.) surface as async 'error' events — an
    // unhandled one would crash the process, and result must never reject.
    spawned.proc.once('error', (err) => {
      spawnFailure ??= `Failed to spawn ${this.cfg.binary}: ${err.message}`
    })
    spawned.proc.stdin.on('error', () => {
      /* EPIPE on a dead child — the proc 'error'/exit path reports it */
    })
    let text = ''
    let sawResult = false
    let resultText: string | undefined
    let structured: string | undefined
    let error: string | undefined
    let thinkingOpen = false
    const toolNamesById = new Map<string, string>()

    const closeThinking = (): void => {
      if (thinkingOpen) {
        den({ type: 'thinking.end' })
        thinkingOpen = false
      }
    }

    try {
      for await (const event of spawned.events()) {
        if (event.type === 'system') {
          const init = event as CliSystemInit
          sessionId = init.session_id
          if (init.apiKeySource && init.apiKeySource !== 'none') {
            spawned.kill()
            error =
              `claude-cli: unexpected apiKeySource="${init.apiKeySource}" — ` +
              `this executor requires OAuth/keychain auth`
          }
          continue
        }

        if (event.type === 'stream_event') {
          const inner = (event as CliStreamEvent).event
          if (inner.type === 'content_block_delta' && inner.delta) {
            if (inner.delta.type === 'thinking_delta' && inner.delta.thinking) {
              thinkingOpen = true
              den({ type: 'thinking.delta', text: inner.delta.thinking })
            } else if (inner.delta.type === 'text_delta' && inner.delta.text) {
              closeThinking()
            }
          }
          continue
        }

        // Full assistant messages carry final text + tool_use blocks.
        if (event.type === 'assistant') {
          closeThinking()
          const assistant = event as unknown as {
            message?: {
              content?: Array<{ type?: string; text?: string; id?: string; name?: string }>
            }
          }
          for (const block of assistant.message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text) {
              text += block.text
              den({ type: 'message.agent', text: block.text })
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              if (typeof block.id === 'string') toolNamesById.set(block.id, block.name)
              den({ type: 'tool.start', tool: block.name })
            }
          }
          continue
        }

        // User events in -p mode are tool results fed back into the loop.
        if (event.type === 'user') {
          const user = event as unknown as {
            message?: { content?: Array<{ type?: string; tool_use_id?: string }> }
          }
          for (const block of user.message?.content ?? []) {
            if (block.type === 'tool_result') {
              const tool =
                typeof block.tool_use_id === 'string'
                  ? toolNamesById.get(block.tool_use_id)
                  : undefined
              den({ type: 'tool.end', tool })
            }
          }
          continue
        }

        if (event.type === 'result') {
          closeThinking()
          const r = event as CliResult
          sawResult = true
          sessionId = r.session_id || sessionId
          if (r.usage) {
            usage.inputTokens +=
              (r.usage.input_tokens ?? 0) +
              (r.usage.cache_creation_input_tokens ?? 0) +
              (r.usage.cache_read_input_tokens ?? 0)
            usage.outputTokens += r.usage.output_tokens ?? 0
            usage.totalTokens = usage.inputTokens + usage.outputTokens
          }
          if (typeof r.total_cost_usd === 'number') {
            const total = (usage.costUsd ?? 0) + r.total_cost_usd
            run.events.push({
              ts: Date.now(),
              type: 'cost',
              deltaUsd: r.total_cost_usd,
              totalUsd: total,
            })
            usage.costUsd = total
          }
          if (r.is_error) {
            error ??= `claude-cli error: ${r.result ?? 'unknown'}`
          } else if (typeof r.result === 'string' && r.result) {
            resultText = r.result
            // With --json-schema in force the result field is the
            // schema-validated JSON, not prose.
            if (parseTaskResultJson(r.result)) structured = r.result
          }
        }
      }

      const exitCode = await spawned.waitExit()
      error ??= spawnFailure
      if (exitCode !== 0 && !sawResult && error === undefined) {
        error = `claude CLI exited ${String(exitCode)}: ${spawned.stderrText().slice(0, 500)}`
      }
      if (!sawResult && error === undefined && !run.isKilled()) {
        error = 'claude CLI stream ended without a result event'
      }
    } catch (err: unknown) {
      error ??= err instanceof Error ? err.message : String(err)
    } finally {
      closeThinking()
      run.setActiveSpawn(undefined)
      spawned.kill() // no-op when already exited — reaps every path
      if (bridge) {
        await bridge.close().catch(() => undefined)
      }
    }

    // Prefer the result event's final text (covers result-only turns with no
    // assistant events); fall back to accumulated assistant text. NOTE: the
    // accumulated-text fallback concatenates EVERY assistant message of the
    // turn, so a TASK_RESULT block emitted mid-conversation can be picked up
    // by the parser. Acceptable for now (parser takes the LAST block);
    // revisit with structured output (--json-schema) later.
    return { text: text || (structured ? '' : (resultText ?? '')), structured, sessionId, error }
  }
}
