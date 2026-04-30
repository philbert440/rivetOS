/**
 * Message Queue — handles messages arriving while a turn is active.
 *
 * ONE behavior. No modes. No config.
 *
 * 1. Commands (/stop, /interrupt, /steer, etc.) → execute immediately
 * 2. Turn active → queue the message, process after current turn
 * 3. Idle → process immediately
 *
 * Keep it simple.
 */

import type { InboundMessage, QueuedMessage, RuntimeCommand } from '@rivetos/types'
import { COMMAND_NAMES } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Command Detection — reads from the shared COMMAND_REGISTRY
// ---------------------------------------------------------------------------

export function isCommand(text: string): text is `/${RuntimeCommand}` {
  if (!text.startsWith('/')) return false
  const cmd = text.slice(1).split(/\s+/)[0]
  return COMMAND_NAMES.has(cmd)
}

export function parseCommand(text: string): { command: RuntimeCommand; args: string } | null {
  if (!text.startsWith('/')) return null
  const parts = text.slice(1).split(/\s+/)
  const cmd = parts[0]
  if (!COMMAND_NAMES.has(cmd)) return null
  return { command: cmd as RuntimeCommand, args: parts.slice(1).join(' ') }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export class MessageQueue {
  private queue: QueuedMessage[] = []
  private processing = false
  private handler?: (message: InboundMessage) => Promise<void>

  /**
   * Set the handler that processes messages.
   * Called when a queued message is ready to be processed.
   */
  setHandler(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  /**
   * Whether a turn is currently being processed.
   */
  get isProcessing(): boolean {
    return this.processing
  }

  /**
   * Enqueue a message. If idle, processes immediately.
   * If a turn is active, queues for later.
   */
  async enqueue(message: InboundMessage): Promise<void> {
    if (this.processing) {
      this.queue.push({ message, receivedAt: Date.now() })
      return
    }

    await this.process(message)
  }

  /**
   * Mark a turn as active. Messages arriving now will be queued.
   */
  beginTurn(): void {
    this.processing = true
  }

  /**
   * Mark a turn as complete. Process any queued messages.
   */
  async endTurn(): Promise<void> {
    this.processing = false
    await this.drainQueue()
  }

  /**
   * Number of messages waiting.
   */
  get depth(): number {
    return this.queue.length
  }

  /**
   * Clear all queued messages (used by /stop, /new).
   */
  clear(): void {
    this.queue = []
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async process(message: InboundMessage): Promise<void> {
    if (!this.handler) return
    this.processing = true
    try {
      await this.handler(message)
    } finally {
      this.processing = false
      await this.drainQueue()
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.processing) {
      const next = this.queue.shift()
      if (next) {
        await this.process(next.message)
      }
    }
  }
}
