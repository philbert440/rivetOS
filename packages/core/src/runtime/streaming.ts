/**
 * StreamManager — handles streaming events from agent turns to channels.
 *
 * Rules:
 * 1. ONE streaming text message per turn — sent on first text, edited as more arrives
 * 2. When text approaches the platform message limit, freeze the current message
 *    and start a NEW message (message chain). Prevents truncation on Telegram/Discord.
 * 3. Reasoning shown as inline italics in the SAME message (not separate)
 * 4. Tool calls in ONE consolidated log message (edited in-place)
 * 5. Status/progress updates edit the tool log (not separate messages)
 * 6. Final response EDITS the last streaming message (no duplicate)
 * 7. Errors are the only thing that sends a NEW message mid-turn
 */

import type { Channel, InboundMessage, SessionState, StreamEvent } from '@rivetos/types';

// Throttle: don't edit more often than this
const EDIT_INTERVAL_MS = 600;
// Default message limit if channel doesn't specify (conservative)
const DEFAULT_MAX_LENGTH = 2000;
// Freeze threshold — freeze current message at this % of the limit
const FREEZE_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SessionStreamState {
  /** Chain of message IDs (newest = last) */
  messageIds: string[];
  /** Text accumulated in the CURRENT (active) message */
  currentText: string;
  /** All text accumulated across the entire chain (for cleanup return) */
  fullText: string;
  /** Accumulated reasoning text (only in current message) */
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
  /** Whether current text is a "Thinking..." placeholder */
  thinkingPlaceholder: boolean;
  /** Platform max message length (set when first event arrives) */
  maxLength: number;
}

function freshState(maxLength: number): SessionStreamState {
  return {
    messageIds: [],
    currentText: '',
    fullText: '',
    reasoning: '',
    editPending: false,
    editTimer: null,
    cleaned: false,
    toolMessageId: null,
    toolLines: [],
    thinkingPlaceholder: false,
    maxLength,
  };
}

// ---------------------------------------------------------------------------
// StreamManager
// ---------------------------------------------------------------------------

export class StreamManager {
  private states: Map<string, SessionStreamState> = new Map();

  private get(key: string, maxLength: number): SessionStreamState {
    let s = this.states.get(key);
    if (!s) { s = freshState(maxLength); this.states.set(key, s); }
    return s;
  }

  getStreamMessageId(key: string): string | null {
    const s = this.states.get(key);
    if (!s || s.messageIds.length === 0) return null;
    // Return the last (active) message ID
    return s.messageIds[s.messageIds.length - 1];
  }

