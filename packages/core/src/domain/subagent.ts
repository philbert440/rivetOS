/**
 * Sub-agent Manager — orchestrates child agent sessions.
 *
 * Async-first design:
 * - spawn() fires the AgentLoop in the background, returns immediately
 * - status() polls for progress (iterations, tools, partial/final response)
 * - send() sends follow-up messages (starts a new background turn)
 * - kill() aborts a running session
 * - list() shows all sessions
 *
 * No synchronous blocking. The calling agent can fire off work,
 * do other things, and check back when ready.
 *
 * Pure domain logic. Depends only on interfaces from @rivetos/types
 * plus the internal Router and WorkspaceLoader.
 */

import { randomUUID } from 'node:crypto'
import type {
  SubagentSession,
  SubagentSpawnRequest,
  SubagentStatusResponse,
  SubagentManager,
  Tool,
  Provider,
  AgentToolFilter,
} from '@rivetos/types'
// getTextContent available from @rivetos/types if needed
import { AgentLoop } from './loop.js'
import type { Router } from './router.js'
import type { WorkspaceLoader } from './workspace.js'
import { filterToolsForAgent, deduplicateTools } from './delegation.js'
import { logger } from '../logger.js'

const log = logger('SubagentManager')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SubagentManagerConfig {
  router: Router
  workspace: WorkspaceLoader
  /** Tool resolver — called at spawn/send time, not construction time */
  tools: () => Tool[]
  /** Hook pipeline for delegation events */
  hooks?: import('@rivetos/types').HookPipeline
  /** Per-agent tool filtering (exclude/include lists) */
  toolFilter?: Record<string, AgentToolFilter>
  /** Workspace directory — passed to tools via ToolContext for resolving relative paths */
  workspaceDir?: string
  /** Turn wall-clock timeout in seconds (passed to spawned AgentLoop as ms) */
  turnTimeout?: number
  /** Context management thresholds (passed to spawned AgentLoop) */
  contextConfig?: { softNudgePct?: number[]; hardNudgePct?: number }
}

// ---------------------------------------------------------------------------
// Internal Session State
// ---------------------------------------------------------------------------

/** Extends the public SubagentSession with private fields */
interface InternalSession extends SubagentSession {
  abort: AbortController
  /** Model override from agent config */
  modelOverride?: string
  /** Timeout handle (if timeout was specified) */
  timeoutHandle?: ReturnType<typeof setTimeout>
  /** Start time for elapsed calculation */
  startTime: number
  /** Live-updated iterations count */
  _iterations: number
  /** Live-updated tools list */
  _toolsUsed: string[]
  /** Live-updated partial response */
  _lastResponse: string
  /** Live-updated usage */
  _usage?: { promptTokens: number; completionTokens: number }
  /** When the session reached a terminal state (completed/failed/killed) */
  completedAt?: number
}

