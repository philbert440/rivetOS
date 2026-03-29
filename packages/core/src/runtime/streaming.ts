/**
 * StreamManager — handles streaming events from agent turns to channels.
 *
 * Design:
 * - Text streams into a SINGLE message that gets edited progressively
 * - The final response EDITS that same message (no duplicate)
 * - Reasoning appears as inline italics within the streamed message
 * - Tool calls show in a consolidated log message
 * - Everything cleans up after the turn
 */

import type { Channel, InboundMessage, SessionState, StreamEvent } from '@rivetos/types';
import { logger } from '../logger.js';

const log = logger('StreamManager');

// How often to edit the streaming message (ms)
const EDIT_INTERVAL = 800;
// Platform-safe text limit (leaves room for HTML)
const TEXT_LIMIT = 3800;

// ---------------------------------------------------------------------------
// Stream State per session
// ---------------------------------------------------------------------------

interface SessionStreamState {
  /** The message being edited with streaming text */
  messageId: string | null;
  /** Accumulated text from the LLM */
  textBuffer: string;
  /** Accumulated reasoning (shown inline as italics) */
  reasoningBuffer: string;
  /** Pending edit timer */
  editTimer: ReturnType<typeof setTimeout> | null;
  /** Tool call log lines */
  toolLogLines: string[];
  /** Tool log message ID */
  toolLogMessageId: string | null;
}

function createState(): SessionStreamState {
  return {
    messageId: null,
    textBuffer: '',
    reasoningBuffer: '',
    editTimer: null,
    toolLogLines: [],
    toolLogMessageId: null,
  };
}

// ---------------------------------------------------------------------------
// StreamManager
// ---------------------------------------------------------------------------

export class StreamManager {
  private state: Map<string, SessionStreamState> = new Map();

  private getState(sessionKey: string): SessionStreamState {
    let ss = this.state.get(sessionKey);
    if (!ss) {
      ss = createState();
      this.state.set(sessionKey, ss);
    }
    return ss;
  }

  /**
   * Get the streaming message ID (so the runtime can edit it with the final response).
   */
  getStreamMessageId(sessionKey: string): string | null {
    return this.state.get(sessionKey)?.messageId ?? null;
  }

  /**
   * Handle a stream event from the agent loop.
   */
  handleStreamEvent(
    channel: Channel,
    message: InboundMessage,
    session: SessionState,
    event: StreamEvent,
  ): void {
    const sessionKey = `${message.channelId}:${message.userId}`;
    const ss = this.getState(sessionKey);

    switch (event.type) {
      case 'text': {
        ss.textBuffer += event.content ?? '';
        this.scheduleEdit(channel, message, ss);
        break;
      }

      case 'reasoning': {
        if (!session.reasoningVisible) return;
        // Reasoning accumulates — will be included as italics in the next edit
        ss.reasoningBuffer += event.content ?? '';
        this.scheduleEdit(channel, message, ss);
        break;
      }

      case 'tool_start': {
        if (!session.toolsVisible) return;
        ss.toolLogLines.push(event.content);
        this.updateToolLog(channel, message.channelId, ss);
        break;
      }

      case 'tool_result': {
        if (!session.toolsVisible) return;
        // Replace last line with result
        if (ss.toolLogLines.length > 0) {
          ss.toolLogLines[ss.toolLogLines.length - 1] = event.content;
        } else {
          ss.toolLogLines.push(event.content);
        }
        this.updateToolLog(channel, message.channelId, ss);
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
   * Build the display text: reasoning (italics) + text content.
   */
  private buildDisplayText(ss: SessionStreamState): string {
    let display = '';

    if (ss.reasoningBuffer) {
      // Show reasoning as italics, truncated to keep it manageable
      const reasoning = ss.reasoningBuffer.length > 1500
        ? ss.reasoningBuffer.slice(0, 1500) + '…'
        : ss.reasoningBuffer;
      display += `_${reasoning}_\n\n`;
    }

    display += ss.textBuffer;
    return display;
  }

  /**
   * Schedule a throttled edit to the streaming message.
   */
  private scheduleEdit(channel: Channel, message: InboundMessage, ss: SessionStreamState): void {
    if (ss.editTimer) return; // Already scheduled

    ss.editTimer = setTimeout(async () => {
      ss.editTimer = null;
      const display = this.buildDisplayText(ss);
      if (!display) return;

      if (ss.messageId && channel.edit) {
        // Edit existing streaming message
        const truncated = display.length > TEXT_LIMIT
          ? display.slice(0, TEXT_LIMIT) + '…'
          : display;
        await channel.edit(message.channelId, ss.messageId, truncated).catch(() => {});
      } else if (!ss.messageId) {
        // First chunk — send new message
        const preview = display.length > 200 ? display.slice(0, 200) + '…' : display;
        const sentId = await channel.send({
          channelId: message.channelId,
          text: preview,
          replyToMessageId: message.id,
        }).catch(() => null);
        if (sentId) {
          ss.messageId = sentId;
        }
      }
    }, EDIT_INTERVAL);
  }

  /**
   * Update the consolidated tool log message.
   */
  private async updateToolLog(channel: Channel, channelId: string, ss: SessionStreamState): Promise<void> {
    const display = ss.toolLogLines.slice(-10).join('\n');

    if (ss.toolLogMessageId && channel.edit) {
      await channel.edit(channelId, ss.toolLogMessageId, display).catch(() => {});
    } else {
      const sentId = await channel.send({ channelId, text: display, silent: true }).catch(() => null);
      if (sentId) ss.toolLogMessageId = sentId;
    }
  }

  /**
   * Clean up stream state. Returns the messageId so the runtime can edit it with the final response.
   */
  cleanup(sessionKey: string): string | null {
    const ss = this.state.get(sessionKey);
    if (!ss) return null;

    const messageId = ss.messageId;

    if (ss.editTimer) {
      clearTimeout(ss.editTimer);
    }

    this.state.delete(sessionKey);
    return messageId;
  }
}
