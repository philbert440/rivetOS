/**
 * Runtime — the application layer compositor.
 *
 * Composes domain logic (loop, router, workspace, queue, subagent, skills)
 * with plugins (channels, providers, tools, memory).
 *
 * Delegates to focused modules:
 * - CommandHandler — slash command processing
 * - StreamManager — streaming event → channel delivery
 * - SessionManager — session lifecycle, history, settings
 *
 * Public API is unchanged: registerProvider, registerChannel, registerTool,
 * registerMemory, start, stop.
 */

import type {
  Channel,
  Provider,
  Tool,
  Memory,
  InboundMessage,
  AgentConfig,
  StreamHandler,
  Message,
} from '@rivetos/types';
import { SILENT_RESPONSES } from '../domain/constants.js';
import { AgentLoop } from '../domain/loop.js';
import { Router } from '../domain/router.js';
import { WorkspaceLoader } from '../domain/workspace.js';
import { MessageQueue, isCommand, parseCommand } from '../domain/queue.js';
import { DelegationEngine } from '../domain/delegation.js';
import { createHeartbeatRunner, type HeartbeatRunner } from '../domain/heartbeat.js';
import { SubagentManagerImpl, createSubagentTools } from '../domain/subagent.js';
import { SkillManagerImpl, createSkillListTool } from '../domain/skills.js';
import { CommandHandler } from './commands.js';
import { StreamManager } from './streaming.js';
import { SessionManager } from './sessions.js';
import { logger } from '../logger.js';

