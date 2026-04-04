// TODO: Add integration tests (see rivetos-full-review-final.md #12)

/**
 * @rivetos/channel-discord
 *
 * Discord channel plugin via discord.js v14.
 *
 * Features:
 * - Channel bindings: route #deep-thinking → opus, #brainstorm → grok, #research → gemini
 * - Thread support (create + reply)
 * - Embeds for rich output
 * - Action rows with buttons
 * - Emoji reactions
 * - Message editing (for streaming)
 * - Message splitting at 2000 chars
 * - Mention-based activation in servers
 * - Slash command interception
 * - Markdown renders natively (Discord supports it)
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  TextChannel,
  ThreadChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  type Interaction,
} from 'discord.js'
import type {
  Channel,
  EditResult,
  InboundMessage,
  OutboundMessage,
  Attachment,
  ResolvedAttachment,
} from '@rivetos/types'
import { splitMessage } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DiscordChannelConfig {
  botToken: string
  ownerId: string
  allowedGuilds?: string[]
  allowedChannels?: string[]
  allowedUsers?: string[]
  /** Map channelId → agentId for routing */
  channelBindings?: Record<string, string>
  /** Only respond when mentioned in servers (default: false) */
  mentionOnly?: boolean
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class DiscordChannel implements Channel {
  id: string
  platform = 'discord'
  maxMessageLength = 2000

  private client: Client
  private config: DiscordChannelConfig
  private messageHandler?: (message: InboundMessage) => Promise<void>
  private commandHandler?: (command: string, args: string, message: InboundMessage) => Promise<void>

  /** Active typing intervals per channel — cleared when a turn ends */
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map()

  constructor(config: DiscordChannelConfig) {
    this.config = config
    this.id = `discord:${config.ownerId}`

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    })

    this.setupHandlers()
  }

  // -----------------------------------------------------------------------
  // Setup
  // -----------------------------------------------------------------------

  private setupHandlers(): void {
    this.client.on('messageCreate', (msg) => {
      void this.handleMessage(msg)
    })

    // Button interactions

    this.client.on('interactionCreate', (interaction: Interaction) => {
      void this.handleInteraction(interaction)
    })

    this.client.once('ready', () => {
      console.log(`[Discord] Bot ready: ${this.client.user?.tag}`)
    })
  }

  // -----------------------------------------------------------------------
  // Access Control
  // -----------------------------------------------------------------------

  private isAllowed(msg: DiscordMessage): boolean {
    if (this.config.allowedGuilds?.length && msg.guildId) {
      if (!this.config.allowedGuilds.includes(msg.guildId)) return false
    }

    if (this.config.allowedChannels?.length) {
      // Also allow threads whose parent is in allowedChannels
      const checkId = msg.channel.isThread()
        ? (msg.channel.parentId ?? msg.channelId)
        : msg.channelId
      if (
        !this.config.allowedChannels.includes(checkId) &&
        !this.config.allowedChannels.includes(msg.channelId)
      )
        return false
    }

    if (this.config.allowedUsers?.length) {
      if (
        !this.config.allowedUsers.includes(msg.author.id) &&
        msg.author.id !== this.config.ownerId
      )
        return false
    }

    // Mention-only mode
    if (this.config.mentionOnly && msg.guildId) {
      const botId = this.client.user?.id
      if (botId && !msg.mentions.has(botId)) return false
    }

    return true
  }

  // -----------------------------------------------------------------------
  // Channel → Agent Routing
  // -----------------------------------------------------------------------

  private getAgentForChannel(channelId: string): string | undefined {
    return this.config.channelBindings?.[channelId]
  }

  // -----------------------------------------------------------------------
  // Inbound
  // -----------------------------------------------------------------------

  private buildInbound(msg: DiscordMessage): InboundMessage {
    // Strip bot mention
    let text = msg.content
    const botId = this.client.user?.id
    if (botId) {
      text = text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
    }

    const inbound: InboundMessage = {
      id: msg.id,
      userId: msg.author.id,
      username: msg.author.username,
      displayName: msg.author.displayName,
      channelId: msg.channelId,
      chatType:
        msg.channel.type === ChannelType.DM ? 'dm' : msg.channel.isThread() ? 'thread' : 'guild',
      text,
      platform: 'discord',
      agent: this.getAgentForChannel(msg.channelId),
      timestamp: Math.floor(msg.createdTimestamp / 1000),
    }

    if (msg.reference?.messageId) {
      inbound.replyToMessageId = msg.reference.messageId
    }

    if (msg.attachments.size > 0) {
      inbound.attachments = [...msg.attachments.values()].map((a) => ({
        type: a.contentType?.startsWith('image/') ? ('photo' as const) : ('document' as const),
        url: a.url,
        fileName: a.name,
        mimeType: a.contentType ?? undefined,
      }))
    }

    return inbound
  }

  // -----------------------------------------------------------------------
  // Outbound
  // -----------------------------------------------------------------------

  async send(msg: OutboundMessage): Promise<string | null> {
    try {
      const channel = await this.client.channels.fetch(msg.channelId)
      if (!channel || !('send' in channel)) return null
      const sendable = channel as TextChannel | ThreadChannel

      const options: {
        embeds?: EmbedBuilder[]
        components?: ActionRowBuilder<ButtonBuilder>[]
        reply?: { messageReference: string }
        flags?: number[]
      } = {}

      // Text — split at Discord's 2000 char limit
      if (msg.text) {
        const chunks = splitMessage(msg.text, 2000)

        // Embed
        if (msg.embed) {
          const embed = new EmbedBuilder().setDescription(msg.embed.description)
          if (msg.embed.title) embed.setTitle(msg.embed.title)
          if (msg.embed.color) embed.setColor(msg.embed.color)
          if (msg.embed.fields) {
            for (const f of msg.embed.fields)
              embed.addFields({ name: f.name, value: f.value, inline: f.inline })
          }
          if (msg.embed.footer) embed.setFooter({ text: msg.embed.footer })
          options.embeds = [embed]
        }

        // Buttons
        if (msg.buttons?.length) {
          const row = new ActionRowBuilder<ButtonBuilder>()
          for (const btn of msg.buttons.flat()) {
            const style =
              btn.style === 'success'
                ? ButtonStyle.Success
                : btn.style === 'danger'
                  ? ButtonStyle.Danger
                  : ButtonStyle.Primary
            row.addComponents(
              new ButtonBuilder().setCustomId(btn.callbackData).setLabel(btn.text).setStyle(style),
            )
          }
          options.components = [row]
        }

        // Reply reference
        if (msg.replyToMessageId) {
          options.reply = { messageReference: msg.replyToMessageId }
        }

        // Silent
        if (msg.silent) {
          options.flags = [4096]
        }

        // Send chunks
        let lastId: string | null = null
        for (let i = 0; i < chunks.length; i++) {
          const sent = await sendable.send({
            content: chunks[i],
            ...(i === 0 ? options : {}),
            ...(i === chunks.length - 1 && options.embeds ? { embeds: options.embeds } : {}),
            ...(i === chunks.length - 1 && options.components
              ? { components: options.components }
              : {}),
          })
          lastId = sent.id
        }
        return lastId
      }

      // Embed-only (no text)
      if (msg.embed) {
        const embed = new EmbedBuilder().setDescription(msg.embed.description)
        if (msg.embed.title) embed.setTitle(msg.embed.title)
        if (msg.embed.color) embed.setColor(msg.embed.color)
        const sent = await sendable.send({ embeds: [embed] })
        return sent.id
      }

      return null
    } catch (err: unknown) {
      console.error('[Discord] Send failed:', (err as Error).message)
      return null
    }
  }

  async edit(
    channelId: string,
    messageId: string,
    text: string,
    overflowIds: string[] = [],
  ): Promise<EditResult | null> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel || !('messages' in channel)) return null
      const textChannel = channel as TextChannel

      const chunks = splitMessage(text, this.maxMessageLength)
      const resultIds: string[] = [messageId]

      // Edit primary message with first chunk
      const msg = await textChannel.messages.fetch(messageId)
      await msg.edit({ content: chunks[0] })

      // Handle overflow chunks — re-edit existing overflow messages when possible
      for (let i = 1; i < chunks.length; i++) {
        const existingId = overflowIds[i - 1]
        if (existingId) {
          // Re-edit previously-created overflow message
          const overflowMsg = await textChannel.messages.fetch(existingId)
          await overflowMsg.edit({ content: chunks[i] })
          resultIds.push(existingId)
        } else {
          // No existing overflow message — send a new one
          const sent = await textChannel.send({ content: chunks[i] })
          resultIds.push(sent.id)
        }
      }

      // Clean up stale overflow messages (text got shorter, fewer chunks needed)
      for (let i = chunks.length - 1; i < overflowIds.length; i++) {
        try {
          const staleMsg = await textChannel.messages.fetch(overflowIds[i])
          await staleMsg.delete()
        } catch {
          /* non-critical — message may already be gone */
        }
      }

      return { messageIds: resultIds }
    } catch {
      return null
    }
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel || !('messages' in channel)) return
      const msg = await (channel as TextChannel).messages.fetch(messageId)
      await msg.react(emoji)
    } catch {
      /* reaction not critical */
    }
  }

  // -----------------------------------------------------------------------
  // Attachment Resolution
  // -----------------------------------------------------------------------

  async resolveAttachment(attachment: Attachment): Promise<ResolvedAttachment | null> {
    // Discord attachments have public CDN URLs — no download needed
    if (!attachment.url) return await Promise.resolve(null)

    return await Promise.resolve({
      type: attachment.type,
      url: attachment.url,
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
    })
  }

  // -----------------------------------------------------------------------
  // Typing Indicator
  // -----------------------------------------------------------------------

  /**
   * Start sending typing indicator every 8 seconds.
   * Discord's typing indicator expires after ~10 seconds, so 8s keeps it alive.
   */
  private startTyping(channelId: string): void {
    this.stopTyping(channelId)

    this.sendTypingAction(channelId)
    const interval = setInterval(() => this.sendTypingAction(channelId), 8000)
    this.typingIntervals.set(channelId, interval)
  }

  private stopTyping(channelId: string): void {
    const interval = this.typingIntervals.get(channelId)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(channelId)
    }
  }

  private sendTypingAction(channelId: string): void {
    this.client.channels
      .fetch(channelId)
      .then((channel) => {
        if (channel && 'sendTyping' in channel) {
          ;(channel as TextChannel).sendTyping().catch(() => {})
        }
      })
      .catch(() => {})
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildKeyboard(
    buttons: import('@rivetos/types').Button[][],
  ): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>()
    for (const btn of buttons.flat()) {
      const style =
        btn.style === 'success'
          ? ButtonStyle.Success
          : btn.style === 'danger'
            ? ButtonStyle.Danger
            : ButtonStyle.Primary
      row.addComponents(
        new ButtonBuilder().setCustomId(btn.callbackData).setLabel(btn.text).setStyle(style),
      )
    }
    return row
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Inbound Handlers
  // -----------------------------------------------------------------------

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    // Ignore bots
    if (msg.author.bot) return
    // Check access control
    if (!this.isAllowed(msg)) return

    // Check for slash-like commands: /command args
    const match = msg.content.match(/^\/(\w+)\s*(.*)/)
    if (match && this.commandHandler) {
      const inbound = this.buildInbound(msg)
      await this.commandHandler(match[1], match[2], inbound)
      return
    }

    if (this.messageHandler) {
      const inbound = this.buildInbound(msg)
      await this.messageHandler(inbound)
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return
    if (!this.commandHandler) return

    const inbound: InboundMessage = {
      id: interaction.id,
      userId: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
      channelId: interaction.channelId,
      chatType: 'button',
      text: interaction.customId,
      platform: 'discord',
      timestamp: Date.now(),
    }

    await interaction.deferUpdate().catch(() => {})
    await this.commandHandler('button', interaction.customId, inbound)
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onCommand(
    handler: (command: string, args: string, message: InboundMessage) => Promise<void>,
  ): void {
    this.commandHandler = handler
  }

  async start(): Promise<void> {
    console.log('[Discord] Starting...')
    await this.client.login(this.config.botToken)
  }

  async stop(): Promise<void> {
    console.log('[Discord] Stopping...')
    // Clear all typing intervals
    for (const [channelId] of this.typingIntervals) {
      this.stopTyping(channelId)
    }
    await this.client.destroy()
  }
}
