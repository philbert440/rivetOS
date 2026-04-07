/**
 * Command Handler — processes slash commands (/stop, /new, /status, etc.)
 *
 * Extracted from the Runtime's handleCommand switch statement.
 * Each command is a focused method. Dependencies injected via constructor.
 */

import { readFile, writeFile } from 'node:fs/promises'
import type { Channel, InboundMessage, ThinkingLevel } from '@rivetos/types'
import type { Router } from '../domain/router.js'
import type { WorkspaceLoader } from '../domain/workspace.js'
import type { MessageQueue } from '../domain/queue.js'
import type { AgentLoop } from '../domain/loop.js'
import type { SessionManager } from './sessions.js'
import type { StreamManager } from './streaming.js'

// ---------------------------------------------------------------------------
// Dependencies interface — what CommandHandler needs from the Runtime
// ---------------------------------------------------------------------------

export interface CommandDeps {
  router: Router
  workspace: WorkspaceLoader
  sessionManager: SessionManager
  streamManager: StreamManager
  getAbort: (sessionKey: string) => AbortController | undefined
  deleteAbort: (sessionKey: string) => void
  getActiveLoop: (sessionKey: string) => AgentLoop | undefined
  deleteActiveLoop: (sessionKey: string) => void
  getQueue: (sessionKey: string) => MessageQueue | undefined
  handleMessage: (channel: Channel, message: InboundMessage) => Promise<void>
  /** Path to config.yaml for persistent model changes */
  configPath?: string
}

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

export class CommandHandler {
  private deps: CommandDeps

  constructor(deps: CommandDeps) {
    this.deps = deps
  }

  async handle(
    channel: Channel,
    command: string,
    args: string,
    message: InboundMessage,
  ): Promise<void> {
    const sessionKey = `${message.channelId}:${message.userId}`

    switch (command) {
      case 'stop':
        return this.stop(channel, message, sessionKey)
      case 'interrupt':
        return this.interrupt(channel, message, args, sessionKey)
      case 'steer':
        return this.steer(channel, message, args, sessionKey)
      case 'new':
        return this.newSession(channel, message, sessionKey)
      case 'status':
        return this.status(channel, message, sessionKey)
      case 'think':
        return this.think(channel, message, args, sessionKey)
      case 'reasoning':
        return this.reasoning(channel, message, sessionKey)
      case 'start':
        return this.startCmd(channel, message)
      case 'model':
        return this.model(channel, message, args)
      case 'tools':
        return this.tools(channel, message, sessionKey)
      case 'context':
        return this.context(channel, message, args, sessionKey)
      default:
        await channel.send({
          channelId: message.channelId,
          text: `❓ Unknown command: /${command}`,
        })
    }
  }

  // -----------------------------------------------------------------------
  // Individual command implementations
  // -----------------------------------------------------------------------

  private async stop(channel: Channel, message: InboundMessage, sessionKey: string): Promise<void> {
    const abort = this.deps.getAbort(sessionKey)
    if (abort) {
      abort.abort('User requested stop')
      this.deps.deleteAbort(sessionKey)
      this.deps.deleteActiveLoop(sessionKey)
      this.deps.getQueue(sessionKey)?.clear()
      await channel.send({ channelId: message.channelId, text: '⛔ Stopped.' })
    } else {
      await channel.send({ channelId: message.channelId, text: '💤 Nothing running.' })
    }
  }

  private async interrupt(
    channel: Channel,
    message: InboundMessage,
    args: string,
    sessionKey: string,
  ): Promise<void> {
    const abort = this.deps.getAbort(sessionKey)
    if (abort) {
      abort.abort('User interrupted')
      this.deps.deleteAbort(sessionKey)
      this.deps.deleteActiveLoop(sessionKey)
      this.deps.getQueue(sessionKey)?.clear()
    }
    // Keep history, start new turn with the interrupt message
    if (args.trim()) {
      const queue = this.deps.getQueue(sessionKey)
      if (queue) {
        await queue.enqueue({ ...message, text: args })
      } else {
        await this.deps.handleMessage(channel, { ...message, text: args })
      }
    } else {
      await channel.send({
        channelId: message.channelId,
        text: '⚡ Interrupted. Send your next message.',
      })
    }
  }

  private async steer(
    channel: Channel,
    message: InboundMessage,
    args: string,
    sessionKey: string,
  ): Promise<void> {
    if (!args.trim()) {
      await channel.send({ channelId: message.channelId, text: '⚠️ Usage: /steer <message>' })
      return
    }
    const loop = this.deps.getActiveLoop(sessionKey)
    if (loop) {
      loop.steer(args)
      await channel.send({ channelId: message.channelId, text: '📨 Injected into current turn.' })
    } else {
      await channel.send({
        channelId: message.channelId,
        text: '💤 No active turn. Just send a message.',
      })
    }
  }

