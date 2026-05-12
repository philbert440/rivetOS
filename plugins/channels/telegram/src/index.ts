/**
 * @rivetos/channel-telegram
 *
 * Telegram channel backed by `@chat-adapter/telegram` (Chat SDK).
 *
 * Replaces the previous direct-grammY implementation. We map the
 * RivetOS `Channel` interface onto the Chat SDK adapter:
 *   - `start()`  → `chat.initialize()` + `adapter.startPolling()`
 *   - `stop()`   → `chat.shutdown()`
 *   - `send()`   → `adapter.postMessage(threadId, { markdown })`
 *   - `edit()`   → `adapter.editMessage(threadId, messageId, { markdown })`
 *   - `react()`  → `adapter.addReaction(threadId, messageId, emoji)`
 *
 * The Chat SDK handles MarkdownV2 escaping, entity rendering, message
 * dedup, and per-thread locking. We retain RivetOS-side overflow
 * splitting (Telegram 4096 char limit) since the adapter does not split.
 */

import { Chat, type Attachment as ChatAttachment, type Message as ChatMessage } from 'chat'
import {
  TelegramAdapter,
  createTelegramAdapter,
  type TelegramRawMessage,
} from '@chat-adapter/telegram'
import { createMemoryState } from '@chat-adapter/state-memory'
import type {
  Channel,
  EditResult,
  InboundMessage,
  OutboundMessage,
  Attachment,
  ResolvedAttachment,
  PluginManifest,
} from '@rivetos/types'
import { splitMessage, COMMAND_NAMES } from '@rivetos/types'

/**
 * Telegram raw-message shape, widened to expose fields the adapter's
 * exported types omit (notably `reply_to_message`). The runtime payload
 * follows the public Bot API.
 *
 * @see https://core.telegram.org/bots/api#message
 */
