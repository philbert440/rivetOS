/**
 * Subagent worker — executes queued sub-agent turns.
 *
 * Two modes:
 *
 *   - `createSubagentExecutor` returns an `executeTurn` callback that runs
 *     a single claimed turn against the live runtime (Router/Workspace/
 *     Tools/Hooks). Used directly in tests and in-memory dev (no pgUrl),
 *     and indirectly from the graphile-worker task in prod.
 *
 *   - `createSubagentWorker` starts an embedded graphile-worker `Runner`
 *     against Postgres that consumes `run-subagent-turn` jobs and applies
 *     the executor. On startup it sweeps any stale `running` sessions and
 *     marks them `failed` with `error='worker_restarted'` (option 1a — no
 *     mid-turn resume).
 *
 * The worker is "embedded" because subagent execution requires the live
 * Router/Workspace/Tools/Hooks. Running it as a separate process would
 * require constructing a duplicate runtime (config, providers, plugins) —
 * not worth the operational cost.
 */

import { run, type Runner, type WorkerUtils, makeWorkerUtils } from 'graphile-worker'
import type { Tool, AgentToolFilter, HookPipeline } from '@rivetos/types'
import { AgentLoop } from './loop.js'
import type { Router } from './router.js'
import type { WorkspaceLoader } from './workspace.js'
import { filterToolsForAgent, deduplicateTools } from './delegation.js'
import type { SubagentStore, ClaimedSession, TurnResult } from './subagent-store.js'
import { logger } from '../logger.js'

const log = logger('SubagentWorker')

const TASK_NAME = 'run-subagent-turn'

export interface SubagentExecutorConfig {
  router: Router
  workspace: WorkspaceLoader
  store: SubagentStore
  /** Tool resolver — called at execute time, not construction time */
  tools: () => Tool[]
  hooks?: HookPipeline
  toolFilter?: Record<string, AgentToolFilter>
  /** Workspace directory — passed to tools via ToolContext */
  workspaceDir?: string
  /** Turn wall-clock timeout in seconds (passed to spawned AgentLoop as ms) */
  turnTimeout?: number
  contextConfig?: { softNudgePct?: number[]; hardNudgePct?: number }
}

export interface SubagentExecutor {
  executeTurn(sessionId: string): Promise<void>
}

/** Build the per-turn executor. Pure — no I/O until executeTurn() is called. */
export function createSubagentExecutor(cfg: SubagentExecutorConfig): SubagentExecutor {
  return {
    async executeTurn(sessionId: string): Promise<void> {
      const claimed = await cfg.store.claim(sessionId)
      if (!claimed) {
        log.warn(`Skipping subagent turn ${sessionId} — already terminal or removed`)
        return
      }

      const userMessage = claimed.pendingMessage
      const result = await runTurn(claimed, userMessage, cfg)
      await cfg.store.recordTurn(sessionId, userMessage, result)
    },
  }
}