  private async newSession(
    channel: Channel,
    message: InboundMessage,
    sessionKey: string,
  ): Promise<void> {
    const abort = this.deps.getAbort(sessionKey)
    if (abort) {
      abort.abort('New session')
      this.deps.deleteAbort(sessionKey)
      this.deps.deleteActiveLoop(sessionKey)
    }
    this.deps.sessionManager.delete(sessionKey)
    this.deps.getQueue(sessionKey)?.clear()
    this.deps.workspace.clearCache()
    await channel.send({
      channelId: message.channelId,
      text: '🔄 Fresh session. Workspace reloaded.',
    })
  }

  private async status(
    channel: Channel,
    message: InboundMessage,
    sessionKey: string,
  ): Promise<void> {
    const session = this.deps.sessionManager.get(sessionKey)
    const agents = this.deps.router.getAgents()
    const health = await this.deps.router.healthCheck()
    const isRunning = !!this.deps.getAbort(sessionKey)
    const queueDepth = this.deps.getQueue(sessionKey)?.depth ?? 0

    const lines = [
      '🤖 **RivetOS Status**',
      `Agents: ${agents.map((a) => `${a.id} (${a.provider})`).join(', ')}`,
      `Providers: ${Object.entries(health)
        .map(([id, ok]) => `${id}: ${ok ? '✅' : '❌'}`)
        .join(', ')}`,
      `State: ${isRunning ? '⚙️ Processing' : '💤 Idle'}`,
      `Queue: ${queueDepth} pending`,
      `Thinking: ${session?.thinking ?? 'default'}`,
      `Reasoning visible: ${session?.reasoningVisible ? 'on' : 'off'}`,
      `Tools visible: ${session?.toolsVisible ? 'on' : 'off'}`,
      `History: ${session?.history.length ?? 0} messages`,
    ]
    await channel.send({ channelId: message.channelId, text: lines.join('\n') })
  }

  private async think(
    channel: Channel,
    message: InboundMessage,
    args: string,
    sessionKey: string,
  ): Promise<void> {
    const session = await this.deps.sessionManager.getOrCreateSession(sessionKey, message)
    const levels: Set<string> = new Set(['off', 'low', 'medium', 'high'])
    if (args.trim() && levels.has(args.trim())) {
      session.thinking = args.trim() as ThinkingLevel
      await this.deps.sessionManager.saveSessionSettings(session)
      await channel.send({ channelId: message.channelId, text: `🧠 Thinking: ${session.thinking}` })
    } else {
      await channel.send({
        channelId: message.channelId,
        text: `🧠 Thinking: ${session.thinking}\nUsage: /think off|low|medium|high`,
      })
    }
  }

  private async reasoning(
    channel: Channel,
    message: InboundMessage,
    sessionKey: string,
  ): Promise<void> {
    const session = await this.deps.sessionManager.getOrCreateSession(sessionKey, message)
    session.reasoningVisible = !session.reasoningVisible
    await this.deps.sessionManager.saveSessionSettings(session)
    await channel.send({
      channelId: message.channelId,
      text: `🧠 Reasoning: ${session.reasoningVisible ? 'visible' : 'hidden'}`,
    })
  }

  private async startCmd(channel: Channel, message: InboundMessage): Promise<void> {
    await channel.send({
      channelId: message.channelId,
      text: '👋 RivetOS v0.1.0 — ready.',
    })
  }

  private async model(channel: Channel, message: InboundMessage, args: string): Promise<void> {
    const parts = args.trim().split(/\s+/).filter(Boolean)
    const providers = this.deps.router.getProviders()
    const agents = this.deps.router.getAgents()

    if (parts.length === 0) {
      // /model — show all providers with current models
      const lines = providers.map((p) => {
        const boundAgents = agents.filter((a) => a.provider === p.id).map((a) => a.id)
        return `- **${p.id}**: \`${p.getModel()}\` (agents: ${boundAgents.join(', ') || 'none'})`
      })
      await channel.send({
        channelId: message.channelId,
        text: `🤖 **Active providers:**\n${lines.join('\n')}`,
      })
      return
    }

    const providerId = parts[0]
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) {
      await channel.send({
        channelId: message.channelId,
        text: `❌ Unknown provider: \`${providerId}\`. Available: ${providers.map((p) => p.id).join(', ')}`,
      })
      return
    }

    if (parts.length === 1) {
      // /model <provider> — show current model for that provider
      const boundAgents = agents.filter((a) => a.provider === providerId).map((a) => a.id)
      await channel.send({
        channelId: message.channelId,
        text: `🤖 **${providerId}**\n- Model: \`${provider.getModel()}\`\n- Agents: ${boundAgents.join(', ') || 'none'}`,
      })
      return
    }

