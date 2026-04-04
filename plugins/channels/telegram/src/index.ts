// TODO: Add integration tests (see rivetos-full-review-final.md #12)

/**
 * @rivetos/channel-telegram
 *
 * Reference channel implementation. Telegram Bot API via grammY.
 * Supports: text, photos, voice, documents, inline buttons, reactions,
 * reply threading, slash commands, message editing (for streaming).
 * Sends typing indicator while the agent is processing.
 *
 * 409 Conflict handling: if another bot instance is polling the same
 * token, retries with backoff instead of crashing. Gives up after 5
 * consecutive conflicts within 60 seconds.
 */

import { Bot, Context, InlineKeyboard, _ } from 'grammy'
import type {
  Channel,
  InboundMessage,
  OutboundMessage,
  Attachment,
  ResolvedAttachment,
} from '@rivetos/types'
import { splitMessage } from '@rivetos/types'
import { markdownToTelegramHtml } from './format.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramChannelConfig {
  botToken: string
  allowedUsers?: string[]
  ownerId: string
  /** Agent to route messages to (for channel binding) */
  agent?: string
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class TelegramChannel implements Channel {
  id: string
  platform = 'telegram'
  maxMessageLength = 4096

  private bot: Bot
  private config: TelegramChannelConfig
  private messageHandler?: (message: InboundMessage) => Promise<void>
  private commandHandler?: (command: string, args: string, message: InboundMessage) => Promise<void>

  /** Active typing intervals per chat — cleared when a turn ends */
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map()

  /** 409 conflict tracking — retry with backoff, give up after threshold */
  private conflict409Count = 0
  private conflict409FirstTime = 0
  private static readonly MAX_409_RETRIES = 5
  private static readonly CONFLICT_WINDOW_MS = 60_000
  private static readonly RETRY_DELAY_MS = 5_000

  constructor(config: TelegramChannelConfig) {
    this.config = config
    this.id = `telegram:${config.ownerId}`
    this.bot = new Bot(config.botToken)
    this.setupHandlers()
  }

  // -----------------------------------------------------------------------
  // Setup
  // -----------------------------------------------------------------------

  private setupHandlers(): void {
    // Global middleware — catches EVERY update for debugging + resets conflict counter
    this.bot.use(async (ctx, next) => {
      const updateType = ctx.message
        ? 'message'
        : ctx.callbackQuery
          ? 'callback_query'
          : ctx.editedMessage
            ? 'edited_message'
            : 'other'
      console.log(
        `[Telegram] Update type=${updateType} text="${ctx.message?.text?.slice(0, 30) ?? ''}" from=${ctx.from?.id}`,
      )
      // Successful update received — reset conflict counter
      this.conflict409Count = 0
      await next()
    })

    const commands = [
      'start',
      'new',
      'stop',
      'interrupt',
      'steer',
      'status',
      'model',
      'think',
      'reasoning',
      'tools',
    ]

    for (const cmd of commands) {
      this.bot.command(cmd, (ctx) => this.handleCommand(ctx, cmd))
    }

    // Callback queries (button presses)
    this.bot.on('callback_query:data', async (ctx) => {
      if (!this.isAllowed(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized' })
        return
      }
      // Route callback data as a command if it starts with /
      const data = ctx.callbackQuery.data
      if (data.startsWith('/')) {
        const [cmd, ...rest] = data.slice(1).split(/\s+/)
        const msg = this.buildInbound(ctx)
        if (msg && this.commandHandler) {
          await this.commandHandler(cmd, rest.join(' '), msg)
        }
      }
      await ctx.answerCallbackQuery()
    })

    // All non-command messages
    this.bot.on('message', (ctx) => {
      // Skip if it's a command (already handled by bot.command above)
      if (ctx.message?.text?.startsWith('/')) return
      void this.handleMessage(ctx)
    })
  }

  private async handleMessage(ctx: Context): Promise<void> {
    console.log(
      `[Telegram] Received: from=${ctx.from?.id} text="${ctx.message?.text?.slice(0, 50) ?? '(no text)'}"`,
    )

    if (!this.isAllowed(String(ctx.from?.id))) {
      console.log(`[Telegram] User ${ctx.from?.id} not in allowlist, ignoring`)
      return
    }
    const msg = this.buildInbound(ctx)
    if (msg && this.messageHandler) {
      const chatId = String(ctx.chat!.id)
      this.startTyping(chatId)
      try {
        await this.messageHandler(msg)
      } catch (err: unknown) {
        console.error(`[Telegram] Handler error:`, err)
        try {
          await ctx.reply(`⚠️ Error: ${(err as Error).message}`)
        } catch {
          /* non-critical */
        }
      } finally {
        this.stopTyping(chatId)
      }
    } else {
      console.log(`[Telegram] No handler registered: handler=${!!this.messageHandler} msg=${!!msg}`)
    }
  }

  private async handleCommand(ctx: Context, command: string): Promise<void> {
    if (!this.isAllowed(String(ctx.from?.id))) return
    const msg = this.buildInbound(ctx)
    if (!msg) return
    const args = ctx.message?.text?.replace(`/${command}`, '').trim() ?? ''
    if (this.commandHandler) {
      await this.commandHandler(command, args, msg)
    }
  }

  // -----------------------------------------------------------------------
  // Typing Indicator
  // -----------------------------------------------------------------------

  /**
   * Start sending "typing" action every 4 seconds.
   * Telegram's typing indicator expires after ~5 seconds, so 4s keeps it alive.
   */
  private startTyping(chatId: string): void {
    // Clear any existing interval for this chat
    this.stopTyping(chatId)

    // Send immediately, then repeat
    this.sendTypingAction(chatId)
    const interval = setInterval(() => this.sendTypingAction(chatId), 4000)
    this.typingIntervals.set(chatId, interval)
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(chatId)
    }
  }

  private sendTypingAction(chatId: string): void {
    this.bot.api.sendChatAction(chatId, 'typing').catch(() => {
      // Silently ignore typing failures — non-critical
    })
  }

  // -----------------------------------------------------------------------
  // Access Control
  // -----------------------------------------------------------------------

  private isAllowed(userId: string): boolean {
    if (!this.config.allowedUsers?.length) return true
    return this.config.allowedUsers.includes(userId) || userId === this.config.ownerId
  }

  // -----------------------------------------------------------------------
  // Inbound Message
  // -----------------------------------------------------------------------

  private buildInbound(ctx: Context): InboundMessage | null {
    const from = ctx.from
    const chat = ctx.chat
    const msg = ctx.message
    if (!from || !chat) return null

    const inbound: InboundMessage = {
      id: String(msg?.message_id ?? ctx.callbackQuery?.message?.message_id ?? Date.now()),
      userId: String(from.id),
      username: from.username,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' '),
      channelId: String(chat.id),
      chatType: chat.type,
      text: msg?.text ?? msg?.caption ?? '',
      platform: 'telegram',
      agent: this.config.agent,
      timestamp: msg?.date ?? Math.floor(Date.now() / 1000),
    }

    if (msg?.reply_to_message) {
      inbound.replyToMessageId = String(msg.reply_to_message.message_id)
    }

    // Attachments
    if (msg?.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1]
      inbound.attachments = [
        { type: 'photo', fileId: largest.file_id, width: largest.width, height: largest.height },
      ]
    }
    if (msg?.voice) {
      inbound.attachments = [
        { type: 'voice', fileId: msg.voice.file_id, duration: msg.voice.duration },
      ]
    }
    if (msg?.document) {
      inbound.attachments = [
        {
          type: 'document',
          fileId: msg.document.file_id,
          fileName: msg.document.file_name,
          mimeType: msg.document.mime_type,
        },
      ]
    }

    return inbound
  }

  // -----------------------------------------------------------------------
  // Outbound
  // -----------------------------------------------------------------------

  async send(msg: OutboundMessage): Promise<string | null> {
    const raw = msg.text ?? ''
    if (!raw) return null

    const html = markdownToTelegramHtml(raw)
    const keyboard = msg.buttons ? this.buildKeyboard(msg.buttons) : undefined

    // Split long messages (Telegram limit: 4096 chars)
    const chunks = splitMessage(html, 4096)
    let lastId: string | null = null

    for (let i = 0; i < chunks.length; i++) {
      lastId = await this.sendHtml(msg.channelId, chunks[i], {
        replyToMessageId: i === 0 ? msg.replyToMessageId : undefined,
        keyboard: i === chunks.length - 1 ? keyboard : undefined,
        silent: msg.silent,
      })
    }

    return lastId
  }

  /** Send HTML with fallback to plain text */
  private async sendHtml(
    chatId: string,
    html: string,
    options?: { replyToMessageId?: string; keyboard?: InlineKeyboard; silent?: boolean },
  ): Promise<string | null> {
    try {
      const sent = await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_parameters: options?.replyToMessageId
          ? { message_id: Number(options.replyToMessageId) }
          : undefined,
        reply_markup: options?.keyboard,
        disable_notification: options?.silent,
      })
      return String(sent.message_id)
    } catch {
      // HTML formatting failed — retry as plain text (strip tags)
      try {
        const sent = await this.bot.api.sendMessage(chatId, html.replace(/<[^>]+>/g, ''), {
          reply_parameters: options?.replyToMessageId
            ? { message_id: Number(options.replyToMessageId) }
            : undefined,
          reply_markup: options?.keyboard,
          disable_notification: options?.silent,
        })
        return String(sent.message_id)
      } catch (err: unknown) {
        console.error('[Telegram] Send failed:', (err as Error).message)
        return null
      }
    }
  }

  async edit(channelId: string, messageId: string, text: string): Promise<string | null> {
    try {
      if (text.length <= this.maxMessageLength) {
        // Fits in one message — simple edit
        await this.editHtml(channelId, messageId, text)
        return messageId
      }

      // Overflow: split, edit current message with first chunk, send rest as new messages
      const html = markdownToTelegramHtml(text)
      const chunks = splitMessage(html, this.maxMessageLength)

      await this.editHtml(channelId, messageId, chunks[0])

      let lastId: string = messageId
      for (let i = 1; i < chunks.length; i++) {
        const sentId = await this.sendHtml(channelId, chunks[i])
        if (sentId) lastId = sentId
      }
      return lastId
    } catch {
      return null
    }
  }

  /** Edit a single message with HTML, falling back to plain text */
  private async editHtml(channelId: string, messageId: string, text: string): Promise<void> {
    const html = markdownToTelegramHtml(text)
    try {
      await this.bot.api.editMessageText(channelId, Number(messageId), html, {
        parse_mode: 'HTML',
      })
    } catch {
      // Retry without formatting
      await this.bot.api.editMessageText(channelId, Number(messageId), text)
    }
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.bot.api.setMessageReaction(channelId, Number(messageId), [
        { type: 'emoji' as const, emoji },
      ])
    } catch {
      // Reaction failures are non-critical
    }
  }

  // -----------------------------------------------------------------------
  // Attachment Resolution
  // -----------------------------------------------------------------------

  async resolveAttachment(attachment: Attachment): Promise<ResolvedAttachment | null> {
    if (!attachment.fileId) return null

    try {
      // Get file info from Telegram
      const file = await this.bot.api.getFile(attachment.fileId)
      if (!file.file_path) return null

      // Download the file
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`
      const response = await fetch(fileUrl)
      if (!response.ok) return null

      const buffer = await response.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')

      // Infer MIME type from file path
      const ext = file.file_path.split('.').pop()?.toLowerCase()
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        mp4: 'video/mp4',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        pdf: 'application/pdf',
      }

      return {
        type: attachment.type,
        data: base64,
        mimeType: attachment.mimeType ?? mimeMap[ext ?? ''] ?? 'application/octet-stream',
        fileName: attachment.fileName ?? file.file_path.split('/').pop(),
      }
    } catch (err: unknown) {
      console.error(`[Telegram] Failed to resolve attachment: ${(err as Error).message}`)
      return null
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildKeyboard(buttons: import('@rivetos/types').Button[][]): InlineKeyboard {
    const kb = new InlineKeyboard()
    for (const row of buttons) {
      for (const btn of row) {
        kb.text(btn.text, btn.callbackData)
      }
      kb.row()
    }
    return kb
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
    // Catch polling errors — handle 409 conflicts with retry
    this.bot.catch(async (err: unknown) => {
      const errObj = err as { error?: { description?: string }; message?: string }
      const errMsg = String(errObj?.error?.description ?? errObj?.message ?? err)

      // 409 Conflict: another bot instance is polling the same token
      if (
        errMsg.includes('409') ||
        errMsg.includes('Conflict') ||
        errMsg.includes('terminated by other')
      ) {
        this.conflict409Count++
        if (this.conflict409Count === 1) {
          this.conflict409FirstTime = Date.now()
        }

        console.error(
          `[Telegram] 409 Conflict — another instance is polling this bot token (${this.conflict409Count} consecutive)`,
        )

        // Too many in a short window? Give up — something else is running.
        const elapsed = Date.now() - this.conflict409FirstTime
        if (
          this.conflict409Count >= TelegramChannel.MAX_409_RETRIES &&
          elapsed < TelegramChannel.CONFLICT_WINDOW_MS
        ) {
          console.error(
            `[Telegram] Too many 409 conflicts (${this.conflict409Count} in ${Math.round(elapsed / 1000)}s) — another bot instance is likely running. Stopping.`,
          )
          return
        }

        // Retry: stop polling, wait, restart
        console.log(`[Telegram] Retrying in ${TelegramChannel.RETRY_DELAY_MS / 1000}s...`)
        try {
          void this.bot.stop()
        } catch {
          /* non-critical */
        }
        await new Promise((r) => setTimeout(r, TelegramChannel.RETRY_DELAY_MS))
        try {
          await this.bot.start({
            drop_pending_updates: true,
            onStart: (info) => console.log(`[Telegram] Bot restarted after 409: @${info.username}`),
          })
        } catch (restartErr: unknown) {
          console.error(`[Telegram] Failed to restart after 409:`, (restartErr as Error).message)
        }
        return
      }

      // 401 Unauthorized — invalid token, no point retrying
      if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
        console.error('[Telegram] 401 Unauthorized — bot token is invalid. Stopping.')
        return
      }

      // All other errors — log and continue (don't crash)
      console.error('[Telegram] Bot error:', err)
    })

    await this.bot.start({
      drop_pending_updates: true,
      onStart: (info) => console.log(`[Telegram] Bot started: @${info.username}`),
    })
  }

  async stop(): Promise<void> {
    // Clear all typing intervals
    for (const [chatId] of this.typingIntervals) {
      this.stopTyping(chatId)
    }
    await this.bot.stop()
  }
}
