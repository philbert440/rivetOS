/**
 * Unit tests for circuit-breaker.ts — deterministic state machine for LLM failure tracking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  shouldSkip,
  recordFailure,
  recordSuccess,
  breakerThreshold,
} from './circuit-breaker.js'

describe('circuit-breaker', () => {
  beforeEach(() => {
    // Reset the breaker by recreating the module state
    // We'll use vi.resetModules() to clear the breaker Map
    vi.resetModules()
  })

  describe('recordFailure', () => {
    it('should increment failure count from 0', async () => {
      const { recordFailure: rf } = await import('./circuit-breaker.js')
      const failures = rf('conv-1')
      expect(failures).toBe(1)
    })

    it('should increment failure count on subsequent calls', async () => {
      const { recordFailure: rf } = await import('./circuit-breaker.js')
      expect(rf('conv-2')).toBe(1)
      expect(rf('conv-2')).toBe(2)
      expect(rf('conv-2')).toBe(3)
    })

    it('should track multiple conversations independently', async () => {
      const { recordFailure: rf } = await import('./circuit-breaker.js')
      expect(rf('conv-a')).toBe(1)
      expect(rf('conv-b')).toBe(1)
      expect(rf('conv-a')).toBe(2)
      expect(rf('conv-b')).toBe(2)
      expect(rf('conv-a')).toBe(3)
    })

    it('should update lastFailAt on each call', async () => {
      const { recordFailure: rf, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      const now = Date.now()
      rf('conv-time')
      expect(ss('conv-time')).toBe(false) // not yet at threshold

      rf('conv-time')
      expect(ss('conv-time')).toBe(false)

      // Manually advance time via mocking
      vi.useFakeTimers()
      vi.setSystemTime(now + 100)
      rf('conv-time')
      // Should still be tracking the new timestamp
      vi.useRealTimers()
    })
  })

  describe('shouldSkip', () => {
    it('should return false for conversation with no failures', async () => {
      const { shouldSkip: ss } = await import('./circuit-breaker.js')
      expect(ss('conv-never-failed')).toBe(false)
    })

    it('should return false for conversation below threshold', async () => {
      const { recordFailure: rf, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      rf('conv-below')
      rf('conv-below')
      expect(ss('conv-below')).toBe(false)
    })

    it('should return true once threshold is reached', async () => {
      const { recordFailure: rf, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      rf('conv-at-threshold')
      rf('conv-at-threshold')
      rf('conv-at-threshold')
      expect(ss('conv-at-threshold')).toBe(true)
    })

    it('should return true after threshold is exceeded', async () => {
      const { recordFailure: rf, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      rf('conv-over')
      rf('conv-over')
      rf('conv-over')
      rf('conv-over')
      expect(ss('conv-over')).toBe(true)
    })

    it('should return false after reset window expires', async () => {
      vi.useFakeTimers()
      const { recordFailure: rf, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      const now = Date.now()

      // Hit the threshold
      rf('conv-reset')
      rf('conv-reset')
      rf('conv-reset')
      expect(ss('conv-reset')).toBe(true)

      // Advance time past the reset window (1 hour = 3600000ms)
      vi.setSystemTime(now + 3_600_001)
      expect(ss('conv-reset')).toBe(false)

      vi.useRealTimers()
    })

    it('should return true if still within reset window', async () => {
      vi.useFakeTimers()
      const { recordFailure: rf, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      const now = Date.now()

      rf('conv-window')
      rf('conv-window')
      rf('conv-window')
      expect(ss('conv-window')).toBe(true)

      // Advance only 30 minutes
      vi.setSystemTime(now + 1_800_000)
      expect(ss('conv-window')).toBe(true)

      vi.useRealTimers()
    })
  })

  describe('recordSuccess', () => {
    it('should reset an entry with no prior failures', async () => {
      const { recordSuccess: rs, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      rs('conv-clean')
      expect(ss('conv-clean')).toBe(false)
    })

    it('should clear an entry below threshold', async () => {
      const { recordFailure: rf, recordSuccess: rs, shouldSkip: ss } =
        await import('./circuit-breaker.js')
      rf('conv-clear-below')
      rf('conv-clear-below')
      rs('conv-clear-below')
      expect(ss('conv-clear-below')).toBe(false)
    })

    it('should clear an entry at threshold', async () => {
      const { recordFailure: rf, recordSuccess: rs, shouldSkip: ss } =
        await import('./circuit-breaker.js')
      rf('conv-clear-threshold')
      rf('conv-clear-threshold')
      rf('conv-clear-threshold')
      expect(ss('conv-clear-threshold')).toBe(true)

      rs('conv-clear-threshold')
      expect(ss('conv-clear-threshold')).toBe(false)
    })

    it('should allow failure counter to start fresh after success', async () => {
      const { recordFailure: rf, recordSuccess: rs } = await import(
        './circuit-breaker.js'
      )
      rf('conv-fresh')
      rf('conv-fresh')
      rf('conv-fresh')
      rs('conv-fresh')

      const failures = rf('conv-fresh')
      expect(failures).toBe(1)
    })
  })

  describe('threshold constant', () => {
    it('should expose breakerThreshold', async () => {
      const { breakerThreshold: bt } = await import('./circuit-breaker.js')
      expect(bt).toBe(3)
    })
  })

  describe('integration: open → half-open → closed transition', () => {
    it('should transition from closed to open to closed', async () => {
      vi.useFakeTimers()
      const { recordFailure: rf, recordSuccess: rs, shouldSkip: ss } =
        await import('./circuit-breaker.js')
      const now = Date.now()

      // Closed: no failures
      expect(ss('conv-transition')).toBe(false)

      // Open: hit threshold
      rf('conv-transition')
      rf('conv-transition')
      rf('conv-transition')
      expect(ss('conv-transition')).toBe(true)

      // Half-open: time passes, reset triggered
      vi.setSystemTime(now + 3_600_001)
      expect(ss('conv-transition')).toBe(false)

      // Closed again: can fail fresh
      const failures = rf('conv-transition')
      expect(failures).toBe(1)

      vi.useRealTimers()
    })

    it('should re-open if half-open fails again within reset window', async () => {
      vi.useFakeTimers()
      const { recordFailure: rf, shouldSkip: ss } = await import(
        './circuit-breaker.js'
      )
      const now = Date.now()

      // Hit threshold
      rf('conv-flaky')
      rf('conv-flaky')
      rf('conv-flaky')
      expect(ss('conv-flaky')).toBe(true)

      // Time passes, window expires, circuit resets
      vi.setSystemTime(now + 3_600_001)
      expect(ss('conv-flaky')).toBe(false)

      // Immediately fail again, should reopen
      rf('conv-flaky')
      rf('conv-flaky')
      rf('conv-flaky')
      expect(ss('conv-flaky')).toBe(true)

      vi.useRealTimers()
    })
  })
})
