/**
 * Sub-agent Manager — orchestrates child agent sessions.
 *
 * Supports two modes:
 * - 'run': one-shot delegation. Spawns a child AgentLoop, waits for
 *   completion, returns the result. Session is cleaned up automatically.
 * - 'session': persistent interactive session. Spawns a child AgentLoop
 *   for the initial task, keeps the session alive for follow-up messages
 *   via send().
 *
 * Pure domain logic. Depends only on interfaces from @rivetos/types
 * plus the internal Router and WorkspaceLoader.
 */

import { randomUUID } from 'node:crypto'
import type {
  SubagentSession,
  SubagentSpawnRequest,
  SubagentManager,
  Tool,
  Provider,
  AgentToolFilter,
} from '@rivetos/types'
import { getTextContent } from '@rivetos/types'
import { AgentLoop } from './loop.js'
import type { Router } from './router.js'
import type { WorkspaceLoader } from './workspace.js'
import { filterToolsForAgent } from './delegation.js'
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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Result from a single turn within a sub-agent */
interface TurnMeta {
  response: string
  iterations: number
  toolsUsed: string[]
  usage?: { promptTokens: number; completionTokens: number }
}

/** Internal session state — extends the public SubagentSession with private fields */
interface InternalSession extends SubagentSession {
  abort: AbortController
  /** Promise that resolves when a 'run' mode session completes */
  completion?: Promise<string>
  /** Model override from agent config — allows agents on the same provider to use different models */
  modelOverride?: string
}

export class SubagentManagerImpl implements SubagentManager {
  private config: SubagentManagerConfig
  private sessions: Map<string, InternalSession> = new Map()

  constructor(config: SubagentManagerConfig) {
    this.config = config
  }

