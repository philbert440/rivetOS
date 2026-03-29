/**
 * Runtime — the application layer.
 *
 * Composes domain logic (loop, router, workspace, queue) with plugins
 * (channels, providers, tools, memory). This is the only layer that
 * knows concrete types and wires everything together.
 */

import type {
  Channel,
  Provider,
  Tool,
  Memory,
  InboundMessage,
  AgentConfig,
  StreamHandler,
  StreamEvent,
  SessionState,
  ThinkingLevel,
  Message,
} from '@rivetos/types';
import { SILENT_RESPONSES } from './domain/constants.js';
import { AgentLoop } from './domain/loop.js';
import { Router } from './domain/router.js';
import { WorkspaceLoader } from './domain/workspace.js';
import { MessageQueue, isCommand, parseCommand } from './domain/queue.js';
import { DelegationEngine } from './domain/delegation.js';
import { logger } from './logger.js';

const log = logger('Runtime');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  workspaceDir: string;
  defaultAgent: string;
  agents: AgentConfig[];
  maxToolIterations?: number;
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

  /** Per-session state */
  private sessions: Map<string, SessionState> = new Map();

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

    for (const agent of config.agents) {
      this.router.registerAgent(agent);
    }
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
          await this.handleCommand(channel, parsed.command, parsed.args, message);
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
      await this.handleCommand(channel, command, args, message);
    });
  }

  registerTool(tool: Tool): void {
    this.tools.push(tool);
  }

  registerMemory(memory: Memory): void {
    this.memory = memory;
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
      let session = this.sessions.get(sessionKey);
      if (!session) {
        session = await this.createSession(sessionKey, agent);
        this.sessions.set(sessionKey, session);
      }

      // Build system prompt
      const systemPrompt = await this.workspace.buildSystemPrompt(agent.id);

      // Enrich with memory context
      let enrichedPrompt = systemPrompt;
      if (this.memory) {
        try {
          const memCtx = await this.memory.getContextForTurn(message.text, agent.id);
          if (memCtx) {
            enrichedPrompt += `\n\n## Transcript Context\n${memCtx}`;
          }
        } catch (err: any) {
          log.warn(`Memory context retrieval failed: ${err.message}`);
        }
      }

      // Create abort controller
      const abort = new AbortController();
      this.aborts.set(sessionKey, abort);

      // Setup stream handler — sends events to the channel
      const streamHandler: StreamHandler = (event) => {
        this.handleStreamEvent(channel, message, session!, event);
      };
      this.streamHandlers.set(sessionKey, streamHandler);

      // Create and run agent loop
      const loop = new AgentLoop({
        systemPrompt: enrichedPrompt,
        provider,
        tools: this.tools,
        maxIterations: this.config.maxToolIterations,
        thinking: session.thinking,
        onStream: streamHandler,
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

      // Send final response (unless silent or aborted)
      if (result.response && !result.aborted) {
        const isSilent = SILENT_RESPONSES.some((s) => result.response.trim() === s);
        if (!isSilent) {
          // If we were streaming and have an existing message, edit it with the final text
          const streamMsgId = this.streamingMessages.get(sessionKey);
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

      // Clean up streaming state
      this.cleanupStreamState(sessionKey);

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
  // Stream Events → Channel
  // -----------------------------------------------------------------------

  /** Active streaming message IDs — for editing messages in-place */
  private streamingMessages: Map<string, string> = new Map();
  /** Buffered text for streaming updates */
  private streamBuffers: Map<string, string> = new Map();
  /** Throttle timer for streaming edits */
  private streamTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Buffered reasoning for batched send */
  private reasoningBuffers: Map<string, string> = new Map();
  private reasoningTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Consolidated tool call log — single message updated in-place */
  private toolLogMessages: Map<string, string> = new Map(); // sessionKey → messageId
  private toolLogContent: Map<string, string[]> = new Map(); // sessionKey → log lines

  private handleStreamEvent(
    channel: Channel,
    message: InboundMessage,
    session: SessionState,
    event: StreamEvent,
  ): void {
    const sessionKey = `${message.channelId}:${message.userId}`;

    switch (event.type) {
      case 'text': {
        // Buffer text and throttle edits (every 500ms)
        const current = this.streamBuffers.get(sessionKey) ?? '';
        this.streamBuffers.set(sessionKey, current + (event.content ?? ''));

        if (!this.streamTimers.has(sessionKey)) {
          this.streamTimers.set(sessionKey, setTimeout(async () => {
            this.streamTimers.delete(sessionKey);
            const text = this.streamBuffers.get(sessionKey) ?? '';
            if (!text) return;

            const msgId = this.streamingMessages.get(sessionKey);
            if (msgId && channel.edit) {
              // Edit existing message with accumulated text
              await channel.edit(message.channelId, msgId, text).catch(() => {});
            } else if (!msgId) {
              // Send first chunk as a new message
              const sentId = await channel.send({
                channelId: message.channelId,
                text: text.slice(0, 200) + '…',
                replyToMessageId: message.id,
              });
              if (sentId) {
                this.streamingMessages.set(sessionKey, sentId);
              }
            }
          }, 500));
        }
        break;
      }

      case 'reasoning': {
        if (!session.reasoningVisible) return;
        // Buffer reasoning chunks and send batched (every 2 seconds)
        const rKey = sessionKey;
        const current = this.reasoningBuffers.get(rKey) ?? '';
        this.reasoningBuffers.set(rKey, current + (event.content ?? ''));

        if (!this.reasoningTimers.has(rKey)) {
          this.reasoningTimers.set(rKey, setTimeout(async () => {
            this.reasoningTimers.delete(rKey);
            const buffered = this.reasoningBuffers.get(rKey) ?? '';
            this.reasoningBuffers.delete(rKey);
            if (buffered) {
              // Truncate to reasonable length for Telegram
              const display = buffered.length > 2000 ? buffered.slice(0, 2000) + '…' : buffered;
              channel.send({
                channelId: message.channelId,
                text: `🧠 ${display}`,
                silent: true,
              }).catch(() => {});
            }
          }, 2000));
        }
        break;
      }

      case 'tool_start': {
        if (!session.toolsVisible) return;
        // Append to consolidated tool log
        const startLines = this.toolLogContent.get(sessionKey) ?? [];
        startLines.push(event.content);
        this.toolLogContent.set(sessionKey, startLines);
        this.updateToolLog(channel, message.channelId, sessionKey);
        break;
      }

      case 'tool_result': {
        if (!session.toolsVisible) return;
        // Update the last line with the result
        const resultLines = this.toolLogContent.get(sessionKey) ?? [];
        if (resultLines.length > 0) {
          resultLines[resultLines.length - 1] = event.content;
        } else {
          resultLines.push(event.content);
        }
        this.toolLogContent.set(sessionKey, resultLines);
        this.updateToolLog(channel, message.channelId, sessionKey);
        break;
      }

      case 'status': {
        channel.send({
          channelId: message.channelId,
          text: event.content,
          silent: true,
        }).catch(() => {});
        break;
      }

      case 'error': {
        channel.send({
          channelId: message.channelId,
          text: `⚠️ ${event.content}`,
        }).catch(() => {});
        break;
      }
    }
  }

  /**
   * Update the consolidated tool log message (single message, edited in-place).
   */
  private async updateToolLog(channel: Channel, channelId: string, sessionKey: string): Promise<void> {
    const lines = this.toolLogContent.get(sessionKey) ?? [];
    // Keep last 10 lines to avoid message getting too long
    const display = lines.slice(-10).join('\n');
    const msgId = this.toolLogMessages.get(sessionKey);

    if (msgId && channel.edit) {
      await channel.edit(channelId, msgId, display).catch(() => {});
    } else {
      const sentId = await channel.send({
        channelId,
        text: display,
        silent: true,
      });
      if (sentId) {
        this.toolLogMessages.set(sessionKey, sentId);
      }
    }
  }

  /**
   * Clean up streaming state after a turn completes.
   */
  private cleanupStreamState(sessionKey: string): void {
    this.streamingMessages.delete(sessionKey);
    this.streamBuffers.delete(sessionKey);
    const timer = this.streamTimers.get(sessionKey);
    if (timer) { clearTimeout(timer); this.streamTimers.delete(sessionKey); }
    // Flush any remaining reasoning buffer
    const rTimer = this.reasoningTimers.get(sessionKey);
    if (rTimer) { clearTimeout(rTimer); this.reasoningTimers.delete(sessionKey); }
    this.reasoningBuffers.delete(sessionKey);
    // Clean up tool log
    this.toolLogMessages.delete(sessionKey);
    this.toolLogContent.delete(sessionKey);
  }

  // -----------------------------------------------------------------------
  // Command Handling
  // -----------------------------------------------------------------------

  private async handleCommand(
    channel: Channel,
    command: string,
    args: string,
    message: InboundMessage,
  ): Promise<void> {
    const sessionKey = `${message.channelId}:${message.userId}`;

    switch (command) {
      case 'stop': {
        const abort = this.aborts.get(sessionKey);
        if (abort) {
          abort.abort('User requested stop');
          this.aborts.delete(sessionKey);
          this.activeLoops.delete(sessionKey);
          this.queues.get(sessionKey)?.clear();
          await channel.send({ channelId: message.channelId, text: '⛔ Stopped.' });
        } else {
          await channel.send({ channelId: message.channelId, text: '💤 Nothing running.' });
        }
        break;
      }

      case 'interrupt': {
        const abort = this.aborts.get(sessionKey);
        if (abort) {
          abort.abort('User interrupted');
          this.aborts.delete(sessionKey);
          this.activeLoops.delete(sessionKey);
          this.queues.get(sessionKey)?.clear();
        }
        // Keep history, start new turn with the interrupt message
        if (args.trim()) {
          const queue = this.queues.get(sessionKey);
          if (queue) {
            await queue.enqueue({ ...message, text: args });
          } else {
            await this.handleMessage(channel, { ...message, text: args });
          }
        } else {
          await channel.send({ channelId: message.channelId, text: '⚡ Interrupted. Send your next message.' });
        }
        break;
      }

      case 'steer': {
        if (!args.trim()) {
          await channel.send({ channelId: message.channelId, text: '⚠️ Usage: /steer <message>' });
          break;
        }
        const loop = this.activeLoops.get(sessionKey);
        if (loop) {
          loop.steer(args);
          await channel.send({ channelId: message.channelId, text: '📨 Injected into current turn.' });
        } else {
          await channel.send({ channelId: message.channelId, text: '💤 No active turn. Just send a message.' });
        }
        break;
      }

      case 'new': {
        const abort = this.aborts.get(sessionKey);
        if (abort) {
          abort.abort('New session');
          this.aborts.delete(sessionKey);
          this.activeLoops.delete(sessionKey);
        }
        this.sessions.delete(sessionKey);
        this.queues.get(sessionKey)?.clear();
        this.workspace.clearCache();
        await channel.send({ channelId: message.channelId, text: '🔄 Fresh session. Workspace reloaded.' });
        break;
      }

      case 'status': {
        const session = this.sessions.get(sessionKey);
        const agents = this.router.getAgents();
        const health = await this.router.healthCheck();
        const isRunning = this.aborts.has(sessionKey);
        const queueDepth = this.queues.get(sessionKey)?.depth ?? 0;

        const lines = [
          '🤖 **RivetOS Status**',
          `Agents: ${agents.map((a) => `${a.id} (${a.provider})`).join(', ')}`,
          `Providers: ${Object.entries(health).map(([id, ok]) => `${id}: ${ok ? '✅' : '❌'}`).join(', ')}`,
          `State: ${isRunning ? '⚙️ Processing' : '💤 Idle'}`,
          `Queue: ${queueDepth} pending`,
          `Thinking: ${session?.thinking ?? 'default'}`,
          `Reasoning visible: ${session?.reasoningVisible ? 'on' : 'off'}`,
          `Tools visible: ${session?.toolsVisible ? 'on' : 'off'}`,
          `History: ${session?.history.length ?? 0} messages`,
        ];
        await channel.send({ channelId: message.channelId, text: lines.join('\n') });
        break;
      }

      case 'think': {
        const session = await this.getOrCreateSession(sessionKey, message);
        const levels: Set<string> = new Set(['off', 'low', 'medium', 'high']);
        if (args.trim() && levels.has(args.trim())) {
          session.thinking = args.trim() as ThinkingLevel;
          await this.saveSessionSettings(session);
          await channel.send({ channelId: message.channelId, text: `🧠 Thinking: ${session.thinking}` });
        } else {
          await channel.send({ channelId: message.channelId, text: `🧠 Thinking: ${session.thinking}\nUsage: /think off|low|medium|high` });
        }
        break;
      }

      case 'reasoning': {
        const session = await this.getOrCreateSession(sessionKey, message);
        session.reasoningVisible = !session.reasoningVisible;
        await this.saveSessionSettings(session);
        await channel.send({
          channelId: message.channelId,
          text: `🧠 Reasoning: ${session.reasoningVisible ? 'visible' : 'hidden'}`,
        });
        break;
      }

      case 'model': {
        const agents = this.router.getAgents();
        const lines = agents.map((a) => `**${a.id}**: ${a.provider}`);
        await channel.send({ channelId: message.channelId, text: `📋 Agents:\n${lines.join('\n')}` });
        break;
      }

      case 'tools': {
        const session = await this.getOrCreateSession(sessionKey, message);
        session.toolsVisible = !session.toolsVisible;
        await this.saveSessionSettings(session);
        await channel.send({
          channelId: message.channelId,
          text: `🔧 Tool calls: ${session.toolsVisible ? 'visible' : 'hidden'}`,
        });
        break;
      }

      default:
        await channel.send({ channelId: message.channelId, text: `❓ Unknown command: /${command}` });
    }
  }

  // -----------------------------------------------------------------------
  // Session Management
  // -----------------------------------------------------------------------

  /**
   * Get existing session or create a new one (with history + settings restore).
   */
  private async getOrCreateSession(sessionKey: string, message: InboundMessage): Promise<SessionState> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      const { agent } = this.router.route(message);
      session = await this.createSession(sessionKey, agent);
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  private async createSession(sessionKey: string, agent: AgentConfig): Promise<SessionState> {
    // Restore history
    let history: Message[] = [];
    if (this.memory) {
      try {
        history = await this.memory.getSessionHistory(sessionKey, { limit: 100 });
      } catch (err: any) {
        log.warn(`Failed to restore session history: ${err.message}`);
      }
    }

    // Restore settings
    let thinking = agent.defaultThinking ?? 'medium';
    let reasoningVisible = false;
    let toolsVisible = false;

    if (this.memory?.loadSessionSettings) {
      try {
        const settings = await this.memory.loadSessionSettings(sessionKey);
        if (settings) {
          thinking = (settings.thinking as any) ?? thinking;
          reasoningVisible = (settings.reasoningVisible as boolean) ?? reasoningVisible;
          toolsVisible = (settings.toolsVisible as boolean) ?? toolsVisible;
        }
      } catch {}
    }

    return { id: sessionKey, thinking, reasoningVisible, toolsVisible: toolsVisible ?? false, history };
  }

  /**
   * Persist session settings after a change.
   */
  private async saveSessionSettings(session: SessionState): Promise<void> {
    if (!this.memory?.saveSessionSettings) return;
    try {
      await this.memory.saveSessionSettings(session.id, {
        thinking: session.thinking,
        reasoningVisible: session.reasoningVisible,
        toolsVisible: session.toolsVisible,
      });
    } catch {}
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

    log.info('Ready.');
  }

  async stop(): Promise<void> {
    log.info('Stopping...');

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
