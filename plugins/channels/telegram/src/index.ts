/**
 * @rivetos/channel-telegram
 *
 * Reference channel implementation. Telegram Bot API via grammY.
 * Supports: text, photos, voice, documents, inline buttons, reactions,
 * reply threading, slash commands, message editing (for streaming).
 * Sends typing indicator while the agent is processing.
 */

import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import type {
  Channel,
  InboundMessage,
  OutboundMessage,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramChannelConfig {
  botToken: string;
  allowedUsers?: string[];
  ownerId: string;
  /** Agent to route messages to (for channel binding) */
  agent?: string;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class TelegramChannel implements Channel {
  id: string;
  platform = 'telegram';

  private bot: Bot;
  private config: TelegramChannelConfig;
  private messageHandler?: (message: InboundMessage) => Promise<void>;
  private commandHandler?: (command: string, args: string, message: InboundMessage) => Promise<void>;

  /** Active typing intervals per chat — cleared when a turn ends */
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(config: TelegramChannelConfig) {
    this.config = config;
    this.id = `telegram:${config.ownerId}`;
    this.bot = new Bot(config.botToken);
    this.setupHandlers();
  }

  // -----------------------------------------------------------------------
  // Setup
  // -----------------------------------------------------------------------

  private setupHandlers(): void {
    // Global middleware — catches EVERY update for debugging
    this.bot.use(async (ctx, next) => {
      console.log(`[Telegram] Update type=${ctx.updateType} text="${ctx.message?.text?.slice(0, 30) ?? ''}" from=${ctx.from?.id}`);
      await next();
    });

    const commands = ['start', 'new', 'stop', 'interrupt', 'steer', 'status', 'model', 'think', 'reasoning', 'tools'];

    for (const cmd of commands) {
      this.bot.command(cmd, (ctx) => this.handleCommand(ctx, cmd));
    }

    // Callback queries (button presses)
    this.bot.on('callback_query:data', async (ctx) => {
      if (!this.isAllowed(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized' });
        return;
      }
      // Route callback data as a command if it starts with /
      const data = ctx.callbackQuery.data;
      if (data.startsWith('/')) {
        const [cmd, ...rest] = data.slice(1).split(/\s+/);
        const msg = this.buildInbound(ctx);
        if (msg && this.commandHandler) {
          await this.commandHandler(cmd, rest.join(' '), msg);
        }
      }
      await ctx.answerCallbackQuery();
    });

    // All non-command messages
    this.bot.on('message', (ctx) => {
      // Skip if it's a command (already handled by bot.command above)
      if (ctx.message?.text?.startsWith('/')) return;
      this.handleMessage(ctx);
    });
  }

  private async handleMessage(ctx: Context): Promise<void> {
    console.log(`[Telegram] Received: from=${ctx.from?.id} text="${ctx.message?.text?.slice(0, 50) ?? '(no text)'}"`);
    
    if (!this.isAllowed(String(ctx.from?.id))) {
      console.log(`[Telegram] User ${ctx.from?.id} not in allowlist, ignoring`);
      return;
    }
    const msg = this.buildInbound(ctx);
    if (msg && this.messageHandler) {
      this.startTyping(msg.channelId);
      try {
        await this.messageHandler(msg);
      } catch (err: any) {
        console.error(`[Telegram] Handler error:`, err);
        try {
          await ctx.reply(`⚠️ Error: ${err.message}`);
        } catch {}
      } finally {
        this.stopTyping(msg.channelId);
      }
    } else {
      console.log(`[Telegram] No handler registered: handler=${!!this.messageHandler} msg=${!!msg}`);
    }
  }

  private async handleCommand(ctx: Context, command: string): Promise<void> {
    if (!this.isAllowed(String(ctx.from?.id))) return;
    const msg = this.buildInbound(ctx);
    if (!msg) return;
    const args = ctx.message?.text?.replace(`/${command}`, '').trim() ?? '';
    if (this.commandHandler) {
      await this.commandHandler(command, args, msg);
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
    this.stopTyping(chatId);

    // Send immediately, then repeat
    this.sendTypingAction(chatId);
    const interval = setInterval(() => this.sendTypingAction(chatId), 4000);
    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  private sendTypingAction(chatId: string): void {
    this.bot.api.sendChatAction(chatId, 'typing').catch(() => {
      // Silently ignore typing failures — non-critical
    });
  }

  // -----------------------------------------------------------------------
  // Access Control
  // -----------------------------------------------------------------------

  private isAllowed(userId: string): boolean {
    if (!this.config.allowedUsers?.length) return true;
    return this.config.allowedUsers.includes(userId) || userId === this.config.ownerId;
  }

  // -----------------------------------------------------------------------
  // Inbound Message
  // -----------------------------------------------------------------------

  private buildInbound(ctx: Context): InboundMessage | null {
    const from = ctx.from;
    const chat = ctx.chat;
    const msg = ctx.message;
    if (!from || !chat) return null;

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
    };

    if (msg?.reply_to_message) {
      inbound.replyToMessageId = String(msg.reply_to_message.message_id);
    }

    // Attachments
    if (msg?.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      inbound.attachments = [{ type: 'photo', fileId: largest.file_id, width: largest.width, height: largest.height }];
    }
    if (msg?.voice) {
      inbound.attachments = [{ type: 'voice', fileId: msg.voice.file_id, duration: msg.voice.duration }];
    }
    if (msg?.document) {
      inbound.attachments = [{ type: 'document', fileId: msg.document.file_id, fileName: msg.document.file_name, mimeType: msg.document.mime_type }];
    }

    return inbound;
  }

  // -----------------------------------------------------------------------
  // Outbound
  // -----------------------------------------------------------------------

  async send(msg: OutboundMessage): Promise<string | null> {
    try {
      const text = msg.text ?? '';
      const keyboard = msg.buttons ? this.buildKeyboard(msg.buttons) : undefined;

      // Split long messages (Telegram limit: 4096 chars)
      if (text.length > 4096) {
        const chunks = this.splitMessage(text, 4096);
        let lastId: string | null = null;
        for (let i = 0; i < chunks.length; i++) {
          const sent = await this.bot.api.sendMessage(msg.channelId, chunks[i], {
            reply_parameters: i === 0 && msg.replyToMessageId ? { message_id: Number(msg.replyToMessageId) } : undefined,
            reply_markup: i === chunks.length - 1 ? keyboard : undefined,
            disable_notification: msg.silent,
          });
          lastId = String(sent.message_id);
        }
        return lastId;
      }

      const sent = await this.bot.api.sendMessage(msg.channelId, text, {
        reply_parameters: msg.replyToMessageId ? { message_id: Number(msg.replyToMessageId) } : undefined,
        reply_markup: keyboard,
        disable_notification: msg.silent,
      });
      return String(sent.message_id);
    } catch (err: any) {
      // Retry without formatting
      try {
        const sent = await this.bot.api.sendMessage(msg.channelId, msg.text ?? '', {
          reply_parameters: msg.replyToMessageId ? { message_id: Number(msg.replyToMessageId) } : undefined,
          disable_notification: msg.silent,
        });
        return String(sent.message_id);
      } catch (retryErr: any) {
        console.error('[Telegram] Send failed:', retryErr.message);
        return null;
      }
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline near the limit
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt === -1 || splitAt < maxLen * 0.5) {
        splitAt = maxLen;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  async edit(channelId: string, messageId: string, text: string): Promise<boolean> {
    try {
      await this.bot.api.editMessageText(channelId, Number(messageId), text);
      return true;
    } catch {
      return false;
    }
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.bot.api.setMessageReaction(channelId, Number(messageId), [
        { type: 'emoji', emoji: emoji as any },
      ]);
    } catch {
      // Reaction failures are non-critical
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildKeyboard(buttons: import('@rivetos/types').Button[][]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const row of buttons) {
      for (const btn of row) {
        kb.text(btn.text, btn.callbackData);
      }
      kb.row();
    }
    return kb;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(handler: (command: string, args: string, message: InboundMessage) => Promise<void>): void {
    this.commandHandler = handler;
  }

  async start(): Promise<void> {
    // Catch polling errors
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
    });

    this.bot.start({
      drop_pending_updates: true,
      onStart: (info) => console.log(`[Telegram] Bot started: @${info.username}`),
    });
  }

  async stop(): Promise<void> {
    // Clear all typing intervals
    for (const [chatId] of this.typingIntervals) {
      this.stopTyping(chatId);
    }
    this.bot.stop();
  }
}
