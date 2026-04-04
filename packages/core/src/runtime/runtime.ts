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
  ContentPart,
  HookPipeline,
  TurnBeforeContext,
  TurnAfterContext,
  FallbackConfig,
} from '@rivetos/types';
import { getTextContent } from '@rivetos/types';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  /** Hook pipeline instance (created by boot, shared across runtime) */
  hooks?: HookPipeline;
  /** Provider fallback chains */
  fallbacks?: FallbackConfig[];
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class Runtime {
  private router: Router;
  private workspace: WorkspaceLoader;
  private channels: Map<string, Channel> = new Map();
  private tools: Tool[] = [];

  /** Public access to registered tools (for boot wiring) */
  getTools(): Tool[] { return this.tools; }
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

      // System prompt — built once on session init, reused every turn
      // Memory context is NOT auto-injected — agent uses memory_grep tools
      let systemPrompt = session.systemPrompt;
      if (!systemPrompt) {
        // Local models get extended context (TOOLS.md, MEMORY.md, daily notes)
        // since tokens are free. Cloud APIs get minimal context.
        const isLocal = agent.provider === 'llama-server' || agent.provider === 'ollama' || agent.provider === 'openai-compat';
        systemPrompt = await this.workspace.buildSystemPrompt(agent.id, isLocal);
        session.systemPrompt = systemPrompt;
      }

      // No per-turn skill injection — agent uses skill_list tool to discover
      // and reads SKILL.md via shell when needed
      const turnPrompt = systemPrompt;

      // Create abort controller
      const abort = new AbortController();
      this.aborts.set(sessionKey, abort);

      // Setup stream handler — delegates to StreamManager
      const streamHandler: StreamHandler = (event) => {
        this.streamManager.handleStreamEvent(channel, message, session!, event);
      };
      this.streamHandlers.set(sessionKey, streamHandler);

      // --- Hook: turn:before ---
      if (this.config.hooks) {
        const turnBeforeCtx: TurnBeforeContext = {
          event: 'turn:before',
          userMessage: message.text,
          agentId: agent.id,
          sessionId: sessionKey,
          timestamp: Date.now(),
          metadata: {},
        };
        const turnBeforeResult = await this.config.hooks.run(turnBeforeCtx);
        if (turnBeforeCtx.skip) {
          log.debug(`Turn skipped by hook: ${turnBeforeCtx.skipReason ?? 'no reason'}`);
          queue?.endTurn();
          return;
        }
      }

      // Create and run agent loop
      const loop = new AgentLoop({
        systemPrompt: turnPrompt,
        provider,
        tools: this.tools,
        maxIterations: this.config.maxToolIterations,
        thinking: session.thinking,
        onStream: streamHandler,
        agentId: agent.id,
        imageDir: join(this.config.workspaceDir, '.data', 'images'),
        hooks: this.config.hooks,
        sessionId: sessionKey,
        resolveProvider: (id: string) => {
          // Resolve a provider by ID for fallback chains
          // Supports "provider:model" syntax — returns the provider, model swap happens in the hook
          const providerId = id.includes(':') ? id.split(':')[0] : id;
          return this.router.getProviders().find((p) => p.id === providerId);
        },
      });
      this.activeLoops.set(sessionKey, loop);

      // Build user content — multimodal if attachments present
      let userContent: string | ContentPart[] = message.text;
      const savedImagePaths: string[] = [];

      if (message.attachments?.length && channel.resolveAttachment) {
        const parts: ContentPart[] = [];
        if (message.text) {
          parts.push({ type: 'text', text: message.text });
        }

        for (const attachment of message.attachments) {
          if (attachment.type !== 'photo') continue; // Only images for now

          const resolved = await channel.resolveAttachment(attachment);
          if (!resolved) continue;

          // Save image to disk
          const imageDir = join(this.config.workspaceDir, '.data', 'images');
          await mkdir(imageDir, { recursive: true });
          const ext = (resolved.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
          const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
          const filePath = join(imageDir, fileName);

          if (resolved.data) {
            await writeFile(filePath, Buffer.from(resolved.data, 'base64'));
          } else if (resolved.url) {
            // Download from URL and save
            try {
              const imgRes = await fetch(resolved.url);
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                await writeFile(filePath, buf);
                // Also base64 encode for the LLM
                resolved.data = buf.toString('base64');
              }
            } catch (err: any) {
              log.error(`Failed to download image from ${resolved.url}: ${err.message}`);
            }
          }

          savedImagePaths.push(filePath);

          // Build image part for LLM
          if (resolved.data) {
            parts.push({
              type: 'image',
              data: resolved.data,
              mimeType: resolved.mimeType ?? 'image/jpeg',
            });
          } else if (resolved.url) {
            parts.push({
              type: 'image',
              url: resolved.url,
              mimeType: resolved.mimeType ?? 'image/jpeg',
            });
          }
        }

        if (parts.some((p) => p.type === 'image')) {
          userContent = parts;
        }
      }

      log.debug('Running agent loop...');
      const result = await loop.run(userContent, session.history, abort.signal);
      log.debug(`Loop result: aborted=${result.aborted}, response=${result.response?.slice(0, 100)}`);

      // --- Hook: turn:after ---
      if (this.config.hooks) {
        const turnAfterCtx: TurnAfterContext = {
          event: 'turn:after',
          response: result.response,
          toolsUsed: result.toolsUsed,
          iterations: result.iterations,
          aborted: result.aborted,
          usage: result.usage,
          agentId: agent.id,
          sessionId: sessionKey,
          timestamp: Date.now(),
          metadata: {},
        };
        await this.config.hooks.run(turnAfterCtx);
      }

      // Cleanup
      this.aborts.delete(sessionKey);
      this.activeLoops.delete(sessionKey);
      this.streamHandlers.delete(sessionKey);

      // Update history — store image references (not base64) to avoid bloat
      let historyContent: string = message.text;
      if (savedImagePaths.length > 0) {
        const refs = savedImagePaths.map((p) => `[image:${p}]`).join(' ');
        historyContent = historyContent ? `${historyContent}\n${refs}` : refs;
      }
      session.history.push({ role: 'user', content: historyContent });
      if (result.response) {
        session.history.push({ role: 'assistant', content: result.response });
      }
      // Bound history
      if (session.history.length > 200) {
        session.history.splice(0, session.history.length - 200);
      }

      // Clean up streaming state BEFORE sending final response
      // Cleanup streaming — get the last message ID, all chain IDs, and accumulated text
      const { messageId: streamMsgId, accumulatedText, messageIds: streamMsgIds } = this.streamManager.cleanup(sessionKey);

      // Send final response (unless silent or aborted)
      if (result.response && !result.aborted) {
        const isSilent = SILENT_RESPONSES.some((s) => result.response.trim() === s);
        if (!isSilent) {
          const maxLen = channel.maxMessageLength ?? 2000;

          if (result.response.length <= maxLen && streamMsgId && channel.edit) {
            // Simple case: response fits in one message — edit the streaming message
            await channel.edit(message.channelId, streamMsgId, result.response).catch(() => {});
          } else if (result.response.length > maxLen) {
            // Long response: split into chunks and deliver as a message chain.
            // Edit the last streaming message with the first chunk, send the rest as new messages.
            const chunks = this.splitForPlatform(result.response, maxLen);

            if (streamMsgId && channel.edit) {
              await channel.edit(message.channelId, streamMsgId, chunks[0]).catch(() => {});
            } else {
              await channel.send({
                channelId: message.channelId,
                text: chunks[0],
                replyToMessageId: message.id,
              });
            }

            for (let i = 1; i < chunks.length; i++) {
              await channel.send({
                channelId: message.channelId,
                text: chunks[i],
              });
            }
          } else {
            // No streaming message to edit — send normally
            await channel.send({
              channelId: message.channelId,
              text: result.response,
              replyToMessageId: message.id,
            });
          }
        }
      }

      // Append to memory (with image references, not base64)
      if (this.memory) {
        try {
          await this.memory.append({
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
  // Message Splitting
  // -----------------------------------------------------------------------

  /** Split text at paragraph/line/sentence boundaries to fit platform limits */
  private splitForPlatform(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try paragraph break first
      let splitAt = remaining.lastIndexOf('\n\n', maxLength);
      // Then single newline
      if (splitAt === -1 || splitAt < maxLength * 0.3) {
        splitAt = remaining.lastIndexOf('\n', maxLength);
      }
      // Then sentence end
      if (splitAt === -1 || splitAt < maxLength * 0.3) {
        splitAt = remaining.lastIndexOf('. ', maxLength);
        if (splitAt > 0) splitAt += 1; // Include the period
      }
      // Hard cut as last resort
      if (splitAt === -1 || splitAt < maxLength * 0.3) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
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
      hooks: this.config.hooks,
    });
    this.registerTool(delegation.createDelegationTool());

    // Register sub-agent tools
    const subagentManager = new SubagentManagerImpl({
      router: this.router,
      workspace: this.workspace,
      tools: this.tools,
      hooks: this.config.hooks,
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

          const systemPrompt = await this.workspace.buildHeartbeatPrompt(hbConfig.agent);
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