type TelegramRawMessageExt = TelegramRawMessage & {
  reply_to_message?: { message_id: number }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramChannelConfig {
  botToken: string
  ownerId: string
  allowedUsers?: string[]
  /** Agent to route messages to (for channel binding) */
  agent?: string
  /** Bot @username (optional — adapter auto-detects via getMe) */
  userName?: string
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class TelegramChannel implements Channel {
  id: string
  platform = 'telegram'
  maxMessageLength = 4096

  private config: TelegramChannelConfig
  private adapter: TelegramAdapter
  private chat: Chat<{ telegram: TelegramAdapter }>
  private started = false

  private messageHandler?: (message: InboundMessage) => Promise<void>
  private commandHandler?: (command: string, args: string, message: InboundMessage) => Promise<void>

  /** fetchData closures keyed by stable attachment id (telegram fileId). */
  private attachmentFetchers = new Map<string, () => Promise<Buffer>>()

  constructor(config: TelegramChannelConfig) {
    this.config = config
    this.id = `telegram:${config.ownerId}`

    this.adapter = createTelegramAdapter({
      botToken: config.botToken,
      mode: 'polling',
      userName: config.userName,
    })

    this.chat = new Chat({
      userName: config.userName ?? 'rivetos',
      adapters: { telegram: this.adapter },
      state: createMemoryState(),
      // Telegram defaults to channel-scoped locking, which is what we want.
      logger: 'warn',
      // Keep a small in-memory history for the adapter's own caches; RivetOS
      // owns its session history independently.
      threadHistory: { maxMessages: 50 },
    })
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
    if (this.started) return

    // Register handlers BEFORE initialize so adapter.initialize sees them.
    this.registerHandlers()

    await this.chat.initialize()
    // initialize() doesn't start polling automatically when adapters were
    // pre-registered; call explicitly. resetWebhook handled internally.
    await this.adapter.startPolling()

    console.log(`[Telegram] Bot started: @${this.adapter.userName}`)
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    try {
      await this.adapter.stopPolling()
    } catch (err) {
      console.error('[Telegram] stopPolling failed:', err)
    }
    try {
      await this.chat.shutdown()
    } catch (err) {
      console.error('[Telegram] chat.shutdown failed:', err)
    }
    this.attachmentFetchers.clear()
    this.started = false
  }

  // -----------------------------------------------------------------------
  // Handler registration
  // -----------------------------------------------------------------------

  private registerHandlers(): void {
    // DMs — fire on every direct message.
    this.chat.onDirectMessage((_thread, message) => this.dispatch(message))

    // Group mentions — first @-mention triggers subscribe so follow-ups
    // route to onSubscribedMessage.
    this.chat.onNewMention(async (thread, message) => {
      try {
        await thread.subscribe()
      } catch {
        /* non-critical — subscribe may fail in DMs / already-subscribed */
      }
      await this.dispatch(message)
    })

    // Subscribed threads — once we've subscribed, all follow-up messages
    // come here.
    this.chat.onSubscribedMessage((_thread, message) => this.dispatch(message))
  }

  private async dispatch(message: ChatMessage): Promise<void> {
    const userId = message.author.userId
    if (!this.isAllowed(userId)) {
      console.log(`[Telegram] User ${userId} not in allowlist, ignoring`)
      return
    }

    const inbound = this.buildInbound(message)

    // Detect /command and route to commandHandler.
    const text = message.text.trim()
    if (text.startsWith('/')) {
      const [head, ...rest] = text.slice(1).split(/\s+/)
      const cmd = head.split('@')[0] // strip "@botname" suffix some clients add
      if (COMMAND_NAMES.has(cmd) && this.commandHandler) {
        try {
          await this.commandHandler(cmd, rest.join(' '), inbound)
        } catch (err) {
          console.error('[Telegram] Command handler error:', err)
        }
        return
      }
    }

    if (!this.messageHandler) {
      console.log('[Telegram] No message handler registered')
      return
    }

    try {
      await this.messageHandler(inbound)
    } catch (err) {
      console.error('[Telegram] Message handler error:', err)
      const chatId = this.chatIdFromThreadId(message.threadId)
      try {
        await this.adapter.postMessage(this.threadIdForChatId(chatId), {
          markdown: `⚠️ Error: ${(err as Error).message}`,
        })
      } catch {
        /* non-critical */
      }
    }
  }

  // -----------------------------------------------------------------------
  // Access control
  // -----------------------------------------------------------------------

  private isAllowed(userId: string): boolean {
    if (!this.config.allowedUsers?.length) return true
    return this.config.allowedUsers.includes(userId) || userId === this.config.ownerId
  }

  // -----------------------------------------------------------------------
  // Inbound message construction
  // -----------------------------------------------------------------------

  private buildInbound(message: ChatMessage): InboundMessage {
    const raw = message.raw as TelegramRawMessageExt
    const author = message.author
    const chatId = String(raw.chat.id)

    const inbound: InboundMessage = {
      id: String(raw.message_id),
      userId: author.userId,
      username: author.userName || undefined,
      displayName: author.fullName || undefined,
      channelId: chatId,
      chatType: raw.chat.type,
      text: raw.text ?? raw.caption ?? '',
      platform: 'telegram',
      agent: this.config.agent,
      timestamp: raw.date,
    }

    if (raw.reply_to_message) {
      inbound.replyToMessageId = String(raw.reply_to_message.message_id)
    }

    const attachments = this.translateAttachments(message.attachments, raw)
    if (attachments.length) {
      inbound.attachments = attachments
    }

    return inbound
  }

  private translateAttachments(
    chatAttachments: ChatAttachment[],
    raw: TelegramRawMessageExt,
  ): Attachment[] {
    const out: Attachment[] = []

    for (const att of chatAttachments) {
      const fileId = att.fetchMetadata?.fileId ?? att.fetchMetadata?.file_id ?? att.name
      if (!fileId) continue

      // Cache the fetch closure so resolveAttachment() can use it later.
      if (att.fetchData) {
        this.attachmentFetchers.set(fileId, att.fetchData)
      }

      const ours: Attachment = {
        type: mapAttachmentType(att.type, raw),
        fileId,
        fileName: att.name,
        mimeType: att.mimeType,
        width: att.width,
        height: att.height,
      }

      if (raw.voice?.file_id === fileId && raw.voice.duration) {
        ours.duration = raw.voice.duration
      } else if (raw.audio?.file_id === fileId && raw.audio.duration) {
        ours.duration = raw.audio.duration
      }

      out.push(ours)
    }

    return out
  }

  // -----------------------------------------------------------------------
  // Outbound — send
  // -----------------------------------------------------------------------

  async send(msg: OutboundMessage): Promise<string | null> {
    const raw = msg.text ?? ''
    if (!raw) return null

    const threadId = this.threadIdForChatId(msg.channelId)
    const chunks = splitMessage(raw, this.maxMessageLength)
    let lastId: string | null = null

    for (let i = 0; i < chunks.length; i++) {
      const sent = await this.postMarkdown(threadId, chunks[i])
      if (sent) lastId = sent
    }

    return lastId
  }

  private async postMarkdown(threadId: string, text: string): Promise<string | null> {
    try {
      const result = await this.adapter.postMessage(threadId, { markdown: text })
      return result.id
    } catch {
      // Fall back to raw text if MarkdownV2 rendering rejects.
      try {
        const result = await this.adapter.postMessage(threadId, { raw: text })
        return result.id
      } catch (fallbackErr) {
        console.error('[Telegram] postMessage failed:', (fallbackErr as Error).message)
        return null
      }
    }
  }

  // -----------------------------------------------------------------------
  // Outbound — edit (with overflow handling)
  // -----------------------------------------------------------------------

  async edit(
    channelId: string,
    messageId: string,
    text: string,
    overflowIds: string[] = [],
  ): Promise<EditResult | null> {
    try {
      const threadId = this.threadIdForChatId(channelId)
      const chunks = splitMessage(text, this.maxMessageLength)
      const resultIds: string[] = [messageId]

      await this.editMarkdown(threadId, messageId, chunks[0])

      for (let i = 1; i < chunks.length; i++) {
        const existingId = overflowIds[i - 1]
        if (existingId) {
          await this.editMarkdown(threadId, existingId, chunks[i])
          resultIds.push(existingId)
        } else {
          const sentId = await this.postMarkdown(threadId, chunks[i])
          resultIds.push(sentId ?? messageId)
        }
      }

      // Delete stale overflow messages (text shrunk).
      for (let i = chunks.length - 1; i < overflowIds.length; i++) {
        try {
          await this.adapter.deleteMessage(threadId, overflowIds[i])
        } catch {
          /* non-critical — message may already be gone */
        }
      }

      return { messageIds: resultIds }
    } catch (err) {
      console.error('[Telegram] edit failed:', (err as Error).message)
      return null
    }
  }

  private async editMarkdown(threadId: string, messageId: string, text: string): Promise<void> {
    try {
      await this.adapter.editMessage(threadId, messageId, { markdown: text })
    } catch {
      // Retry with raw text if MarkdownV2 parsing fails.
      await this.adapter.editMessage(threadId, messageId, { raw: text })
    }
  }

  // -----------------------------------------------------------------------
  // React
  // -----------------------------------------------------------------------

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const threadId = this.threadIdForChatId(channelId)
      await this.adapter.addReaction(threadId, messageId, emoji)
    } catch {
      // Reactions are non-critical.
    }
  }

  // -----------------------------------------------------------------------
  // Attachment resolution
  // -----------------------------------------------------------------------

  async resolveAttachment(attachment: Attachment): Promise<ResolvedAttachment | null> {
    if (!attachment.fileId) return null

    const fetcher = this.attachmentFetchers.get(attachment.fileId)
    if (!fetcher) {
      console.warn(`[Telegram] No fetcher cached for attachment ${attachment.fileId}`)
      return null
    }

    try {
      const buf = await fetcher()
      return {
        type: attachment.type,
        data: buf.toString('base64'),
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
      }
    } catch (err) {
      console.error('[Telegram] Failed to resolve attachment:', (err as Error).message)
      return null
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Build a chat-sdk threadId from a raw Telegram chat ID. */
  private threadIdForChatId(chatId: string): string {
    return this.adapter.encodeThreadId({ chatId })
  }

  private chatIdFromThreadId(threadId: string): string {
    return this.adapter.decodeThreadId(threadId).chatId
  }
}

// ---------------------------------------------------------------------------
// Attachment type mapping
// ---------------------------------------------------------------------------

function mapAttachmentType(
  chatType: ChatAttachment['type'],
  raw: TelegramRawMessageExt,
): Attachment['type'] {
  if (chatType === 'image') return 'photo'
  if (chatType === 'video') return 'video'
  if (chatType === 'audio') {
    // Telegram distinguishes voice notes from audio files.
    return raw.voice ? 'voice' : 'document'
  }
  return 'document'
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export const manifest: PluginManifest = {
  type: 'channel',
  name: 'telegram',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerChannel(
      new TelegramChannel({
        botToken: (cfg.bot_token as string | undefined) ?? ctx.env.TELEGRAM_BOT_TOKEN ?? '',
        ownerId: (cfg.owner_id as string | undefined) ?? '',
        allowedUsers: cfg.allowed_users as string[] | undefined,
        agent: cfg.agent as string | undefined,
        userName: (cfg.user_name as string | undefined) ?? ctx.env.TELEGRAM_BOT_USERNAME,
      }),
    )
  },
}
