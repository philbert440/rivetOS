/**
 * Command Handler — processes slash commands (/stop, /new, /status, etc.)
 *
 * Extracted from the Runtime's handleCommand switch statement.
 * Each command is a focused method. Dependencies injected via constructor.
 */

import type {
  Channel,
  InboundMessage,
  ThinkingLevel,
} from '@rivetos/types';
import type { Router } from '../domain/router.js';
import type { WorkspaceLoader } from '../domain/workspace.js';
import type { MessageQueue } from '../domain/queue.js';
import type { AgentLoop } from '../domain/loop.js';
import type { SessionManager } from './sessions.js';
import type { StreamManager } from './streaming.js';

// ---------------------------------------------------------------------------
// Dependencies interface — what CommandHandler needs from the Runtime
// ---------------------------------------------------------------------------

export interface CommandDeps {
  router: Router;
  workspace: WorkspaceLoader;
  sessionManager: SessionManager;
  streamManager: StreamManager;
  getAbort: (sessionKey: string) => AbortController | undefined;
  deleteAbort: (sessionKey: string) => void;
  getActiveLoop: (sessionKey: string) => AgentLoop | undefined;
  deleteActiveLoop: (sessionKey: string) => void;
  getQueue: (sessionKey: string) => MessageQueue | undefined;
  handleMessage: (channel: Channel, message: InboundMessage) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

export class CommandHandler {
  private deps: CommandDeps;

  constructor(deps: CommandDeps) {
    this.deps = deps;
  }

  async handle(
    channel: Channel,
    command: string,
    args: string,
    message: InboundMessage,
  ): Promise<void> {
    const sessionKey = `${message.channelId}:${message.userId}`;

    switch (command) {
      case 'stop':
        return this.stop(channel, message, sessionKey);
      case 'interrupt':
        return this.interrupt(channel, message, args, sessionKey);
      case 'steer':
        return this.steer(channel, message, args, sessionKey);
      case 'new':
        return this.newSession(channel, message, sessionKey);
      case 'status':
        return this.status(channel, message, sessionKey);
      case 'think':
        return this.think(channel, message, args, sessionKey);
      case 'reasoning':
        return this.reasoning(channel, message, sessionKey);
      case 'start':
        return this.startCmd(channel, message);
      case 'model':
        return this.model(channel, message);
      case 'tools':
        return this.tools(channel, message, sessionKey);
      default:
        await channel.send({ channelId: message.channelId, text: `❓ Unknown command: /${command}` });
    }
  }

  // -----------------------------------------------------------------------
  // Individual command implementations
  // -----------------------------------------------------------------------

  private async stop(channel: Channel, message: InboundMessage, sessionKey: string): Promise<void> {
    const abort = this.deps.getAbort(sessionKey);
    if (abort) {
      abort.abort('User requested stop');
      this.deps.deleteAbort(sessionKey);
      this.deps.deleteActiveLoop(sessionKey);
      this.deps.getQueue(sessionKey)?.clear();
      await channel.send({ channelId: message.channelId, text: '⛔ Stopped.' });
    } else {
      await channel.send({ channelId: message.channelId, text: '💤 Nothing running.' });
    }
  }

  private async interrupt(channel: Channel, message: InboundMessage, args: string, sessionKey: string): Promise<void> {
    const abort = this.deps.getAbort(sessionKey);
    if (abort) {
      abort.abort('User interrupted');
      this.deps.deleteAbort(sessionKey);
      this.deps.deleteActiveLoop(sessionKey);
      this.deps.getQueue(sessionKey)?.clear();
    }
    // Keep history, start new turn with the interrupt message
    if (args.trim()) {
      const queue = this.deps.getQueue(sessionKey);
      if (queue) {
        await queue.enqueue({ ...message, text: args });
      } else {
        await this.deps.handleMessage(channel, { ...message, text: args });
      }
    } else {
      await channel.send({ channelId: message.channelId, text: '⚡ Interrupted. Send your next message.' });
    }
  }

