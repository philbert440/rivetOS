/**
 * TurnHandler — processes a single message turn.
 *
 * Orchestrates: routing → session → hooks → media → loop → response delivery → memory.
 * The runtime creates a TurnHandler and delegates handleMessage() to it.
 */

import type {
  Channel,
  InboundMessage,
  StreamHandler,
  Tool,
  Memory,
  HookPipeline,
  TurnBeforeContext,
  TurnAfterContext,
  FallbackConfig,
  AgentConfig,
} from '@rivetos/types'
import { join } from 'node:path'
import { SILENT_RESPONSES } from '../domain/constants.js'
import { AgentLoop } from '../domain/loop.js'
import { Router } from '../domain/router.js'
import { WorkspaceLoader } from '../domain/workspace.js'
import { MessageQueue } from '../domain/queue.js'
import { StreamManager } from './streaming.js'
import { SessionManager } from './sessions.js'
import { resolveAttachments, buildHistoryContent } from './media.js'
import { metrics } from './metrics.js'
import { logger } from '../logger.js'

const log = logger('TurnHandler')

// ---------------------------------------------------------------------------
// Dependencies — injected by the Runtime
// ---------------------------------------------------------------------------

export interface TurnHandlerDeps {
  router: Router
  workspace: WorkspaceLoader
  streamManager: StreamManager
  sessionManager: SessionManager
  tools: Tool[]
  memory?: Memory
  hooks?: HookPipeline
  fallbacks?: FallbackConfig[]
  workspaceDir: string
  /** Turn wall-clock timeout in seconds (default: 900) */
  turnTimeout?: number
  /** Context management config */
  contextConfig?: { softNudgePct?: number[]; hardNudgePct?: number }
  /** Abort controller map — shared with runtime for /stop support */
  aborts: Map<string, AbortController>
  /** Active loop map — shared with runtime for /steer support */
  activeLoops: Map<string, AgentLoop>
  /** Stream handler map */
  streamHandlers: Map<string, StreamHandler>
  /** Message queue map */
  queues: Map<string, MessageQueue>
}

// ---------------------------------------------------------------------------
// TurnHandler
// ---------------------------------------------------------------------------

export class TurnHandler {
  private deps: TurnHandlerDeps

  constructor(deps: TurnHandlerDeps) {
    this.deps = deps
  }

  /** Update memory reference (called when memory is registered after construction) */
  setMemory(memory: Memory): void {
    this.deps.memory = memory
  }