async function runTurn(
  session: ClaimedSession,
  userMessage: string,
  cfg: SubagentExecutorConfig,
): Promise<TurnResult> {
  const startedAt = Date.now()
  const agent = cfg.router.getAgents().find((a) => a.id === session.childAgent)
  if (!agent) {
    return {
      status: 'failed',
      iterations: 0,
      toolsUsed: [],
      response: '',
      error: `Agent "${session.childAgent}" no longer registered`,
    }
  }
  const provider = cfg.router.getProviders().find((p) => p.id === agent.provider)
  if (!provider) {
    return {
      status: 'failed',
      iterations: 0,
      toolsUsed: [],
      response: '',
      error: `Provider "${agent.provider}" not available`,
    }
  }

  const abort = new AbortController()
  // The session row may have been flipped to 'killed' between claim() and
  // the call to AgentLoop.run(). The graphile-worker job runs to completion;
  // we honor kill by passing the abort signal, which AgentLoop respects at
  // step boundaries. Mid-turn checkpointing is out of scope (option 1a).

  try {
    const systemPrompt = await cfg.workspace.buildSystemPrompt(session.childAgent)
    const enrichedPrompt =
      systemPrompt +
      '\n\n## Sub-agent Context\n' +
      'You are running as a sub-agent spawned by another agent.\n' +
      'Complete your assigned task thoroughly. When done, provide a clear summary of what you accomplished.'

    const tools = deduplicateTools(
      filterToolsForAgent(cfg.tools(), session.childAgent, cfg.toolFilter),
    )

    const loop = new AgentLoop({
      systemPrompt: enrichedPrompt,
      provider,
      tools,
      modelOverride: session.modelOverride ?? agent.model,
      agentId: session.childAgent,
      workspaceDir: cfg.workspaceDir,
      hooks: cfg.hooks,
      freshConversation: true,
      turnTimeout: cfg.turnTimeout ? cfg.turnTimeout * 1000 : undefined,
      contextWindow: provider.getContextWindow(),
      contextConfig: cfg.contextConfig,
    })

    const result = await loop.run(userMessage, session.history, abort.signal)

    if (result.aborted) {
      return {
        status: 'failed',
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
        usage: result.usage,
        response: result.partialResponse ?? result.response,
        error: 'Aborted',
      }
    }

    return {
      status: 'completed',
      iterations: result.iterations,
      toolsUsed: result.toolsUsed,
      usage: result.usage,
      response: result.response,
    }
  } catch (err: unknown) {
    const msg = (err as Error).message
    log.error(`Sub-agent turn ${session.id} failed after ${Date.now() - startedAt}ms: ${msg}`)
    return {
      status: 'failed',
      iterations: 0,
      toolsUsed: [],
      response: '',
      error: msg,
    }
  }
}

// ---------------------------------------------------------------------------
// Embedded graphile-worker runner — production path.
// ---------------------------------------------------------------------------

export interface SubagentWorker {
  start(): Promise<void>
  stop(): Promise<void>
  /** Add a job for the given session id (used by SubagentManagerImpl.enqueueTurn). */
  enqueue(sessionId: string): Promise<void>
}

export interface SubagentWorkerOptions extends SubagentExecutorConfig {
  pgUrl: string
  concurrency?: number
}

export function createSubagentWorker(opts: SubagentWorkerOptions): SubagentWorker {
  const executor = createSubagentExecutor(opts)
  let runner: Runner | undefined
  let utils: WorkerUtils | undefined

  return {
    async start(): Promise<void> {
      const swept = await opts.store.sweepRunning()
      if (swept > 0) {
        log.warn(
          `Swept ${swept} stale 'running' subagent session(s) — marked failed (worker_restarted)`,
        )
      }

      utils = await makeWorkerUtils({ connectionString: opts.pgUrl })

      runner = await run({
        connectionString: opts.pgUrl,
        concurrency: opts.concurrency ?? 4,
        noHandleSignals: true,
        pollInterval: 2_000,
        taskList: {
          [TASK_NAME]: async (payload) => {
            const sessionId = (payload as { sessionId?: string } | null)?.sessionId
            if (typeof sessionId !== 'string' || sessionId.length === 0) {
              log.warn(`run-subagent-turn fired with invalid payload: ${JSON.stringify(payload)}`)
              return
            }
            await executor.executeTurn(sessionId)
          },
        },
      })

      log.info('Ready — graphile-worker listening for run-subagent-turn jobs')
    },

    async stop(): Promise<void> {
      if (runner) {
        await runner.stop()
        runner = undefined
      }
      if (utils) {
        await utils.release()
        utils = undefined
      }
      log.info('Stopped')
    },

    async enqueue(sessionId: string): Promise<void> {
      if (!utils) {
        throw new Error('SubagentWorker.enqueue called before start()')
      }
      await utils.addJob(TASK_NAME, { sessionId }, { maxAttempts: 1 })
    },
  }
}
