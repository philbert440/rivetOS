/**
 * Runtime — the application layer compositor.
 *
 * Thin orchestrator that:
 * - Registers providers, channels, tools, memory (via boot)
 * - Owns the message routing pipeline (channel → queue → turn handler)
 * - Manages lifecycle (start/stop)
 *
 * All heavy lifting is delegated to focused modules:
 * - TurnHandler  — processes a single message turn
 * - CommandHandler — slash command processing
 * - StreamManager — streaming event → channel delivery
 * - SessionManager — session lifecycle, history, settings
 * - Media         — attachment resolution and multimodal content
 */

import type {
  Channel,
  Provider,
  Tool,
  Memory,
  AgentConfig,
  StreamHandler,
  HookPipeline,
  FallbackConfig,
} from '@rivetos/types'
import { SILENT_RESPONSES } from '../domain/constants.js'
import { AgentLoop } from '../domain/loop.js'
import { Router } from '../domain/router.js'
import { WorkspaceLoader } from '../domain/workspace.js'
import { MessageQueue, isCommand, parseCommand } from '../domain/queue.js'
import { createHeartbeatRunner, type HeartbeatRunner } from '../domain/heartbeat.js'
import { CommandHandler } from './commands.js'
import { StreamManager } from './streaming.js'
import { SessionManager } from './sessions.js'
import { TurnHandler } from './turn-handler.js'
import { HealthServer } from './health.js'
import { ReconnectionManager } from '../domain/reconnect.js'
import { logger } from '../logger.js'

