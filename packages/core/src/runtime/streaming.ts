/**
 * StreamManager — handles streaming events from agent turns to channels.
 *
 * Rules:
 * 1. ONE streaming text message per turn — sent on first text, edited as more arrives
 * 2. Reasoning shown as inline italics in the SAME message (not separate)
 * 3. Tool calls in ONE consolidated log message (edited in-place)
 * 4. Status/progress updates edit the tool log (not separate messages)
 * 5. Final response EDITS the streaming message (no duplicate)
 * 6. Errors are the only thing that sends a NEW message mid-turn
 */

import type { Channel, InboundMessage, SessionState, StreamEvent } from '@rivetos/types';

// Throttle: don't edit more often than this
const EDIT_INTERVAL_MS = 600;
// Platform-safe text limit
const TEXT_LIMIT = 3800;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SessionStreamState {
  /** Main message being edited with text + reasoning */
  messageId: string | null;
  /** Accumulated response text */
  text: string;
  /** Accumulated reasoning text */
  reasoning: string;
  /** Whether an edit is scheduled */
  editPending: boolean;
  /** Timer for throttled edits */
  editTimer: ReturnType<typeof setTimeout> | null;
  /** Whether cleanup has been called (prevents post-cleanup edits) */
  cleaned: boolean;
  /** Tool log message ID */
  toolMessageId: string | null;
  /** Tool log lines */
  toolLines: string[];
}

function freshState(): SessionStreamState {
  return {
    messageId: null,
    text: '',
    reasoning: '',
    editPending: false,
    editTimer: null,
    cleaned: false,
    toolMessageId: null,
    toolLines: [],
  };
}

// ---------------------------------------------------------------------------
// StreamManager
// ---------------------------------------------------------------------------

export class StreamManager {
  private states: Map<string, SessionStreamState> = new Map();

  private get(key: string): SessionStreamState {
    let s = this.states.get(key);
    if (!s) { s = freshState(); this.states.set(key, s); }
    return s;
  }

  getStreamMessageId(key: string): string | null {
    return this.states.get(key)?.messageId ?? null;
  }

  handleStreamEvent(
    channel: Channel,
    message: InboundMessage,
    session: SessionState,
    event: StreamEvent,
  ): void {
    const key = `${message.channelId}:${message.userId}`;
    const s = this.get(key);
    if (s.cleaned) return; // Turn is over, ignore late events

    switch (event.type) {
      case 'text':
        s.text += event.content ?? '';
        this.throttledEdit(channel, message, s);
        break;

      case 'reasoning':
        if (!session.reasoningVisible) return;
        s.reasoning += event.content ?? '';
        this.throttledEdit(channel, message, s);
        break;

      case 'tool_start':
        if (!session.toolsVisible) return;
        s.toolLines.push(event.content);
        this.editToolLog(channel, message.channelId, s);
        break;

      case 'tool_result':
        if (!session.toolsVisible) return;
        if (s.toolLines.length > 0) {
          s.toolLines[s.toolLines.length - 1] = event.content;
        } else {
          s.toolLines.push(event.content);
        }
        this.editToolLog(channel, message.channelId, s);
        break;

      case 'status':
        // Progress updates go into the tool log, not separate messages
        s.toolLines.push(event.content);
        this.editToolLog(channel, message.channelId, s);
        break;

      case 'error':
        // Errors are the only thing that gets a separate message
        channel.send({ channelId: message.channelId, text: `⚠️ ${event.content}` }).catch(() => {});
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Text + reasoning → ONE message, throttled edits
  // -----------------------------------------------------------------------

  private throttledEdit(channel: Channel, message: InboundMessage, s: SessionStreamState): void {
    if (s.editPending || s.cleaned) return;
    s.editPending = true;

    s.editTimer = setTimeout(async () => {
      s.editPending = false;
      s.editTimer = null;
      if (s.cleaned) return; // Check again after timeout

      const display = this.buildDisplay(s);
      if (!display) return;

      const truncated = display.length > TEXT_LIMIT ? display.slice(0, TEXT_LIMIT) + '…' : display;

      if (s.messageId && channel.edit) {
        await channel.edit(message.channelId, s.messageId, truncated).catch(() => {});
      } else if (!s.messageId) {
        const sentId = await channel.send({
          channelId: message.channelId,
          text: truncated,
          replyToMessageId: message.id,
        }).catch(() => null);
        if (sentId) s.messageId = sentId;
      }
    }, EDIT_INTERVAL_MS);
  }

  private buildDisplay(s: SessionStreamState): string {
    let out = '';
    if (s.reasoning) {
      // Reasoning as italics, capped
      const r = s.reasoning.length > 1200 ? s.reasoning.slice(-1200) : s.reasoning;
      out += `_🧠 ${r}_\n\n`;
    }
    out += s.text;
    return out.trim();
  }

  // -----------------------------------------------------------------------
  // Tool log → ONE message, edited in-place
  // -----------------------------------------------------------------------

  private async editToolLog(channel: Channel, channelId: string, s: SessionStreamState): Promise<void> {
    if (s.cleaned) return;
    const display = s.toolLines.slice(-8).join('\n');

    if (s.toolMessageId && channel.edit) {
      await channel.edit(channelId, s.toolMessageId, display).catch(() => {});
    } else {
      const sentId = await channel.send({ channelId, text: display, silent: true }).catch(() => null);
      if (sentId) s.toolMessageId = sentId;
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup — returns messageId for final response edit
  // -----------------------------------------------------------------------

  cleanup(key: string): string | null {
    const s = this.states.get(key);
    if (!s) return null;

    s.cleaned = true; // Prevent any late edits
    if (s.editTimer) clearTimeout(s.editTimer);

    const messageId = s.messageId;
    this.states.delete(key);
    return messageId;
  }
}