    // /model <provider> <model> — switch model
    const newModel = parts.slice(1).join(' ')
    const oldModel = provider.getModel()
    provider.setModel(newModel)

    // Persist to config.yaml
    let persisted = false
    if (this.deps.configPath) {
      try {
        const yaml = await readFile(this.deps.configPath, 'utf-8')
        // Find the provider section and update the model line
        const providerRegex = new RegExp(
          `(${providerId}:\\s*\\n(?:[ \\t]+\\w[^\\n]*\\n)*?[ \\t]+model:[ \\t]+)([^\\n]+)`,
        )
        const updated = yaml.replace(providerRegex, `$1${newModel}`)
        if (updated !== yaml) {
          await writeFile(this.deps.configPath, updated, 'utf-8')
          persisted = true
        }
      } catch {
        // Non-fatal — model is changed in-memory even if persist fails
      }
    }

    await channel.send({
      channelId: message.channelId,
      text: `✅ **${providerId}** model changed: \`${oldModel}\` → \`${newModel}\`${persisted ? ' (saved to config)' : ''}`,
    })
  }

  private async tools(
    channel: Channel,
    message: InboundMessage,
    sessionKey: string,
  ): Promise<void> {
    const session = await this.deps.sessionManager.getOrCreateSession(sessionKey, message)
    session.toolsVisible = !session.toolsVisible
    await this.deps.sessionManager.saveSessionSettings(session)
    await channel.send({
      channelId: message.channelId,
      text: `🔧 Tool calls: ${session.toolsVisible ? 'visible' : 'hidden'}`,
    })
  }

  // -----------------------------------------------------------------------
  // /context — pin/unpin files into the system prompt
  // -----------------------------------------------------------------------

  private async context(
    channel: Channel,
    message: InboundMessage,
    args: string,
    sessionKey: string,
  ): Promise<void> {
    const parts = args.trim().split(/\s+/)
    const subcommand = parts[0]?.toLowerCase()
    const filePath = parts.slice(1).join(' ')

    switch (subcommand) {
      case 'add':
      case 'pin': {
        if (!filePath) {
          await channel.send({
            channelId: message.channelId,
            text: '⚠️ Usage: /context add <file path>',
          })
          return
        }
        const result = await this.deps.workspace.pinFile(filePath)
        if ('error' in result) {
          await channel.send({ channelId: message.channelId, text: `❌ ${result.error}` })
        } else {
          // Invalidate cached system prompt so next turn rebuilds with the pin
          const session = this.deps.sessionManager.get(sessionKey)
          if (session) session.systemPrompt = undefined
          await channel.send({
            channelId: message.channelId,
            text: `📌 Pinned **${result.name}** (${this.formatSize(result.size)})`,
          })
        }
        return
      }
      case 'remove':
      case 'unpin': {
        if (!filePath) {
          await channel.send({
            channelId: message.channelId,
            text: '⚠️ Usage: /context remove <file path>',
          })
          return
        }
        const removed = this.deps.workspace.unpinFile(filePath)
        const session = this.deps.sessionManager.get(sessionKey)
        if (session) session.systemPrompt = undefined
        if (removed) {
          await channel.send({
            channelId: message.channelId,
            text: `📌 Unpinned **${filePath}**`,
          })
        } else {
          await channel.send({
            channelId: message.channelId,
            text: `⚠️ **${filePath}** was not pinned`,
          })
        }
        return
      }
      case 'list': {
        const pinned = this.deps.workspace.getPinnedFiles()
        if (pinned.length === 0) {
          await channel.send({ channelId: message.channelId, text: '📌 No files pinned.' })
        } else {
          const lines = pinned.map((f) => `- **${f.name}** (${this.formatSize(f.size)})`)
          await channel.send({
            channelId: message.channelId,
            text: `📌 **Pinned files:**\n${lines.join('\n')}`,
          })
        }
        return
      }
      case 'clear': {
        const count = this.deps.workspace.clearPinnedFiles()
        const session = this.deps.sessionManager.get(sessionKey)
        if (session) session.systemPrompt = undefined
        await channel.send({
          channelId: message.channelId,
          text: `📌 Cleared ${count} pinned file${count !== 1 ? 's' : ''}.`,
        })
        return
      }
      default:
        await channel.send({
          channelId: message.channelId,
          text: '📌 **Context commands:**\n- `/context add <file>` — pin a file\n- `/context remove <file>` — unpin\n- `/context list` — show pinned files\n- `/context clear` — unpin all',
        })
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }
}