// ---------------------------------------------------------------------------
// Session TTL — clean up terminal sessions after 1 hour
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 60 * 60 * 1000 // 1 hour
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SubagentManagerImpl implements SubagentManager {
  private config: SubagentManagerConfig
  private sessions: Map<string, InternalSession> = new Map()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(config: SubagentManagerConfig) {
    this.config = config
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref() // Don't prevent process exit
  }

  /** Remove terminal sessions older than SESSION_TTL_MS */
  private cleanupExpiredSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.completedAt && now - session.completedAt > SESSION_TTL_MS) {
        this.sessions.delete(id)
        log.info(`Cleaned up expired sub-agent session ${id} (${session.childAgent})`)
      }
    }
  }

  spawn(request: SubagentSpawnRequest): SubagentSession {
    const { router, workspace } = this.config

    // Resolve the child agent and its provider
    const agents = router.getAgents()
    const agent = agents.find((a) => a.id === request.agent)
    if (!agent) {
      throw new Error(
        `Unknown agent: "${request.agent}". Available: ${agents.map((a) => a.id).join(', ')}`,
      )
    }

    const providers = router.getProviders()
    const provider = providers.find((p) => p.id === agent.provider)
    if (!provider) {
      throw new Error(`Provider "${agent.provider}" not available for agent "${request.agent}"`)
    }

    const sessionId = randomUUID()
    const abort = new AbortController()

    const session: InternalSession = {
      id: sessionId,
      parentAgent: 'parent',
      childAgent: request.agent,
      provider: agent.provider,
      status: 'running',
      history: [],
      createdAt: Date.now(),
      abort,
      modelOverride: agent.model,
      startTime: Date.now(),
      _iterations: 0,
      _toolsUsed: [],
      _lastResponse: '',
    }

    // Apply timeout if specified
    if (request.timeoutMs) {
      session.timeoutHandle = setTimeout(() => {
        abort.abort(`Sub-agent timeout after ${request.timeoutMs}ms`)
      }, request.timeoutMs)
    }

    this.sessions.set(sessionId, session)

    // Fire the agent loop in the background — no await
    void this.runInBackground(session, workspace, provider, request.task)

    return this.toPublicSession(session)
  }

  status(sessionId: string): SubagentStatusResponse {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`)
    }

    return {
      id: session.id,
      agent: session.childAgent,
      status: session.status,
      elapsedMs: Date.now() - session.startTime,
      iterations: session._iterations,
      toolsUsed: [...new Set(session._toolsUsed)],
      lastResponse: session._lastResponse,
      usage: session._usage,
      error: session.error,
      messageCount: session.history.length,
    }
  }

  send(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`)
    }
    if (session.status === 'running') {
      throw new Error(`Sub-agent session ${sessionId} is still running — wait for completion`)
    }
    if (session.status === 'failed') {
      throw new Error(`Sub-agent session ${sessionId} has failed — cannot send messages`)
    }

    const { router, workspace } = this.config

    const agent = router.getAgents().find((a) => a.id === session.childAgent)
    if (!agent) {
      throw new Error(`Agent "${session.childAgent}" no longer registered`)
    }

    const provider = router.getProviders().find((p) => p.id === agent.provider)
    if (!provider) {
      throw new Error(`Provider "${agent.provider}" not available`)
    }

    // Reset session state for new turn
    session.status = 'running'
    session.startTime = Date.now()
    session._iterations = 0
    session._toolsUsed = []
    session._lastResponse = ''
    session._usage = undefined
    session.error = undefined

    // Fire follow-up in background
    void this.runInBackground(session, workspace, provider, message)
  }

  list(): SubagentSession[] {
    return [...this.sessions.values()].map((s) => this.toPublicSession(s))
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`)
    }
    session.abort.abort('Killed by parent')
    if (session.timeoutHandle) clearTimeout(session.timeoutHandle)
    session.status = 'failed'
    session.error = 'Killed by parent'
    session.durationMs = Date.now() - session.startTime
    session.completedAt = Date.now()
    log.info(`Sub-agent ${sessionId} killed`)
  }

  // -----------------------------------------------------------------------
  // Internal — background execution
  // -----------------------------------------------------------------------

  private async runInBackground(
    session: InternalSession,
    workspace: WorkspaceLoader,
    provider: Provider,
    userMessage: string,
  ): Promise<void> {
    try {
      // Build system prompt
      const systemPrompt = await workspace.buildSystemPrompt(session.childAgent)
      const enrichedPrompt =
        systemPrompt +
        '\n\n## Sub-agent Context\n' +
        'You are running as a sub-agent spawned by another agent.\n' +
        'Complete your assigned task thoroughly. When done, provide a clear summary of what you accomplished.'

      // Resolve, filter, and deduplicate tools
      const tools = deduplicateTools(
        filterToolsForAgent(this.config.tools(), session.childAgent, this.config.toolFilter),
      )

      const loop = new AgentLoop({
        systemPrompt: enrichedPrompt,
        provider,
        tools,
        modelOverride: session.modelOverride,
        agentId: session.childAgent,
        workspaceDir: this.config.workspaceDir,
        freshConversation: true,
        turnTimeout: this.config.turnTimeout ? this.config.turnTimeout * 1000 : undefined,
        contextWindow: provider.getContextWindow(),
        contextConfig: this.config.contextConfig,
      })

      // Add user message to history
      session.history.push({ role: 'user', content: userMessage })

      const result = await loop.run(userMessage, session.history.slice(0, -1), session.abort.signal)

      // Update session with final results
      session._iterations = result.iterations
      session._toolsUsed = result.toolsUsed
      session._usage = result.usage
      session._lastResponse = result.response

      if (result.aborted) {
        session.status = 'failed'
        session.error = 'Aborted'
        session._lastResponse = result.partialResponse ?? result.response
      } else {
        session.status = 'completed'
        session.history.push({ role: 'assistant', content: result.response })
      }

      session.durationMs = Date.now() - session.startTime
      session.iterations = result.iterations
      session.toolsUsed = result.toolsUsed
      session.usage = result.usage
      session.lastResponse = session._lastResponse
    } catch (err: unknown) {
      session.status = 'failed'
      session.error = (err as Error).message
      session.durationMs = Date.now() - session.startTime
      log.error(`Sub-agent ${session.id} failed: ${(err as Error).message}`)
    } finally {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle)
      session.completedAt = Date.now()
    }
  }

  private toPublicSession(session: InternalSession): SubagentSession {
    return {
      id: session.id,
      parentAgent: session.parentAgent,
      childAgent: session.childAgent,
      provider: session.provider,
      status: session.status,
      history: [...session.history],
      createdAt: session.createdAt,
      iterations: session._iterations,
      toolsUsed: [...new Set(session._toolsUsed)],
      usage: session._usage,
      durationMs:
        session.status === 'running' ? Date.now() - session.startTime : session.durationMs,
      lastResponse: session._lastResponse,
      error: session.error,
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-agent Tools — tools that agents can invoke
// ---------------------------------------------------------------------------

export function createSubagentTools(manager: SubagentManager): Tool[] {
  const spawnTool: Tool = {
    name: 'subagent_spawn',
    description:
      'Spawn a sub-agent to handle a task. Returns immediately with a session ID — ' +
      'the agent runs in the background. Use subagent_status to check progress ' +
      'and collect results.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent ID to spawn (e.g., "grok", "opus", "local")',
        },
        task: {
          type: 'string',
          description: 'Task description for the sub-agent',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default: no timeout — runs until done)',
        },
      },
      required: ['agent', 'task'],
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (args) => {
      try {
        const session = manager.spawn({
          agent: args.agent as string,
          task: args.task as string,
          timeoutMs: args.timeout_ms as number | undefined,
        })

        return JSON.stringify({
          sessionId: session.id,
          agent: session.childAgent,
          status: session.status,
          message: `Sub-agent ${session.childAgent} spawned. Use subagent_status("${session.id}") to check progress.`,
        })
      } catch (err: unknown) {
        return `Error spawning sub-agent: ${(err as Error).message}`
      }
    },
  }

  const statusTool: Tool = {
    name: 'subagent_status',
    description:
      'Check the status and progress of a sub-agent session. ' +
      'Returns elapsed time, iterations, tools used, and the response ' +
      '(partial if still running, final if completed).',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Sub-agent session ID (returned by subagent_spawn)',
        },
      },
      required: ['session_id'],
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (args) => {
      try {
        const status = manager.status(args.session_id as string)

        // Format a human-readable summary with all the details
        const lines: string[] = []
        lines.push(`**Status:** ${status.status}`)
        lines.push(`**Agent:** ${status.agent}`)
        lines.push(`**Elapsed:** ${formatDuration(status.elapsedMs)}`)
        lines.push(`**Iterations:** ${String(status.iterations)}`)
        if (status.toolsUsed.length > 0) {
          lines.push(`**Tools used:** ${status.toolsUsed.join(', ')}`)
        }
        if (status.usage) {
          lines.push(
            `**Tokens:** ${String(status.usage.promptTokens + status.usage.completionTokens)} (${String(status.usage.promptTokens)} prompt + ${String(status.usage.completionTokens)} completion)`,
          )
        }
        if (status.error) {
          lines.push(`**Error:** ${status.error}`)
        }
        if (status.lastResponse) {
          lines.push('')
          lines.push('**Response:**')
          lines.push(status.lastResponse)
        }

        return lines.join('\n')
      } catch (err: unknown) {
        return `Error: ${(err as Error).message}`
      }
    },
  }

  const sendTool: Tool = {
    name: 'subagent_send',
    description:
      'Send a follow-up message to a completed sub-agent session. ' +
      'Starts a new turn in the background — use subagent_status to check results.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Sub-agent session ID (returned by subagent_spawn)',
        },
        message: {
          type: 'string',
          description: 'Message to send to the sub-agent',
        },
      },
      required: ['session_id', 'message'],
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (args) => {
      try {
        manager.send(args.session_id as string, args.message as string)
        return `Follow-up sent. Use subagent_status("${args.session_id as string}") to check progress.`
      } catch (err: unknown) {
        return `Error: ${(err as Error).message}`
      }
    },
  }

  const listTool: Tool = {
    name: 'subagent_list',
    description: 'List all sub-agent sessions (running, completed, and failed).',
    parameters: {
      type: 'object',
      properties: {},
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async () => {
      const sessions = manager.list()
      if (sessions.length === 0) {
        return 'No sub-agent sessions.'
      }
      return JSON.stringify(
        sessions.map((s) => ({
          id: s.id,
          agent: s.childAgent,
          status: s.status,
          elapsed: formatDuration(
            s.status === 'running' ? Date.now() - s.createdAt : (s.durationMs ?? 0),
          ),
          iterations: s.iterations ?? 0,
          messages: s.history.length,
        })),
        null,
        2,
      )
    },
  }

  const killTool: Tool = {
    name: 'subagent_kill',
    description: 'Kill (abort) a running sub-agent session.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Sub-agent session ID to kill',
        },
      },
      required: ['session_id'],
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (args) => {
      try {
        const sessionId = args.session_id as string
        manager.kill(sessionId)
        return `Sub-agent session ${sessionId} killed.`
      } catch (err: unknown) {
        return `Error: ${(err as Error).message}`
      }
    },
  }

  return [spawnTool, statusTool, sendTool, listTool, killTool]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${String(secs)}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = secs % 60
  return `${String(mins)}m ${String(remainingSecs)}s`
}