  async spawn(request: SubagentSpawnRequest): Promise<SubagentSession> {
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

    // Build system prompt for the child
    const systemPrompt = await workspace.buildSystemPrompt(agent.id)
    const enrichedPrompt =
      systemPrompt +
      '\n\n## Sub-agent Context\n' +
      `You are running as a sub-agent. Mode: ${request.mode}.\n` +
      `Complete your assigned task thoroughly.`

    const sessionId = randomUUID()
    const abort = new AbortController()

    // Apply timeout if specified
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (request.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        abort.abort(`Sub-agent timeout after ${request.timeoutMs}ms`)
      }, request.timeoutMs)
    }

    const session: InternalSession = {
      id: sessionId,
      parentAgent: 'parent', // Will be set by the tool's context
      childAgent: request.agent,
      provider: agent.provider,
      status: 'running',
      history: [],
      createdAt: Date.now(),
      abort,
      modelOverride: agent.model,
    }

    this.sessions.set(sessionId, session)

    // Resolve and filter tools for this agent
    const tools = filterToolsForAgent(this.config.tools(), request.agent, this.config.toolFilter)

    const startTime = Date.now()

    if (request.mode === 'run') {
      // One-shot: run the task, wait for completion, return result
      const completion = this.runOneShot(
        session,
        enrichedPrompt,
        provider,
        tools,
        request.task,
        abort,
        timeoutHandle,
      )
      session.completion = completion

      try {
        const response = await completion
        session.status = 'completed'
        session.durationMs = Date.now() - startTime
        session.history.push(
          { role: 'user', content: request.task },
          { role: 'assistant', content: response },
        )
        return this.toPublicSession(session)
      } catch (err: unknown) {
        session.status = 'failed'
        session.durationMs = Date.now() - startTime
        log.error(`Sub-agent ${sessionId} failed: ${(err as Error).message}`)
        throw err
      }
    } else {
      // Session mode: run initial task, keep session alive for follow-ups
      try {
        const meta = await this.runTurn(
          session,
          enrichedPrompt,
          provider,
          tools,
          request.task,
          abort.signal,
        )
        session.iterations = meta.iterations
        session.toolsUsed = meta.toolsUsed
        session.usage = meta.usage
        session.durationMs = Date.now() - startTime
        session.history.push(
          { role: 'user', content: request.task },
          { role: 'assistant', content: meta.response },
        )
        // Keep session alive — don't mark completed
        if (timeoutHandle) clearTimeout(timeoutHandle)
        return this.toPublicSession(session)
      } catch (err: unknown) {
        session.status = 'failed'
        session.durationMs = Date.now() - startTime
        if (timeoutHandle) clearTimeout(timeoutHandle)
        log.error(`Sub-agent ${sessionId} failed on initial turn: ${(err as Error).message}`)
        throw err
      }
    }
  }

  async send(sessionId: string, message: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`)
    }
    if (session.status !== 'running' && session.status !== 'yielded') {
      throw new Error(`Sub-agent session ${sessionId} is ${session.status} — cannot send messages`)
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

    const systemPrompt = await workspace.buildSystemPrompt(agent.id)
    const enrichedPrompt =
      systemPrompt +
      '\n\n## Sub-agent Context\n' +
      'You are running as a persistent sub-agent session. Continue the conversation.'

    // Resolve and filter tools for this agent
    const tools = filterToolsForAgent(
      this.config.tools(),
      session.childAgent,
      this.config.toolFilter,
    )

    session.status = 'running'
    const sendStart = Date.now()

    try {
      const meta = await this.runTurn(
        session,
        enrichedPrompt,
        provider,
        tools,
        message,
        session.abort.signal,
      )
      session.iterations = meta.iterations
      session.toolsUsed = meta.toolsUsed
      session.usage = meta.usage
      session.durationMs = Date.now() - sendStart
      session.history.push(
        { role: 'user', content: message },
        { role: 'assistant', content: meta.response },
      )
      return meta.response
    } catch (err: unknown) {
      session.status = 'failed'
      throw err
    }
  }

  yield(sessionId: string, message?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`)
    }
    session.status = 'yielded'
    if (message) {
      log.info(`Sub-agent ${sessionId} yielded with message: ${message.slice(0, 100)}`)
    }
  }

  list(): SubagentSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.status === 'running' || s.status === 'yielded')
      .map((s) => this.toPublicSession(s))
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`)
    }
    session.abort.abort('Killed by parent')
    session.status = 'failed'
    this.sessions.delete(sessionId)
    log.info(`Sub-agent ${sessionId} killed`)
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async runOneShot(
    session: InternalSession,
    systemPrompt: string,
    provider: Provider,
    tools: Tool[],
    task: string,
    abort: AbortController,
    timeoutHandle?: ReturnType<typeof setTimeout>,
  ): Promise<string> {
    try {
      const meta = await this.runTurn(session, systemPrompt, provider, tools, task, abort.signal)
      session.iterations = meta.iterations
      session.toolsUsed = meta.toolsUsed
      session.usage = meta.usage
      return meta.response
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      this.sessions.delete(session.id)
    }
  }

  private async runTurn(
    session: InternalSession,
    systemPrompt: string,
    provider: Provider,
    tools: Tool[],
    userMessage: string,
    signal: AbortSignal,
  ): Promise<TurnMeta> {
    const loop = new AgentLoop({
      systemPrompt,
      provider,
      tools,
      modelOverride: session.modelOverride,
      agentId: session.childAgent,
    })

    const result = await loop.run(userMessage, session.history, signal)

    if (result.aborted) {
      throw new Error('Sub-agent was aborted')
    }

    return {
      response: result.response,
      iterations: result.iterations,
      toolsUsed: result.toolsUsed,
      usage: result.usage,
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
      iterations: session.iterations,
      toolsUsed: session.toolsUsed,
      usage: session.usage,
      durationMs: session.durationMs,
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
      'Spawn a sub-agent to handle a task. Use mode "run" for one-shot tasks ' +
      '(returns the result directly) or "session" for interactive multi-turn ' +
      'conversations with the sub-agent.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent ID to spawn (e.g., "grok", "opus", "local")',
        },
        task: {
          type: 'string',
          description: 'Task description or initial message for the sub-agent',
        },
        mode: {
          type: 'string',
          enum: ['run', 'session'],
          description:
            '"run" = one-shot (returns result), "session" = persistent (stays alive for follow-ups)',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default: none)',
        },
      },
      required: ['agent', 'task', 'mode'],
    },

    execute: async (args, _signal, _context) => {
      try {
        const session = await manager.spawn({
          agent: args.agent as string,
          task: args.task as string,
          mode: args.mode as 'run' | 'session',
          timeoutMs: args.timeout_ms as number | undefined,
        })

        if (args.mode === 'run') {
          // One-shot: return the last assistant message with metadata footer
          const lastMsg = session.history.find((m) => m.role === 'assistant')
          const response = lastMsg
            ? getTextContent(lastMsg.content)
            : '[No response from sub-agent]'

          const meta: string[] = []
          if (session.durationMs != null) meta.push(`${String(session.durationMs)}ms`)
          if (session.toolsUsed?.length)
            meta.push(`tools: ${[...new Set(session.toolsUsed)].join(', ')}`)
          if (session.usage)
            meta.push(
              `tokens: ${String(session.usage.promptTokens + session.usage.completionTokens)}`,
            )
          if (session.iterations != null) meta.push(`iterations: ${String(session.iterations)}`)
          const metaLine = meta.length
            ? `\n\n---\n_Sub-agent [${session.status}]: ${meta.join(' | ')}_`
            : ''

          return response + metaLine
        } else {
          // Session mode: return session ID + initial response
          const lastMsg = session.history.find((m) => m.role === 'assistant')
          return JSON.stringify({
            sessionId: session.id,
            agent: session.childAgent,
            status: session.status,
            response: lastMsg ? getTextContent(lastMsg.content) : '[No initial response]',
          })
        }
      } catch (err: unknown) {
        return `Error spawning sub-agent: ${(err as Error).message}`
      }
    },
  }

  const sendTool: Tool = {
    name: 'subagent_send',
    description:
      'Send a message to a persistent sub-agent session. ' +
      'Only works with sessions spawned in "session" mode.',
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

    execute: async (args) => {
      try {
        const response = await manager.send(args.session_id as string, args.message as string)
        return response
      } catch (err: unknown) {
        return `Error: ${(err as Error).message}`
      }
    },
  }

  const listTool: Tool = {
    name: 'subagent_list',
    description: 'List all active sub-agent sessions.',
    parameters: {
      type: 'object',
      properties: {},
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async () => {
      const sessions = manager.list()
      if (sessions.length === 0) {
        return 'No active sub-agent sessions.'
      }
      return JSON.stringify(
        sessions.map((s) => ({
          id: s.id,
          agent: s.childAgent,
          status: s.status,
          messages: s.history.length,
          createdAt: new Date(s.createdAt).toISOString(),
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

  return [spawnTool, sendTool, listTool, killTool]
}