const log = logger('Runtime')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  workspaceDir: string
  defaultAgent: string
  agents: AgentConfig[]
  /** Turn wall-clock timeout in seconds (default: 900) */
  turnTimeout?: number
  /** Context management config */
  contextConfig?: { softNudgePct?: number[]; hardNudgePct?: number }
  heartbeats?: import('@rivetos/types').HeartbeatConfig[]
  /** Directories to scan for skills (default: ~/.rivetos/skills/) */
  skillDirs?: string[]
  /** Hook pipeline instance (created by boot, shared across runtime) */
  hooks?: HookPipeline
  /** Provider fallback chains */
  fallbacks?: FallbackConfig[]
  /** Path to config.yaml (for persistent /model changes) */
  configPath?: string
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class Runtime {
  private router: Router
  private workspace: WorkspaceLoader
  private channels: Map<string, Channel> = new Map()
  private channelConnected: Map<string, boolean> = new Map()
  private tools: Tool[] = []
  private memory?: Memory
  private memoryConnected = false
  private config: RuntimeConfig
  private heartbeatRunner?: HeartbeatRunner
  private healthServer?: HealthServer
  private reconnectionManager: ReconnectionManager

  // Composed modules
  private commandHandler!: CommandHandler
  private streamManager: StreamManager
  private sessionManager: SessionManager
  private turnHandler!: TurnHandler

  // Shared state maps (runtime owns, turn handler references)
  private aborts: Map<string, AbortController> = new Map()
  private activeLoops: Map<string, AgentLoop> = new Map()
  private queues: Map<string, MessageQueue> = new Map()
  private streamHandlers: Map<string, StreamHandler> = new Map()

  constructor(config: RuntimeConfig) {
    this.config = config
    this.router = new Router(config.defaultAgent)
    this.workspace = new WorkspaceLoader(config.workspaceDir)
    this.streamManager = new StreamManager()
    this.sessionManager = new SessionManager(this.router)
    this.reconnectionManager = new ReconnectionManager({
      onReconnect: (channelId) => {
        this.channelConnected.set(channelId, true)
      },
      onGiveUp: (channelId, error) => {
        log.error(`Channel ${channelId} reconnection failed`, error)
        this.channelConnected.set(channelId, false)
      },
    })

    for (const agent of config.agents) {
      this.router.registerAgent(agent)
    }

    // Wire turn handler
    this.turnHandler = new TurnHandler({
      router: this.router,
      workspace: this.workspace,
      streamManager: this.streamManager,
      sessionManager: this.sessionManager,
      tools: this.tools,
      memory: this.memory,
      hooks: config.hooks,
      fallbacks: config.fallbacks,
      workspaceDir: config.workspaceDir,
      turnTimeout: config.turnTimeout,
      contextConfig: config.contextConfig,
      aborts: this.aborts,
      activeLoops: this.activeLoops,
      streamHandlers: this.streamHandlers,
      queues: this.queues,
    })

    // Wire command handler
    this.commandHandler = new CommandHandler({
      router: this.router,
      workspace: this.workspace,
      sessionManager: this.sessionManager,
      streamManager: this.streamManager,
      getAbort: (key) => this.aborts.get(key),
      deleteAbort: (key) => {
        this.aborts.delete(key)
      },
      getActiveLoop: (key) => this.activeLoops.get(key),
      deleteActiveLoop: (key) => {
        this.activeLoops.delete(key)
      },
      getQueue: (key) => this.queues.get(key),
      handleMessage: (ch, msg) => this.turnHandler.handle(ch, msg),
      getTools: () => this.tools,
      configPath: config.configPath,
    })
  }

  // -----------------------------------------------------------------------
  // Accessors — for boot registrars that need internal wiring
  // -----------------------------------------------------------------------

  getRouter(): Router {
    return this.router
  }
  getWorkspace(): WorkspaceLoader {
    return this.workspace
  }
  getHooks(): HookPipeline | undefined {
    return this.config.hooks
  }
  getTools(): Tool[] {
    return this.tools
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  registerProvider(provider: Provider): void {
    this.router.registerProvider(provider)
  }

  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel)

    channel.onMessage(async (message) => {
      const sessionKey = `${message.channelId}:${message.userId}`

      // Commands always execute immediately — never queued
      if (isCommand(message.text)) {
        const parsed = parseCommand(message.text)
        if (parsed) {
          await this.commandHandler.handle(channel, parsed.command, parsed.args, message)
          return
        }
      }

      // Get or create queue for this session
      let queue = this.queues.get(sessionKey)
      if (!queue) {
        queue = new MessageQueue()
        queue.setHandler((msg) => this.turnHandler.handle(channel, msg))
        this.queues.set(sessionKey, queue)
      }

      // If a turn is active, acknowledge the queued message
      if (queue.isProcessing) {
        channel.react?.(message.channelId, message.id, '👀').catch(() => {}) // fire-and-forget — reaction is non-critical
      }

      await queue.enqueue(message)
    })

    channel.onCommand(async (command, args, message) => {
      await this.commandHandler.handle(channel, command, args, message)
    })
  }

  registerTool(tool: Tool): void {
    this.tools.push(tool)
  }

  registerMemory(memory: Memory): void {
    this.memory = memory
    this.memoryConnected = true
    this.sessionManager.setMemory(memory)
    // Update the turn handler's reference
    this.turnHandler.setMemory(memory)
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    log.info('Starting...')

    const files = await this.workspace.load()
    log.info(`Workspace: ${files.length} files from ${this.config.workspaceDir}`)

    const health = await this.router.healthCheck()
    for (const [id, ok] of Object.entries(health)) {
      log.info(`Provider ${id}: ${ok ? '✅' : '❌'}`)
    }

    for (const [id, channel] of this.channels) {
      try {
        await channel.start()
        this.channelConnected.set(id, true)
        log.info(`Channel ${id} (${channel.platform}): started`)
      } catch (err: unknown) {
        this.channelConnected.set(id, false)
        log.error(`Channel ${id} failed to start: ${(err as Error).message}`)
        // Start reconnection in background
        void this.reconnectionManager.reconnect(id, () => channel.start())
      }
    }

    // Start health endpoint
    this.healthServer = new HealthServer({
      getAgents: () => this.router.getAgents().map((a) => a.id),
      checkProviders: async () => {
        const health = await this.router.healthCheck()
        return health
      },
      getChannelStatus: () => {
        const status: Record<string, boolean> = {}
        for (const [id] of this.channels) {
          status[id] = this.channelConnected.get(id) ?? false
        }
        return status
      },
      getMemoryStatus: () => this.memoryConnected,
    })
    await this.healthServer.start()

    // Start heartbeats
    if (this.config.heartbeats?.length) {
      this.heartbeatRunner = createHeartbeatRunner(this.config.heartbeats, async (hbConfig) => {
        const agentConfig = this.router.getAgents().find((a) => a.id === hbConfig.agent)
        if (!agentConfig) {
          log.warn(`Heartbeat agent "${hbConfig.agent}" not found`)
          return
        }

        const { provider } = this.router.route({
          id: 'heartbeat',
          userId: 'system:heartbeat',
          channelId: 'heartbeat',
          chatType: 'system',
          text: hbConfig.prompt,
          platform: 'heartbeat',
          agent: hbConfig.agent,
          timestamp: Math.floor(Date.now() / 1000),
        })

        const systemPrompt = await this.workspace.buildHeartbeatPrompt(hbConfig.agent)
        const loop = new AgentLoop({
          systemPrompt,
          provider,
          tools: this.tools,
          agentId: hbConfig.agent,
          workspaceDir: this.config.workspaceDir,
          freshConversation: true,
          turnTimeout: this.config.turnTimeout ? this.config.turnTimeout * 1000 : undefined,
          contextWindow: provider.getContextWindow(),
          contextConfig: this.config.contextConfig,
        })

        const result = await loop.run(hbConfig.prompt, [])

        if (result.response && hbConfig.outputChannel) {
          const isSilent = SILENT_RESPONSES.some((s) => result.response.trim() === s)
          if (!isSilent) {
            for (const [, ch] of this.channels) {
              await ch
                .send({ channelId: hbConfig.outputChannel, text: result.response })
                .catch(() => {}) // fire-and-forget — heartbeat delivery is best-effort
            }
          }
        }

        // Heartbeat responses are deliberately not persisted. They were polluting
        // getContextForTurn() "Recent" section and causing agents to believe they
        // were still in heartbeat mode during real user conversations.
      })
      this.heartbeatRunner.start()
    }

    log.info('Ready.')
  }

  async stop(): Promise<void> {
    log.info('Stopping...')

    this.heartbeatRunner?.stop()
    this.reconnectionManager.cancelAll()
    await this.healthServer?.stop()

    for (const [, abort] of this.aborts) {
      abort.abort('Runtime shutdown')
    }
    this.aborts.clear()
    this.activeLoops.clear()

    for (const [id, channel] of this.channels) {
      try {
        await channel.stop()
      } catch (err: unknown) {
        log.error(`Channel ${id} stop failed: ${(err as Error).message}`)
      }
    }

    log.info('Stopped.')
  }
}
