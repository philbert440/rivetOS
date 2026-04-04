/**
 * StreamManager — handles streaming events from agent turns to channels.
 *
 * Rules:
 * 1. ONE streaming text message per turn — sent on first text, edited as more arrives
 * 2. Overflow handling is the CHANNEL's job (edit() handles splitting internally)
 * 3. Reasoning shown as inline italics in the SAME message (not separate)
 * 4. Tool calls in ONE consolidated log message (edited in-place)
 * 5. Status/progress updates edit the tool log (not separate messages)
 * 6. Final response EDITS the streaming message (no duplicate)
 * 7. Errors are the only thing that sends a NEW message mid-turn
 */

import type { Channel, InboundMessage, SessionState, StreamEvent } from '@rivetos/types'

// Throttle: don't edit more often than this
const EDIT_INTERVAL_MS = 600

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SessionStreamState {
  /** Current streaming message ID (null until first text arrives) */
  messageId: string | null
  /** Accumulated text for the current turn */
  text: string
  /** Accumulated reasoning text */
  reasoning: string
  /** Whether an edit is scheduled */
  editPending: boolean
  /** Timer for throttled edits */
  editTimer: ReturnType<typeof setTimeout> | null
  /** Whether cleanup has been called (prevents post-cleanup edits) */
  cleaned: boolean
  /** Tool log message ID */
  toolMessageId: string | null
  /** Tool log lines */
  toolLines: string[]
  /** Whether current text is a "Thinking..." placeholder */
  thinkingPlaceholder: boolean
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
    thinkingPlaceholder: false,
  }
}

// ---------------------------------------------------------------------------
// StreamManager
// ---------------------------------------------------------------------------

export class StreamManager {
  private states: Map<string, SessionStreamState> = new Map()

  private get(key: string): SessionStreamState {
    let s = this.states.get(key)
    if (!s) {
      s = freshState()
      this.states.set(key, s)
    }
    return s
  }

  getStreamMessageId(key: string): string | null {
    return this.states.get(key)?.messageId ?? null
  }

  handleStreamEvent(
    channel: Channel,
    message: InboundMessage,
    session: SessionState,
    event: StreamEvent,
  ): void {
    const key = `${message.channelId}:${message.userId}`
    const s = this.get(key)
    if (s.cleaned) return // Turn is over, ignore late events

    switch (event.type) {
      case 'text':
        // Clear "thinking" placeholder if it was set
        if (s.thinkingPlaceholder) {
          s.text = ''
          s.thinkingPlaceholder = false
        }
        s.text += event.content ?? ''
        this.throttledEdit(channel, message, s)
        break

      case 'reasoning':
        if (!session.reasoningVisible) {
          // Even when hidden, show a one-time "thinking" indicator
          // so the user knows the model is working, not stalled
          if (!s.messageId && !s.text) {
            s.text = '🧠 _Thinking..._'
            this.throttledEdit(channel, message, s)
            s.thinkingPlaceholder = true
          }
          return
        }
        s.reasoning += event.content ?? ''
        this.throttledEdit(channel, message, s)
        break

      case 'tool_start':
        if (!session.toolsVisible) return
        s.toolLines.push(event.content)
        this.editToolLog(channel, message.channelId, s)
        break

      case 'tool_result':
        if (!session.toolsVisible) return
        if (s.toolLines.length > 0) {
          s.toolLines[s.toolLines.length - 1] = event.content
        } else {
          s.toolLines.push(event.content)
        }
        this.editToolLog(channel, message.channelId, s)
        break

      case 'status':
        // Progress updates go into the tool log, not separate messages
        s.toolLines.push(event.content)
        this.editToolLog(channel, message.channelId, s)
        break

      case 'error':
        // Errors are the only thing that gets a separate message
        channel.send({ channelId: message.channelId, text: `⚠️ ${event.content}` }).catch(() => {})
        break
    }
  }

  // -----------------------------------------------------------------------
  // Text + reasoning → single message, throttled edits
  // -----------------------------------------------------------------------

  private throttledEdit(channel: Channel, message: InboundMessage, s: SessionStreamState): void {
    if (s.editPending || s.cleaned) return
    s.editPending = true

    s.editTimer = setTimeout(() => {
      s.editPending = false
      s.editTimer = null
      if (s.cleaned) return

      const display = this.buildDisplay(s)
      if (!display) return

      if (s.messageId && channel.edit) {
        // Edit existing message — channel handles overflow if text is too long
        void channel
          .edit(message.channelId, s.messageId, display)
          .catch(() => null)
          .then((newId) => {
            if (newId) s.messageId = newId
          })
      } else if (!s.messageId) {
        // First text — send a new message
        void channel
          .send({
            channelId: message.channelId,
            text: display,
            replyToMessageId: message.id,
          })
          .catch(() => null)
          .then((sentId) => {
            if (sentId) s.messageId = sentId
          })
      }
    }, EDIT_INTERVAL_MS)
  }

  private buildDisplay(s: SessionStreamState): string {
    let out = ''
    if (s.reasoning) {
      // Reasoning as italics, capped to avoid huge messages
      const r = s.reasoning.length > 1200 ? s.reasoning.slice(-1200) : s.reasoning
      out += `_🧠 ${r}_\n\n`
    }
    out += s.text
    return out.trim()
  }

  // -----------------------------------------------------------------------
  // Tool log → ONE message, edited in-place
  // -----------------------------------------------------------------------

  private editToolLog(channel: Channel, channelId: string, s: SessionStreamState): void {
    if (s.cleaned) return
    const display = s.toolLines.slice(-8).join('\n')

    if (s.toolMessageId && channel.edit) {
      void channel.edit(channelId, s.toolMessageId, display).catch(() => {})
    } else {
      void channel
        .send({ channelId, text: display, silent: true })
        .catch(() => null)
        .then((sentId) => {
          if (sentId) s.toolMessageId = sentId
        })
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup — returns last messageId and accumulated text
  // -----------------------------------------------------------------------

  cleanup(key: string): { messageId: string | null; accumulatedText: string } {
    const s = this.states.get(key)
    if (!s) return { messageId: null, accumulatedText: '' }

    s.cleaned = true // Prevent any late edits
    if (s.editTimer) clearTimeout(s.editTimer)

    const { messageId, text } = s
    this.states.delete(key)
    return { messageId, accumulatedText: text }
  }
}