  async handle(channel: Channel, message: InboundMessage): Promise<void> {
    const { router, workspace, streamManager, sessionManager } = this.deps
    const sessionKey = `${message.channelId}:${message.userId}`
    const queue = this.deps.queues.get(sessionKey)
    const turnStartTime = Date.now()

    try {
      queue?.beginTurn()

      // Route
      log.debug(`Routing message from ${message.userId}: "${message.text.slice(0, 50)}"`)
      const { agent, provider } = router.route(message)
      log.debug(`Agent: ${agent.id}, Provider: ${provider.id}`)

      // Session
      let session = sessionManager.get(sessionKey)
      if (!session) {
        session = await sessionManager.createSession(sessionKey, agent)
        sessionManager.set(sessionKey, session)
      }

      // System prompt — built once per session, cached
      if (!session.systemPrompt) {
        session.systemPrompt = await workspace.buildSystemPrompt(agent.id, agent.local ?? false)
      }

      // Abort controller
      const abort = new AbortController()
      this.deps.aborts.set(sessionKey, abort)

      // Stream handler
      const streamHandler: StreamHandler = (event) => {
        streamManager.handleStreamEvent(channel, message, session, event)
      }
      this.deps.streamHandlers.set(sessionKey, streamHandler)

      // --- Hook: turn:before ---
      if (this.deps.hooks) {
        const ctx: TurnBeforeContext = {
          event: 'turn:before',
          userMessage: message.text,
          agentId: agent.id,
          sessionId: sessionKey,
          timestamp: Date.now(),
          metadata: {},
        }
        await this.deps.hooks.run(ctx)
        if (ctx.skip) {
          log.debug(`Turn skipped by hook: ${ctx.skipReason ?? 'no reason'}`)
          void queue?.endTurn()
          return
        }
      }

      // Resolve media attachments
      const imageDir = join(this.deps.workspaceDir, '.data', 'images')
      const { userContent, savedImagePaths } = await resolveAttachments(message, channel, imageDir)

      // Create and run agent loop
      const loop = new AgentLoop({
        systemPrompt: session.systemPrompt,
        provider,
        tools: this.deps.tools,
        thinking: session.thinking,
        modelOverride: agent.model,
        onStream: streamHandler,
        agentId: agent.id,
        imageDir,
        hooks: this.deps.hooks,
        sessionId: sessionKey,
        resolveProvider: (id: string) => {
          const providerId = id.includes(':') ? id.split(':')[0] : id
          return router.getProviders().find((p) => p.id === providerId)
        },
        turnTimeout: this.deps.turnTimeout ? this.deps.turnTimeout * 1000 : undefined,
        contextWindow: provider.getContextWindow(),
        contextConfig: this.deps.contextConfig
          ? {
              softNudgePct: this.deps.contextConfig.softNudgePct,
              hardNudgePct: this.deps.contextConfig.hardNudgePct,
            }
          : undefined,
        onCompact: (compactedHistory) => {
          // Sanitize: strip tool-related messages that don't belong in persistent history.
          // The loop's working `messages` array contains intermediate tool_use/tool_result
          // pairs. If saved to session.history, they become orphaned on subsequent turns
          // and cause Anthropic 400 errors ("unexpected tool_use_id in tool_result blocks").
          session.history = compactedHistory
            .filter((m) => m.role !== 'tool')
            .map((m) => {
              if (m.role === 'assistant' && m.toolCalls) {
                const { toolCalls: _tc, ...rest } = m
                return rest
              }
              return m
            })
          session.compactionCount++
          session.nudgesFired = []
        },
      })
      this.deps.activeLoops.set(sessionKey, loop)

      log.debug('Running agent loop...')
      const result = await loop.run(userContent, session.history, abort.signal)
      log.debug(
        `Loop result: aborted=${String(result.aborted)}, response=${result.response.slice(0, 100)}`,
      )

      // --- Hook: turn:after ---
      if (this.deps.hooks) {
        const ctx: TurnAfterContext = {
          event: 'turn:after',
          response: result.response,
          toolsUsed: result.toolsUsed,
          iterations: result.iterations,
          aborted: result.aborted,
          usage: result.usage,
          agentId: agent.id,
          sessionId: sessionKey,
          timestamp: Date.now(),
          metadata: {
            userMessage: message.text,
            hadSteer: result.hadSteer ?? false,
          },
        }
        await this.deps.hooks.run(ctx)
      }

      // Cleanup maps
      this.deps.aborts.delete(sessionKey)
      this.deps.activeLoops.delete(sessionKey)
      this.deps.streamHandlers.delete(sessionKey)

      // Update history
      const historyContent = buildHistoryContent(message.text, savedImagePaths)
      session.history.push({ role: 'user', content: historyContent })
      if (result.response) {
        session.history.push({ role: 'assistant', content: result.response })
      }

      // Clean up streaming state before sending final response
      const { messageId: streamMsgId, overflowIds } = streamManager.cleanup(sessionKey)

      // Send final response
      if (result.response && !result.aborted) {
        const isSilent = SILENT_RESPONSES.some((s) => result.response.trim() === s)
        if (!isSilent) {
          if (streamMsgId && channel.edit) {
            await channel
              .edit(message.channelId, streamMsgId, result.response, overflowIds)
              .catch(() => {})
          } else {
            await channel.send({
              channelId: message.channelId,
              text: result.response,
              replyToMessageId: message.id,
            })
          }
        }
      }

      // Record metrics
      metrics.recordTurn({
        agent: agent.id,
        channel: channel.platform,
        durationMs: Date.now() - turnStartTime,
        toolCalls: result.toolsUsed.length,
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
        timestamp: Date.now(),
      })
      for (const toolName of result.toolsUsed) {
        metrics.recordToolCall(toolName)
      }

      // Append to memory
      await this.appendToMemory(
        channel,
        agent,
        sessionKey,
        historyContent,
        result,
        message,
        savedImagePaths,
      )
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const errorCode = (error as { code?: string }).code ?? 'UNKNOWN'
      metrics.recordError(errorCode)
      log.error(`Error handling message: ${error.message}`, error)
      try {
        await channel.send({
          channelId: message.channelId,
          text: `⚠️ Error: ${(err as Error).message}`,
          replyToMessageId: message.id,
        })
      } catch (sendErr: unknown) {
        log.error(`Failed to send error message: ${(sendErr as Error).message}`)
      }
    } finally {
      void queue?.endTurn()
    }
  }

  private async appendToMemory(
    channel: Channel,
    agent: AgentConfig,
    sessionKey: string,
    historyContent: string,
    result: {
      response: string
      toolsUsed: string[]
      iterations: number
      usage?: { promptTokens: number; completionTokens: number }
    },
    message: InboundMessage,
    savedImagePaths: string[],
  ): Promise<void> {
    if (!this.deps.memory) return

    try {
      await this.deps.memory.append({
        sessionId: sessionKey,
        agent: agent.id,
        channel: channel.platform,
        role: 'user',
        content: historyContent,
        metadata: {
          userId: message.userId,
          username: message.username,
          displayName: message.displayName,
          ...(savedImagePaths.length > 0 ? { images: savedImagePaths } : {}),
        },
      })
      if (result.response) {
        await this.deps.memory.append({
          sessionId: sessionKey,
          agent: agent.id,
          channel: channel.platform,
          role: 'assistant',
          content: result.response,
          metadata: {
            toolsUsed: result.toolsUsed,
            iterations: result.iterations,
            usage: result.usage,
          },
        })
      }
    } catch (err: unknown) {
      log.error(`Memory append failed: ${(err as Error).message}`)
    }
  }
}
