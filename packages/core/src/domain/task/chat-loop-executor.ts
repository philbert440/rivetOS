/**
 * ChatLoopExecutor — HarnessExecutor over the in-process AgentLoop.
 *
 * Wraps today's subagent turn semantics (see subagent-worker.runTurn) in the
 * HarnessExecutor contract: agent/provider lookup via the Router, workspace
 * system prompt + task scaffold (goal / resolved context / acceptance
 * criteria), tool filtering, and a fresh AgentLoop conversation per start().
 *
 * One start() drives one turn: the goal (plus resolved context) is the user
 * message. steer() before/during the turn queues a follow-up turn on the same
 * handle; after the result resolves, steering is a no-op. `result` NEVER
 * rejects — every failure path resolves with a TaskResult.
 */

import type {
  AgentToolFilter,
  HarnessExecutor,
  HarnessExecutorCapabilities,
  HookPipeline,
  TaskEvent,
  TaskHandle,
  TaskResult,
  TaskSpec,
  TaskUsage,
  Tool,
} from '@rivetos/types'
import { AgentLoop } from '../loop.js'
import type { Router } from '../router.js'
import type { WorkspaceLoader } from '../workspace.js'
import { filterToolsForAgent, deduplicateTools } from '../delegation.js'
import { logger } from '../../logger.js'

const log = logger('ChatLoopExecutor')

export interface ChatLoopExecutorConfig {
  router: Router
  workspace: WorkspaceLoader
  /** Tool resolver — called at start() time, not construction time */
  tools: () => Tool[]
  hooks?: HookPipeline
  toolFilter?: Record<string, AgentToolFilter>
  /** Workspace directory — passed to tools via ToolContext */
  workspaceDir?: string
  /** Turn wall-clock timeout in seconds (passed to AgentLoop as ms) */
  turnTimeout?: number
  contextConfig?: { softNudgePct?: number[]; hardNudgePct?: number }
}

/** Unbounded push queue exposed as an AsyncIterable — done() completes it. */
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

export function createChatLoopExecutor(cfg: ChatLoopExecutorConfig): HarnessExecutor {
  return {
    name: 'chat-loop',

    capabilities(): HarnessExecutorCapabilities {
      return {
        steerable: true,
        multiTurn: true,
        structuredStream: true,
        usageInResult: true,
        sessionIdCapture: false,
        slashCommands: false,
        effortSelection: false,
        mcpInjection: 'none',
      }
    },

    start(spec: TaskSpec, opts: { signal: AbortSignal }): TaskHandle {
      const events = new EventQueue()
      const abort = new AbortController()
      const steered: string[] = []
      let killed = false
      let killReason: string | undefined
      let finished = false

      if (opts.signal.aborted) abort.abort(opts.signal.reason)
      else opts.signal.addEventListener('abort', () => abort.abort(opts.signal.reason))

      const result: Promise<TaskResult> = runTask(spec, cfg, {
        events,
        abortSignal: abort.signal,
        nextSteer: () => steered.shift(),
        isKilled: () => killed || abort.signal.aborted,
        killReason: () => killReason ?? (abort.signal.reason as string | undefined),
      })
        .catch((err: unknown) => {
          // Belt-and-braces: runTask already catches; result must never reject.
          const msg = err instanceof Error ? err.message : String(err)
          log.error(`Task ${spec.taskId} executor crashed: ${msg}`)
          const fallback: TaskResult = {
            verdict: 'failed',
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
          killed = true
          killReason = reason
          abort.abort(reason ?? 'killed')
          return Promise.resolve()
        },
        result,
      }
    },
  }
}

interface RunContext {
  events: EventQueue
  abortSignal: AbortSignal
  nextSteer: () => string | undefined
  isKilled: () => boolean
  killReason: () => string | undefined
}

async function runTask(
  spec: TaskSpec,
  cfg: ChatLoopExecutorConfig,
  run: RunContext,
): Promise<TaskResult> {
  const startedAt = Date.now()
  const usage = emptyUsage()

  const fail = (error: string): TaskResult => ({
    verdict: 'failed',
    summary: error,
    artifacts: [],
    usage: { ...usage, wallClockMs: Date.now() - startedAt },
    error,
  })

  const agent = cfg.router.getAgents().find((a) => a.id === spec.agentId)
  if (!agent) return fail(`Agent "${spec.agentId}" not registered`)
  const provider = cfg.router.getProviders().find((p) => p.id === agent.provider)
  if (!provider) return fail(`Provider "${agent.provider}" not available`)

  try {
    const basePrompt = await cfg.workspace.buildSystemPrompt(spec.agentId)
    const scaffold = [
      '\n\n## Task Context',
      'You are executing a delegated task. Complete it thoroughly, then provide a clear summary of what you accomplished.',
      `\n### Goal\n${spec.goal}`,
      spec.resolvedContext ? `\n### Context\n${spec.resolvedContext}` : '',
      spec.acceptanceCriteria.length > 0
        ? `\n### Acceptance criteria\n${spec.acceptanceCriteria
            .map((c) => `- [${c.id}] ${c.description}`)
            .join('\n')}`
        : '',
      spec.systemPromptAppend ? `\n${spec.systemPromptAppend}` : '',
    ].join('')

    const tools = deduplicateTools(filterToolsForAgent(cfg.tools(), spec.agentId, cfg.toolFilter))

    const loop = new AgentLoop({
      systemPrompt: basePrompt + scaffold,
      provider,
      tools,
      modelOverride: spec.model ?? agent.model,
      agentId: spec.agentId,
      workspaceDir: spec.workingDir ?? cfg.workspaceDir,
      hooks: cfg.hooks,
      freshConversation: true,
      turnTimeout: cfg.turnTimeout ? cfg.turnTimeout * 1000 : undefined,
      contextWindow: provider.getContextWindow(),
      contextConfig: cfg.contextConfig,
    })

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
    // Resume from awaiting-input: the steered message opens the run INSTEAD
    // of the goal — the goal must never re-execute on resume. Interim shape:
    // still a fresh conversation; rehydrating history from the task's memory
    // conversation (session_key = task:<id>) lands at cutover step (c).
    let message: string | undefined = spec.resumeMessage ?? spec.goal
    let lastResponse = ''

    while (message !== undefined) {
      if (run.isKilled()) break
      usage.turns += 1
      run.events.push({ ts: Date.now(), type: 'turn.start', turn: usage.turns })

      const turn = await loop.run(message, history, run.abortSignal)

      usage.inputTokens += turn.usage?.promptTokens ?? 0
      usage.outputTokens += turn.usage?.completionTokens ?? 0
      usage.totalTokens = usage.inputTokens + usage.outputTokens
      usage.wallClockMs = Date.now() - startedAt
      run.events.push({ ts: Date.now(), type: 'turn.end', turn: usage.turns, usage: { ...usage } })

      if (turn.aborted) {
        lastResponse = turn.partialResponse ?? turn.response
        break
      }

      lastResponse = turn.response
      history.push(
        { role: 'user', content: message },
        { role: 'assistant', content: turn.response },
      )
      message = run.nextSteer()
    }

    usage.wallClockMs = Date.now() - startedAt

    if (run.isKilled()) {
      return {
        verdict: 'killed',
        summary: run.killReason() ?? 'Killed',
        output: lastResponse || undefined,
        artifacts: [],
        usage,
        error: run.killReason(),
      }
    }

    return {
      verdict: 'completed',
      summary: lastResponse,
      output: lastResponse,
      artifacts: [],
      usage,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`Task ${spec.taskId} failed after ${String(Date.now() - startedAt)}ms: ${msg}`)
    return fail(msg)
  }
}