  handleStreamEvent(
    channel: Channel,
    message: InboundMessage,
    session: SessionState,
    event: StreamEvent,
  ): void {
    const key = `${message.channelId}:${message.userId}`;
    const maxLength = channel.maxMessageLength ?? DEFAULT_MAX_LENGTH;
    const s = this.get(key, maxLength);
    if (s.cleaned) return; // Turn is over, ignore late events

    switch (event.type) {
      case 'text':
        // Clear "thinking" placeholder if it was set
        if (s.thinkingPlaceholder) {
          s.currentText = '';
          s.thinkingPlaceholder = false;
        }
        s.currentText += event.content ?? '';
        s.fullText += event.content ?? '';
        this.throttledEdit(channel, message, s);
        break;

      case 'reasoning':
        if (!session.reasoningVisible) {
          // Even when hidden, show a one-time "thinking" indicator
          // so the user knows the model is working, not stalled
          if (s.messageIds.length === 0 && !s.currentText) {
            s.currentText = '🧠 _Thinking..._';
            this.throttledEdit(channel, message, s);
            s.thinkingPlaceholder = true;
          }
          return;
        }
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
  // Text + reasoning → message chain, throttled edits
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

      const freezeAt = Math.floor(s.maxLength * FREEZE_THRESHOLD);

      // Check if we need to freeze the current message and start a new one
      if (display.length > freezeAt && s.messageIds.length > 0) {
        // Find a clean break point near the freeze threshold
        const breakPoint = this.findBreakPoint(s.currentText, freezeAt - this.reasoningOverhead(s));

        if (breakPoint > 0 && breakPoint < s.currentText.length) {
          // Freeze: edit current message with text up to breakpoint
          const frozenText = s.currentText.slice(0, breakPoint);
          const frozenDisplay = this.buildDisplayWith(s, frozenText);
          const currentMsgId = s.messageIds[s.messageIds.length - 1];

          if (currentMsgId && channel.edit) {
            await channel.edit(message.channelId, currentMsgId, frozenDisplay).catch(() => {});
          }

          // Start fresh — carry over the remainder
          const remainder = s.currentText.slice(breakPoint).trimStart();
          s.currentText = remainder;
          s.reasoning = ''; // Reasoning stays with the first message

          // Send a new message for the continuation
          const sentId = await channel.send({
            channelId: message.channelId,
            text: remainder.length > s.maxLength ? remainder.slice(0, s.maxLength) : remainder,
          }).catch(() => null);
          if (sentId) s.messageIds.push(sentId);
          return;
        }
      }

      // Normal edit — truncate if somehow still over (safety net)
      const truncated = display.length > s.maxLength ? display.slice(0, s.maxLength - 1) + '…' : display;
      const currentMsgId = s.messageIds.length > 0 ? s.messageIds[s.messageIds.length - 1] : null;

      if (currentMsgId && channel.edit) {
        await channel.edit(message.channelId, currentMsgId, truncated).catch(() => {});
      } else if (!currentMsgId) {
        const sentId = await channel.send({
          channelId: message.channelId,
          text: truncated,
          replyToMessageId: message.id,
        }).catch(() => null);
        if (sentId) s.messageIds.push(sentId);
      }
    }, EDIT_INTERVAL_MS);
  }

  /** Find a clean paragraph or line break near the target position */
  private findBreakPoint(text: string, target: number): number {
    if (target <= 0 || target >= text.length) return -1;

    // Try paragraph break first
    let breakAt = text.lastIndexOf('\n\n', target);
    if (breakAt > target * 0.5) return breakAt;

    // Then single newline
    breakAt = text.lastIndexOf('\n', target);
    if (breakAt > target * 0.5) return breakAt;

    // Then sentence end
    breakAt = text.lastIndexOf('. ', target);
    if (breakAt > target * 0.5) return breakAt + 1; // Include the period

    // Hard cut as last resort
    return target;
  }

  /** Calculate how many chars reasoning takes in the display */
  private reasoningOverhead(s: SessionStreamState): number {
    if (!s.reasoning) return 0;
    const r = s.reasoning.length > 1200 ? 1200 : s.reasoning.length;
    return r + 10; // "_🧠 " + "_\n\n"
  }

  private buildDisplay(s: SessionStreamState): string {
    return this.buildDisplayWith(s, s.currentText);
  }

  private buildDisplayWith(s: SessionStreamState, text: string): string {
    let out = '';
    if (s.reasoning) {
      // Reasoning as italics, capped
      const r = s.reasoning.length > 1200 ? s.reasoning.slice(-1200) : s.reasoning;
      out += `_🧠 ${r}_\n\n`;
    }
    out += text;
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
  // Cleanup — returns last messageId and full accumulated text
  // -----------------------------------------------------------------------

  cleanup(key: string): { messageId: string | null; accumulatedText: string; messageIds: string[] } {
    const s = this.states.get(key);
    if (!s) return { messageId: null, accumulatedText: '', messageIds: [] };

    s.cleaned = true; // Prevent any late edits
    if (s.editTimer) clearTimeout(s.editTimer);

    const messageId = s.messageIds.length > 0 ? s.messageIds[s.messageIds.length - 1] : null;
    const accumulatedText = s.fullText;
    const messageIds = [...s.messageIds];
    this.states.delete(key);
    return { messageId, accumulatedText, messageIds };
  }
}
