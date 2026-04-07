/**
 * Reconnection Manager — wraps channels with exponential backoff retry logic.
 *
 * When a channel disconnects or fails to start, the reconnection manager
 * retries with exponential backoff (1s, 2s, 4s, 8s... up to maxDelay).
 *
 * Usage:
 *   const reconnector = new ReconnectionManager();
 *   reconnector.wrap(channel, { maxRetries: 10 });
 *   // Now channel.start() will auto-retry on failure
 */

import { ChannelError } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('Reconnect')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ReconnectConfig {
  /** Max retries before giving up (default: Infinity — never give up) */
  maxRetries?: number
  /** Initial delay in ms (default: 1000) */
  initialDelayMs?: number
  /** Maximum delay in ms (default: 60000 = 60s) */
  maxDelayMs?: number
  /** Jitter factor 0-1 (default: 0.2) — adds randomness to prevent thundering herd */
  jitter?: number
  /** Callback when reconnect succeeds */
  onReconnect?: (channelId: string, attempt: number) => void
  /** Callback when all retries exhausted */
  onGiveUp?: (channelId: string, error: Error) => void
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ReconnectState {
  channelId: string
  attempt: number
  active: boolean
  timer: ReturnType<typeof setTimeout> | null
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ReconnectionManager {
  private states: Map<string, ReconnectState> = new Map()
  private config: Required<ReconnectConfig>

  constructor(config?: ReconnectConfig) {
    this.config = {
      maxRetries: config?.maxRetries ?? Infinity,
      initialDelayMs: config?.initialDelayMs ?? 1000,
      maxDelayMs: config?.maxDelayMs ?? 60_000,
      jitter: config?.jitter ?? 0.2,
      onReconnect: config?.onReconnect ?? (() => {}),
      onGiveUp: config?.onGiveUp ?? (() => {}),
    }
  }

  /**
   * Start reconnection loop for a channel.
   *
   * @param channelId — identifier for logging
   * @param startFn — the function that starts the channel (e.g., channel.start())
   */
  async reconnect(channelId: string, startFn: () => Promise<void>): Promise<void> {
    // Cancel any existing reconnection for this channel
    this.cancel(channelId)

    const state: ReconnectState = {
      channelId,
      attempt: 0,
      active: true,
      timer: null,
    }
    this.states.set(channelId, state)

    while (state.active && state.attempt < this.config.maxRetries) {
      state.attempt++
      const delay = this.calculateDelay(state.attempt)

      log.info(`${channelId}: reconnecting in ${Math.round(delay)}ms (attempt ${state.attempt})`)

      await this.sleep(delay, state)

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- active can be mutated during async sleep
      if (!state.active) break

      try {
        await startFn()
        log.info(`${channelId}: reconnected on attempt ${state.attempt}`)
        this.config.onReconnect(channelId, state.attempt)
        this.states.delete(channelId)
        return
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err))
        log.warn(`${channelId}: reconnect attempt ${state.attempt} failed — ${error.message}`)

        if (state.attempt >= this.config.maxRetries) {
          log.error(`${channelId}: exhausted ${this.config.maxRetries} retries, giving up`)
          this.config.onGiveUp(
            channelId,
            new ChannelError(
              'CHANNEL_DISCONNECTED',
              `Reconnection failed after ${state.attempt} attempts`,
              {
                channelId,
                cause: error,
              },
            ),
          )
          this.states.delete(channelId)
          return
        }
      }
    }
  }

  /**
   * Cancel reconnection for a channel.
   */
  cancel(channelId: string): void {
    const state = this.states.get(channelId)
    if (state) {
      state.active = false
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = null
      }
      this.states.delete(channelId)
      log.debug(`${channelId}: reconnection cancelled`)
    }
  }

  /**
   * Cancel all active reconnections.
   */
  cancelAll(): void {
    for (const channelId of this.states.keys()) {
      this.cancel(channelId)
    }
  }

  /**
   * Check if a channel is currently reconnecting.
   */
  isReconnecting(channelId: string): boolean {
    return this.states.has(channelId)
  }

  /**
   * Get status of all reconnection attempts.
   */
  getStatus(): Record<string, { attempt: number; active: boolean }> {
    const status: Record<string, { attempt: number; active: boolean }> = {}
    for (const [id, state] of this.states) {
      status[id] = { attempt: state.attempt, active: state.active }
    }
    return status
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private calculateDelay(attempt: number): number {
    // Exponential backoff: initialDelay * 2^(attempt-1)
    const exponentialDelay = this.config.initialDelayMs * Math.pow(2, attempt - 1)
    const capped = Math.min(exponentialDelay, this.config.maxDelayMs)

    // Add jitter
    const jitterRange = capped * this.config.jitter
    const jitter = (Math.random() - 0.5) * 2 * jitterRange

    return Math.max(0, capped + jitter)
  }

  private sleep(ms: number, state: ReconnectState): Promise<void> {
    return new Promise((resolve) => {
      state.timer = setTimeout(() => {
        state.timer = null
        resolve()
      }, ms)
    })
  }
}
