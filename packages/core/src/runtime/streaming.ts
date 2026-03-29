/**
 * Stream Manager — owns all streaming state and stream-to-channel logic.
 *
 * Handles buffering, throttling, and sending streaming events (text,
 * reasoning, tool logs) to channels via edit/send.
 */

import type { Channel, InboundMessage, SessionState, StreamEvent } from '@rivetos/types';
import { logger } from '../logger.js';

const log = logger('StreamManager');

/** Safe character limit for streaming message edits (leaves room for HTML overhead) */
const STREAM_TEXT_LIMIT = 3800;

// ---------------------------------------------------------------------------
// Per-session stream state
// ---------------------------------------------------------------------------

export interface SessionStreamState {
  messageId: string | null;
  textBuffer: string;
  textTimer: ReturnType<typeof setTimeout> | null;
  reasoningBuffer: string;
  reasoningTimer: ReturnType<typeof setTimeout> | null;
  toolLogMessageId: string | null;
  toolLogLines: string[];
}

// ---------------------------------------------------------------------------
// Stream Manager
// ---------------------------------------------------------------------------

export class StreamManager {
  private streamState: Map<string, SessionStreamState> = new Map();

  /**
   * Get the streaming message ID for a session (used by runtime to decide
   * whether to edit the existing message or send a new one for the final response).
   */
  getStreamMessageId(sessionKey: string): string | null {
    return this.streamState.get(sessionKey)?.messageId ?? null;
  }

  /**
   * Handle a stream event — routes to the appropriate channel operation.
   */
  handleStreamEvent(
    channel: Channel,
    message: InboundMessage,
    session: SessionState,
    event: StreamEvent,
  ): void {
    const sessionKey = `${message.channelId}:${message.userId}`;
    const ss = this.getOrCreate(sessionKey);

    switch (event.type) {
      case 'text': {
        ss.textBuffer += event.content ?? '';

        if (!ss.textTimer) {
          ss.textTimer = setTimeout(async () => {
            ss.textTimer = null;
            const text = ss.textBuffer;
            if (!text) return;

            // Buffer exceeds platform limit — finalize current message, start fresh
            if (text.length > STREAM_TEXT_LIMIT && ss.messageId && channel.edit) {
              await channel.edit(message.channelId, ss.messageId, text.slice(0, STREAM_TEXT_LIMIT)).catch(() => {});
              ss.messageId = null;
              ss.textBuffer = text.slice(STREAM_TEXT_LIMIT);
              return;
            }

            if (ss.messageId && channel.edit) {
              await channel.edit(message.channelId, ss.messageId, text).catch(() => {});
            } else if (!ss.messageId) {
              const sentId = await channel.send({
                channelId: message.channelId,
                text: text.slice(0, 200) + '…',
                replyToMessageId: message.id,
              }).catch(() => null);
              if (sentId) {
                ss.messageId = sentId;
              }
            }
          }, 500);
        }
        break;
      }

      case 'reasoning': {
        if (!session.reasoningVisible) return;
        ss.reasoningBuffer += event.content ?? '';

        if (!ss.reasoningTimer) {
          ss.reasoningTimer = setTimeout(async () => {
            ss.reasoningTimer = null;
            const buffered = ss.reasoningBuffer;
            ss.reasoningBuffer = '';
            if (buffered) {
              const display = buffered.length > 2000 ? buffered.slice(0, 2000) + '…' : buffered;
              channel.send({
                channelId: message.channelId,
                text: `🧠 ${display}`,
                silent: true,
              }).catch(() => {});
            }
          }, 2000);
        }
        break;
      }

      case 'tool_start': {
        if (!session.toolsVisible) return;
        ss.toolLogLines.push(event.content);
        this.updateToolLog(channel, message.channelId, sessionKey);
        break;
      }

      case 'tool_result': {
        if (!session.toolsVisible) return;
        if (ss.toolLogLines.length > 0) {
          ss.toolLogLines[ss.toolLogLines.length - 1] = event.content;
        } else {
          ss.toolLogLines.push(event.content);
        }
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
   * Clean up streaming state after a turn completes.
   * Clears timers and removes the state entry.
   */
  cleanupStreamState(sessionKey: string): void {
    const ss = this.streamState.get(sessionKey);
    if (ss) {
      if (ss.textTimer) clearTimeout(ss.textTimer);
      if (ss.reasoningTimer) clearTimeout(ss.reasoningTimer);
    }
    this.streamState.delete(sessionKey);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private getOrCreate(sessionKey: string): SessionStreamState {
    let state = this.streamState.get(sessionKey);
    if (!state) {
      state = {
        messageId: null,
        textBuffer: '',
        textTimer: null,
        reasoningBuffer: '',
        reasoningTimer: null,
        toolLogMessageId: null,
        toolLogLines: [],
      };
      this.streamState.set(sessionKey, state);
    }
    return state;
  }

  private async updateToolLog(channel: Channel, channelId: string, sessionKey: string): Promise<void> {
    const ss = this.getOrCreate(sessionKey);
    const display = ss.toolLogLines.slice(-10).join('\n');

    if (ss.toolLogMessageId && channel.edit) {
      await channel.edit(channelId, ss.toolLogMessageId, display).catch(() => {});
    } else {
      const sentId = await channel.send({
        channelId,
        text: display,
        silent: true,
      });
      if (sentId) {
        ss.toolLogMessageId = sentId;
      }
    }
  }
}