  private async steer(channel: Channel, message: InboundMessage, args: string, sessionKey: string): Promise<void> {
    if (!args.trim()) {
      await channel.send({ channelId: message.channelId, text: '⚠️ Usage: /steer <message>' });
      return;
    }
    const loop = this.deps.getActiveLoop(sessionKey);
    if (loop) {
      loop.steer(args);
      await channel.send({ channelId: message.channelId, text: '📨 Injected into current turn.' });
    } else {
      await channel.send({ channelId: message.channelId, text: '💤 No active turn. Just send a message.' });
    }
  }

  private async newSession(channel: Channel, message: InboundMessage, sessionKey: string): Promise<void> {
    const abort = this.deps.getAbort(sessionKey);
    if (abort) {
      abort.abort('New session');
      this.deps.deleteAbort(sessionKey);
      this.deps.deleteActiveLoop(sessionKey);
    }
    this.deps.sessionManager.delete(sessionKey);
    this.deps.getQueue(sessionKey)?.clear();
    this.deps.workspace.clearCache();
    await channel.send({ channelId: message.channelId, text: '🔄 Fresh session. Workspace reloaded.' });
  }

  private async status(channel: Channel, message: InboundMessage, sessionKey: string): Promise<void> {
    const session = this.deps.sessionManager.get(sessionKey);
    const agents = this.deps.router.getAgents();
    const health = await this.deps.router.healthCheck();
    const isRunning = !!this.deps.getAbort(sessionKey);
    const queueDepth = this.deps.getQueue(sessionKey)?.depth ?? 0;

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
  }

  private async think(channel: Channel, message: InboundMessage, args: string, sessionKey: string): Promise<void> {
    const session = await this.deps.sessionManager.getOrCreateSession(sessionKey, message);
    const levels: Set<string> = new Set(['off', 'low', 'medium', 'high']);
    if (args.trim() && levels.has(args.trim())) {
      session.thinking = args.trim() as ThinkingLevel;
      await this.deps.sessionManager.saveSessionSettings(session);
      await channel.send({ channelId: message.channelId, text: `🧠 Thinking: ${session.thinking}` });
    } else {
      await channel.send({ channelId: message.channelId, text: `🧠 Thinking: ${session.thinking}\nUsage: /think off|low|medium|high` });
    }
  }

  private async reasoning(channel: Channel, message: InboundMessage, sessionKey: string): Promise<void> {
    const session = await this.deps.sessionManager.getOrCreateSession(sessionKey, message);
    session.reasoningVisible = !session.reasoningVisible;
    await this.deps.sessionManager.saveSessionSettings(session);
    await channel.send({
      channelId: message.channelId,
      text: `🧠 Reasoning: ${session.reasoningVisible ? 'visible' : 'hidden'}`,
    });
  }

  private async startCmd(channel: Channel, message: InboundMessage): Promise<void> {
    await channel.send({
      channelId: message.channelId,
      text: '👋 RivetOS v0.1.0 — ready.',
    });
  }

  private async model(channel: Channel, message: InboundMessage): Promise<void> {
    const agents = this.deps.router.getAgents();
    const lines = agents.map((a) => `**${a.id}**: ${a.provider}`);
    await channel.send({ channelId: message.channelId, text: `📋 Agents:\n${lines.join('\n')}` });
  }

  private async tools(channel: Channel, message: InboundMessage, sessionKey: string): Promise<void> {
    const session = await this.deps.sessionManager.getOrCreateSession(sessionKey, message);
    session.toolsVisible = !session.toolsVisible;
    await this.deps.sessionManager.saveSessionSettings(session);
    await channel.send({
      channelId: message.channelId,
      text: `🔧 Tool calls: ${session.toolsVisible ? 'visible' : 'hidden'}`,
    });
  }
}
