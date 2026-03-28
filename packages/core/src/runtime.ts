/**
 * Runtime — the top-level orchestrator.
 *
 * Wires channels, providers, tools, memory, and workspace together.
 * Handles the full message lifecycle:
 *
 *   Channel receives message
 *     → Router picks agent + provider
 *     → Workspace builds system prompt
 *     → AgentLoop runs (LLM + tools)
 *     → Response sent back to channel
 *     → Memory appended
 *
 * Also manages lifecycle: start, stop, slash commands.
 */

import type {
  Channel,
  Provider,
  Tool,
  Memory,
  InboundMessage,
  OutboundMessage,
  AgentConfig,
  StreamHandler,
} from '@rivetos/types';
import { AgentLoop } from './loop.js';
import { Router } from './router.js';
import { WorkspaceLoader } from './workspace.js';

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

  /** Active abort controllers — keyed by channelId:userId */
  private activeAborts: Map<string, AbortController> = new Map();

  /** Per-session conversation history — keyed by channelId:userId */
  private history: Map<string, import('@rivetos/types').Message[]> = new Map();

  private onStream?: StreamHandler;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.router = new Router(config.defaultAgent);
    this.workspace = new WorkspaceLoader(config.workspaceDir);

    // Register agents
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

    // Wire message handler
    channel.onMessage(async (message) => {
      await this.handleMessage(channel, message);
    });

    // Wire command handler
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

  setStreamHandler(handler: StreamHandler): void {
    this.onStream = handler;
  }

  // -----------------------------------------------------------------------
  // Message Handling
  // -----------------------------------------------------------------------

  private async handleMessage(channel: Channel, message: InboundMessage): Promise<void> {
    const sessionKey = `${message.channelId}:${message.userId}`;

    try {
      // Route to agent + provider
      const { agent, provider } = this.router.route(message);

      // Build system prompt from workspace
      const systemPrompt = await this.workspace.buildSystemPrompt(agent.id);

      // Get conversation history
      const history = this.history.get(sessionKey) ?? [];

      // Append memory context if available
      let enrichedPrompt = systemPrompt;
      if (this.memory) {
        const memoryContext = await this.memory.getContextForTurn(message.text, agent.id);
        if (memoryContext) {
          enrichedPrompt += `\n\n## Transcript Context\n${memoryContext}`;
        }
      }

      // Create abort controller for this turn
      const abort = new AbortController();
      this.activeAborts.set(sessionKey, abort);

      // Run agent loop
      const loop = new AgentLoop({
        systemPrompt: enrichedPrompt,
        provider,
        tools: this.tools,
        maxIterations: this.config.maxToolIterations,
        onStream: this.onStream,
      });

      const result = await loop.run(message.text, history, abort.signal);

      // Clean up abort controller
      this.activeAborts.delete(sessionKey);

      // Update history
      history.push({ role: 'user', content: message.text });
      if (result.response) {
        history.push({ role: 'assistant', content: result.response });
      }
      // Keep history bounded
      if (history.length > 100) {
        history.splice(0, history.length - 100);
      }
      this.history.set(sessionKey, history);

      // Send response
      if (result.response && !result.aborted) {
        await channel.send({
          channelId: message.channelId,
          text: result.response,
          replyToMessageId: message.id,
        });
      }

      // Append to memory
      if (this.memory) {
        await this.memory.append({
          sessionId: sessionKey,
          agent: agent.id,
          channel: channel.platform,
          role: 'user',
          content: message.text,
          metadata: {
            userId: message.userId,
            username: message.username,
            displayName: message.displayName,
          },
        });

        if (result.response) {
          await this.memory.append({
            sessionId: sessionKey,
            agent: agent.id,
            channel: channel.platform,
            role: 'assistant',
            content: result.response,
            metadata: { toolsUsed: result.toolsUsed, iterations: result.iterations },
          });
        }
      }
    } catch (err: any) {
      console.error(`[Runtime] Error handling message:`, err);
      await channel.send({
        channelId: message.channelId,
        text: `⚠️ Error: ${err.message}`,
        replyToMessageId: message.id,
      });
    }
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
        const abort = this.activeAborts.get(sessionKey);
        if (abort) {
          abort.abort('User requested stop');
          this.activeAborts.delete(sessionKey);
          await channel.send({ channelId: message.channelId, text: '⛔ Stopped.' });
        } else {
          await channel.send({ channelId: message.channelId, text: '💤 Nothing running.' });
        }
        break;
      }

      case 'new': {
        // Stop any running turn
        const abort = this.activeAborts.get(sessionKey);
        if (abort) {
          abort.abort('New session');
          this.activeAborts.delete(sessionKey);
        }
        // Clear history
        this.history.delete(sessionKey);
        await channel.send({ channelId: message.channelId, text: '🔄 Fresh session started.' });
        break;
      }

      case 'status': {
        const agents = this.router.getAgents();
        const health = await this.router.healthCheck();
        const running = this.activeAborts.size;
        const sessions = this.history.size;

        const lines = [
          '🤖 **RivetOS Status**',
          `Agents: ${agents.map((a) => `${a.id} (${a.provider})`).join(', ')}`,
          `Providers: ${Object.entries(health).map(([id, ok]) => `${id}: ${ok ? '✅' : '❌'}`).join(', ')}`,
          `Active turns: ${running}`,
          `Sessions: ${sessions}`,
          `Workspace: ${this.config.workspaceDir}`,
        ];
        await channel.send({ channelId: message.channelId, text: lines.join('\n') });
        break;
      }

      case 'steer': {
        if (!args.trim()) {
          await channel.send({ channelId: message.channelId, text: '⚠️ Usage: /steer <message>' });
          break;
        }
        // TODO: Wire steer to active AgentLoop instance
        // For now, just acknowledge
        await channel.send({ channelId: message.channelId, text: '📨 Steer not yet wired to active loop.' });
        break;
      }

      case 'model': {
        if (args.trim()) {
          // TODO: Dynamic model switching
          await channel.send({ channelId: message.channelId, text: `Model switching not yet implemented.` });
        } else {
          const agents = this.router.getAgents();
          const lines = agents.map((a) => `**${a.id}**: ${a.provider}`);
          await channel.send({ channelId: message.channelId, text: `📋 Agents:\n${lines.join('\n')}` });
        }
        break;
      }

      case 'start': {
        await channel.send({ channelId: message.channelId, text: `👋 RivetOS v${this.config.defaultAgent ?? '0.1.0'} — ready.` });
        break;
      }

      default:
        // Unknown command — pass through as a regular message
        await this.handleMessage(channel, { ...message, text: `/${command} ${args}`.trim() });
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    console.log('[RivetOS] Starting...');

    // Load workspace
    const files = await this.workspace.load();
    console.log(`[RivetOS] Workspace: ${files.length} files loaded from ${this.config.workspaceDir}`);

    // Health check providers
    const health = await this.router.healthCheck();
    for (const [id, ok] of Object.entries(health)) {
      console.log(`[RivetOS] Provider ${id}: ${ok ? '✅' : '❌'}`);
    }

    // Start all channels
    for (const [id, channel] of this.channels) {
      try {
        await channel.start();
        console.log(`[RivetOS] Channel ${id} (${channel.platform}): started`);
      } catch (err: any) {
        console.error(`[RivetOS] Channel ${id} failed to start:`, err.message);
      }
    }

    console.log('[RivetOS] Ready.');
  }

  async stop(): Promise<void> {
    console.log('[RivetOS] Stopping...');

    // Abort all active turns
    for (const [key, abort] of this.activeAborts) {
      abort.abort('Runtime shutdown');
    }
    this.activeAborts.clear();

    // Stop all channels
    for (const [id, channel] of this.channels) {
      try {
        await channel.stop();
        console.log(`[RivetOS] Channel ${id}: stopped`);
      } catch (err: any) {
        console.error(`[RivetOS] Channel ${id} failed to stop:`, err.message);
      }
    }

    console.log('[RivetOS] Stopped.');
  }
}
