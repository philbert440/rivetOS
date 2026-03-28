/**
 * Circuit Breaker — protects against cascading provider failures.
 *
 * States:
 *   CLOSED   — normal operation, requests pass through
 *   OPEN     — too many failures, requests rejected immediately
 *   HALF_OPEN — testing if provider recovered (one request allowed)
 *
 * Usage:
 *   const breaker = new CircuitBreaker('anthropic', { failureThreshold: 3 });
 *   if (breaker.canRequest()) {
 *     try { ... breaker.recordSuccess(); }
 *     catch (e) { breaker.recordFailure(); throw e; }
 *   }
 */

import { logger } from '../logger.js'

const log = logger('CircuitBreaker')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerConfig {
  /** Number of failures before opening (default: 5) */
  failureThreshold?: number
  /** Time in ms before trying half-open (default: 30000 = 30s) */
  resetTimeoutMs?: number
  /** Window in ms to count failures (default: 60000 = 60s) */
  failureWindowMs?: number
}

export interface CircuitBreakerStats {
  state: CircuitState
  failures: number
  successes: number
  lastFailure: number | null
  lastSuccess: number | null
  totalRequests: number
  totalFailures: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  readonly id: string
  private state: CircuitState = 'closed'
  private failures: { timestamp: number }[] = []
  private lastFailure: number | null = null
  private lastSuccess: number | null = null
  private totalRequests = 0
  private totalFailures = 0
  private totalSuccesses = 0
  private openedAt: number | null = null

  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly failureWindowMs: number

  constructor(id: string, config?: CircuitBreakerConfig) {
    this.id = id
    this.failureThreshold = config?.failureThreshold ?? 5
    this.resetTimeoutMs = config?.resetTimeoutMs ?? 30_000
    this.failureWindowMs = config?.failureWindowMs ?? 60_000
  }

  /**
   * Check if a request should be allowed through.
   * Returns true if circuit is closed or half-open (testing recovery).
   */
  canRequest(): boolean {
    this.totalRequests++

    if (this.state === 'closed') return true

    if (this.state === 'open') {
      // Check if enough time has passed to try half-open
      if (this.openedAt && Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'half_open'
        log.info(`${this.id}: half_open — testing recovery`)
        return true
      }
      return false
    }

    // half_open — allow one request through
    return true
  }

  /**
   * Record a successful request. Resets the circuit to closed.
   */
  recordSuccess(): void {
    this.totalSuccesses++
    this.lastSuccess = Date.now()

    if (this.state === 'half_open') {
      log.info(`${this.id}: closed — recovery confirmed`)
    }

    this.state = 'closed'
    this.failures = []
    this.openedAt = null
  }

  /**
   * Record a failed request. May trip the circuit to open.
   */
  recordFailure(): void {
    this.totalFailures++
    this.lastFailure = Date.now()
    const now = Date.now()

    if (this.state === 'half_open') {
      // Failed during recovery test — reopen
      this.state = 'open'
      this.openedAt = now
      log.warn(`${this.id}: open — recovery failed, reopened`)
      return
    }

    // Add failure to window
    this.failures.push({ timestamp: now })

    // Prune old failures outside the window
    this.failures = this.failures.filter((f) => now - f.timestamp < this.failureWindowMs)

    if (this.failures.length >= this.failureThreshold) {
      this.state = 'open'
      this.openedAt = now
      log.warn(
        `${this.id}: open — ${this.failures.length} failures in ${this.failureWindowMs}ms window`,
      )
    }
  }

  /**
   * Get current state and stats.
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures.length,
      successes: this.totalSuccesses,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
    }
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    return this.state
  }

  /**
   * Force reset to closed state. Use for manual recovery.
   */
  reset(): void {
    this.state = 'closed'
    this.failures = []
    this.openedAt = null
    log.info(`${this.id}: manually reset to closed`)
  }
}

// ---------------------------------------------------------------------------
// Registry — one breaker per provider
// ---------------------------------------------------------------------------

const breakers = new Map<string, CircuitBreaker>()

/**
 * Get or create a circuit breaker for a provider.
 */
export function getCircuitBreaker(
  providerId: string,
  config?: CircuitBreakerConfig,
): CircuitBreaker {
  let breaker = breakers.get(providerId)
  if (!breaker) {
    breaker = new CircuitBreaker(providerId, config)
    breakers.set(providerId, breaker)
  }
  return breaker
}

/**
 * Get all circuit breaker stats (for health endpoint).
 */
export function getAllCircuitBreakerStats(): Record<string, CircuitBreakerStats> {
  const stats: Record<string, CircuitBreakerStats> = {}
  for (const [id, breaker] of breakers) {
    stats[id] = breaker.getStats()
  }
  return stats
}

/**
 * Reset all circuit breakers.
 */
export function resetAllCircuitBreakers(): void {
  for (const breaker of breakers.values()) {
    breaker.reset()
  }
}