const log = logger('Runtime');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  workspaceDir: string;
  defaultAgent: string;
  agents: AgentConfig[];
  maxToolIterations?: number;
  heartbeats?: import('@rivetos/types').HeartbeatConfig[];
  /** Directories to scan for skills (default: ~/.rivetos/skills/) */
  skillDirs?: string[];
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class Runtime {
  private router: Router;
  private workspace: WorkspaceLoader;
  private channels: Map<string, Channel> = new Map();
  private tools: Tool[] = [];
  private memory?: Memory;
  private config: RuntimeConfig;
  private heartbeatRunner?: HeartbeatRunner;

  // Composed modules
  private commandHandler!: CommandHandler;
  private streamManager: StreamManager;
  private sessionManager: SessionManager;

  // Skills
  private skillManager: SkillManagerImpl;

  /** Per-session abort controllers */
  private aborts: Map<string, AbortController> = new Map();

  /** Per-session active agent loops (for /steer) */
  private activeLoops: Map<string, AgentLoop> = new Map();

  /** Per-session message queues */
  private queues: Map<string, MessageQueue> = new Map();

  /** Per-session stream handler (sends events to the right channel) */
  private streamHandlers: Map<string, StreamHandler> = new Map();

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.router = new Router(config.defaultAgent);
    this.workspace = new WorkspaceLoader(config.workspaceDir);
    this.streamManager = new StreamManager();
    this.sessionManager = new SessionManager(this.router);
    this.skillManager = new SkillManagerImpl();

    for (const agent of config.agents) {
      this.router.registerAgent(agent);
    }

    // Wire up command handler with deps
    this.commandHandler = new CommandHandler({
      router: this.router,
      workspace: this.workspace,
      sessionManager: this.sessionManager,
      streamManager: this.streamManager,
      getAbort: (key) => this.aborts.get(key),
      deleteAbort: (key) => { this.aborts.delete(key); },
      getActiveLoop: (key) => this.activeLoops.get(key),
      deleteActiveLoop: (key) => { this.activeLoops.delete(key); },
      getQueue: (key) => this.queues.get(key),
      handleMessage: (ch, msg) => this.handleMessage(ch, msg),
    });
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  registerProvider(provider: Provider): void {
    this.router.registerProvider(provider);
  }

  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);

    channel.onMessage(async (message) => {
      const sessionKey = `${message.channelId}:${message.userId}`;

      // Commands always execute immediately — never queued
      if (isCommand(message.text)) {
        const parsed = parseCommand(message.text);
        if (parsed) {
          await this.commandHandler.handle(channel, parsed.command, parsed.args, message);
          return;
        }
      }

      // Get or create queue for this session
      let queue = this.queues.get(sessionKey);
      if (!queue) {
        queue = new MessageQueue();
        queue.setHandler((msg) => this.handleMessage(channel, msg));
        this.queues.set(sessionKey, queue);
      }

      // If a turn is active, acknowledge the queued message
      if (queue.isProcessing) {
        channel.react?.(message.channelId, message.id, '👀').catch(() => {});
      }

      await queue.enqueue(message);
    });

    channel.onCommand(async (command, args, message) => {
      await this.commandHandler.handle(channel, command, args, message);
    });
  }

  registerTool(tool: Tool): void {
    this.tools.push(tool);
  }

  registerMemory(memory: Memory): void {
    this.memory = memory;
    this.sessionManager.setMemory(memory);
  }

  // -----------------------------------------------------------------------
  // Message Handling
  // -----------------------------------------------------------------------

  private async handleMessage(channel: Channel, message: InboundMessage): Promise<void> {
    const sessionKey = `${message.channelId}:${message.userId}`;
    const queue = this.queues.get(sessionKey);

    try {
      queue?.beginTurn();

      // Route
      log.debug(`Routing message from ${message.userId}: "${message.text.slice(0, 50)}"`);
      const { agent, provider } = this.router.route(message);
      log.debug(`Agent: ${agent.id}, Provider: ${provider.id}`);

      // Get or create session
      let session = this.sessionManager.get(sessionKey);
      if (!session) {
        session = await this.sessionManager.createSession(sessionKey, agent);
        this.sessionManager.set(sessionKey, session);
      }

      // Build system prompt
      let systemPrompt = await this.workspace.buildSystemPrompt(agent.id);

      // Skill matching — prepend SKILL.md if a skill matches
      const matchedSkill = this.skillManager.match(message.text);
      if (matchedSkill) {
        try {
          const skillContent = await this.skillManager.load(matchedSkill.name);
          systemPrompt = `## Active Skill: ${matchedSkill.name}\n${skillContent}\n\n${systemPrompt}`;
          log.debug(`Activated skill: ${matchedSkill.name}`);
        } catch (err: any) {
          log.warn(`Failed to load matched skill "${matchedSkill.name}": ${err.message}`);
        }
      }

      // Enrich with memory context
      if (this.memory) {
        try {
          const memCtx = await this.memory.getContextForTurn(message.text, agent.id);
          if (memCtx) {
            systemPrompt += `\n\n## Transcript Context\n${memCtx}`;
          }
        } catch (err: any) {
          log.warn(`Memory context retrieval failed: ${err.message}`);
        }
      }

      // Create abort controller
      const abort = new AbortController();
      this.aborts.set(sessionKey, abort);

      // Setup stream handler — delegates to StreamManager
      const streamHandler: StreamHandler = (event) => {
        this.streamManager.handleStreamEvent(channel, message, session!, event);
      };
      this.streamHandlers.set(sessionKey, streamHandler);

      // Create and run agent loop
      const loop = new AgentLoop({
        systemPrompt,
        provider,
        tools: this.tools,
        maxIterations: this.config.maxToolIterations,
        thinking: session.thinking,
        onStream: streamHandler,
        agentId: agent.id,
      });
      this.activeLoops.set(sessionKey, loop);

      log.debug('Running agent loop...');
      const result = await loop.run(message.text, session.history, abort.signal);
      log.debug(`Loop result: aborted=${result.aborted}, response=${result.response?.slice(0, 100)}`);

      // Cleanup
      this.aborts.delete(sessionKey);
      this.activeLoops.delete(sessionKey);
      this.streamHandlers.delete(sessionKey);

      // Update history
      session.history.push({ role: 'user', content: message.text });
      if (result.response) {
        session.history.push({ role: 'assistant', content: result.response });
      }
      // Bound history
      if (session.history.length > 200) {
        session.history.splice(0, session.history.length - 200);
      }

      // Clean up streaming state BEFORE sending final response
      const streamMsgId = this.streamManager.getStreamMessageId(sessionKey);
      this.streamManager.cleanupStreamState(sessionKey);

      // Send final response (unless silent or aborted)
      if (result.response && !result.aborted) {
        const isSilent = SILENT_RESPONSES.some((s) => result.response.trim() === s);
        if (!isSilent) {
          if (streamMsgId && channel.edit) {
            await channel.edit(message.channelId, streamMsgId, result.response).catch(() => {});
          } else {
            await channel.send({
              channelId: message.channelId,
              text: result.response,
              replyToMessageId: message.id,
            });
          }
        }
      }

      // Append to memory
      if (this.memory) {
        try {
          await this.memory.append({
            sessionId: sessionKey,
            agent: agent.id,
            channel: channel.platform,
            role: 'user',
            content: message.text,
            metadata: { userId: message.userId, username: message.username, displayName: message.displayName },
          });
          if (result.response) {
            await this.memory.append({
              sessionId: sessionKey,
              agent: agent.id,
              channel: channel.platform,
              role: 'assistant',
              content: result.response,
              metadata: { toolsUsed: result.toolsUsed, iterations: result.iterations, usage: result.usage },
            });
          }
        } catch (err: any) {
          log.error(`Memory append failed: ${err.message}`);
        }
      }
    } catch (err: any) {
      log.error(`Error handling message: ${err.message}`);
      try {
        await channel.send({
          channelId: message.channelId,
          text: `⚠️ Error: ${err.message}`,
          replyToMessageId: message.id,
        });
      } catch (sendErr: any) {
        log.error(`Failed to send error message: ${sendErr.message}`);
      }
    } finally {
      queue?.endTurn();
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    log.info('Starting...');

    // Register delegation tool (agent-to-agent task handoff)
    const delegation = new DelegationEngine({
      router: this.router,
      workspace: this.workspace,
      tools: this.tools,
    });
    this.registerTool(delegation.createDelegationTool());

    // Register sub-agent tools
    const subagentManager = new SubagentManagerImpl({
      router: this.router,
      workspace: this.workspace,
      tools: this.tools,
    });
    for (const tool of createSubagentTools(subagentManager)) {
      this.registerTool(tool);
    }

    // Discover skills
    const defaultSkillDirs = [
      `${process.env.HOME ?? '~'}/.rivetos/skills`,
    ];
    const skillDirs = this.config.skillDirs ?? defaultSkillDirs;
    await this.skillManager.discover(skillDirs);

    // Register skill list tool
    this.registerTool(createSkillListTool(this.skillManager));

    const files = await this.workspace.load();
    log.info(`Workspace: ${files.length} files from ${this.config.workspaceDir}`);

    const health = await this.router.healthCheck();
    for (const [id, ok] of Object.entries(health)) {
      log.info(`Provider ${id}: ${ok ? '✅' : '❌'}`);
    }

    for (const [id, channel] of this.channels) {
      try {
        await channel.start();
        log.info(`Channel ${id} (${channel.platform}): started`);
      } catch (err: any) {
        log.error(`Channel ${id} failed to start: ${err.message}`);
      }
    }

    // Start heartbeats
    if (this.config.heartbeats?.length) {
      this.heartbeatRunner = createHeartbeatRunner(
        this.config.heartbeats,
        async (hbConfig) => {
          const agentConfig = this.router.getAgents().find((a) => a.id === hbConfig.agent);
          if (!agentConfig) {
            log.warn(`Heartbeat agent "${hbConfig.agent}" not found`);
            return;
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
          });

          const systemPrompt = await this.workspace.buildSystemPrompt(hbConfig.agent);
          const loop = new AgentLoop({
            systemPrompt,
            provider,
            tools: this.tools,
            agentId: hbConfig.agent,
          });

          const result = await loop.run(hbConfig.prompt, []);

          if (result.response && hbConfig.outputChannel) {
            const isSilent = SILENT_RESPONSES.some((s) => result.response.trim() === s);
            if (!isSilent) {
              for (const [, ch] of this.channels) {
                await ch.send({ channelId: hbConfig.outputChannel, text: result.response }).catch(() => {});
              }
            }
          }

          if (this.memory) {
            await this.memory.append({
              sessionId: `heartbeat:${hbConfig.agent}`,
              agent: hbConfig.agent,
              channel: 'heartbeat',
              role: 'assistant',
              content: result.response,
            }).catch(() => {});
          }
        },
      );
      this.heartbeatRunner.start();
    }

    log.info('Ready.');
  }

  async stop(): Promise<void> {
    log.info('Stopping...');

    this.heartbeatRunner?.stop();

    for (const [, abort] of this.aborts) {
      abort.abort('Runtime shutdown');
    }
    this.aborts.clear();
    this.activeLoops.clear();

    for (const [id, channel] of this.channels) {
      try {
        await channel.stop();
      } catch (err: any) {
        log.error(`Channel ${id} stop failed: ${err.message}`);
      }
    }

    log.info('Stopped.');
  }
}
