/**
 * Unit tests for circuit-breaker.ts — deterministic state machine for LLM failure tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  shouldSkip,
  recordFailure,
  recordSuccess,
  recordTerminal,
  resetBreaker,
  breakerThreshold,
  breakerKey,
  logBreakerSkip,
} from './circuit-breaker.js'

describe('circuit-breaker', () => {
  beforeEach(() => {
    resetBreaker()
  })

  afterEach(() => {
    resetBreaker()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('breakerKey', () => {
    it('scopes entries per conversation and kind', () => {
      expect(breakerKey('conv-1', 'leaf')).toBe('conv-1:leaf')
      expect(breakerKey('conv-1', 'branch')).toBe('conv-1:branch')
      expect(breakerKey('conv-1', 'root')).toBe('conv-1:root')
    })
  })

  describe('recordFailure', () => {
    it('should increment failure count from 0', () => {
      const failures = recordFailure('conv-1', 'leaf')
      expect(failures).toBe(1)
    })

    it('should increment failure count on subsequent calls', () => {
      expect(recordFailure('conv-2', 'leaf')).toBe(1)
      expect(recordFailure('conv-2', 'leaf')).toBe(2)
      expect(recordFailure('conv-2', 'leaf')).toBe(3)
    })

    it('should track multiple conversations independently', () => {
      expect(recordFailure('conv-a', 'leaf')).toBe(1)
      expect(recordFailure('conv-b', 'leaf')).toBe(1)
      expect(recordFailure('conv-a', 'leaf')).toBe(2)
      expect(recordFailure('conv-b', 'leaf')).toBe(2)
      expect(recordFailure('conv-a', 'leaf')).toBe(3)
    })

    it('should track levels of the same conversation independently', () => {
      expect(recordFailure('conv-lvl', 'leaf')).toBe(1)
      expect(recordFailure('conv-lvl', 'branch')).toBe(1)
      expect(recordFailure('conv-lvl', 'leaf')).toBe(2)
      expect(recordFailure('conv-lvl', 'branch')).toBe(2)
      recordFailure('conv-lvl', 'branch')
      expect(shouldSkip('conv-lvl', 'leaf')).toBe(false)
      expect(shouldSkip('conv-lvl', 'branch')).toBe(true)
    })

    it('should update lastFailAt on each call', () => {
      const now = Date.now()
      recordFailure('conv-time', 'leaf')
      expect(shouldSkip('conv-time', 'leaf')).toBe(false) // not yet at threshold

      recordFailure('conv-time', 'leaf')
      expect(shouldSkip('conv-time', 'leaf')).toBe(false)

      vi.useFakeTimers()
      vi.setSystemTime(now + 100)
      recordFailure('conv-time', 'leaf')
      vi.useRealTimers()
    })
  })

  describe('shouldSkip', () => {
    it('should return false for conversation with no failures', () => {
      expect(shouldSkip('conv-never-failed', 'leaf')).toBe(false)
    })

    it('should return false for conversation below threshold', () => {
      recordFailure('conv-below', 'leaf')
      recordFailure('conv-below', 'leaf')
      expect(shouldSkip('conv-below', 'leaf')).toBe(false)
    })

    it('should return true once threshold is reached', () => {
      recordFailure('conv-at-threshold', 'leaf')
      recordFailure('conv-at-threshold', 'leaf')
      recordFailure('conv-at-threshold', 'leaf')
      expect(shouldSkip('conv-at-threshold', 'leaf')).toBe(true)
    })

    it('should return true after threshold is exceeded', () => {
      recordFailure('conv-over', 'leaf')
      recordFailure('conv-over', 'leaf')
      recordFailure('conv-over', 'leaf')
      recordFailure('conv-over', 'leaf')
      expect(shouldSkip('conv-over', 'leaf')).toBe(true)
    })

    it('should return false after reset window expires', () => {
      vi.useFakeTimers()
      const now = Date.now()

      recordFailure('conv-reset', 'leaf')
      recordFailure('conv-reset', 'leaf')
      recordFailure('conv-reset', 'leaf')
      expect(shouldSkip('conv-reset', 'leaf')).toBe(true)

      vi.setSystemTime(now + 3_600_001)
      expect(shouldSkip('conv-reset', 'leaf')).toBe(false)
    })

    it('should return true if still within reset window', () => {
      vi.useFakeTimers()
      const now = Date.now()

      recordFailure('conv-window', 'leaf')
      recordFailure('conv-window', 'leaf')
      recordFailure('conv-window', 'leaf')
      expect(shouldSkip('conv-window', 'leaf')).toBe(true)

      vi.setSystemTime(now + 1_800_000)
      expect(shouldSkip('conv-window', 'leaf')).toBe(true)
    })
  })

  describe('recordSuccess', () => {
    it('should reset an entry with no prior failures', () => {
      recordSuccess('conv-clean', 'leaf')
      expect(shouldSkip('conv-clean', 'leaf')).toBe(false)
    })

    it('should clear an entry below threshold', () => {
      recordFailure('conv-clear-below', 'leaf')
      recordFailure('conv-clear-below', 'leaf')
      recordSuccess('conv-clear-below', 'leaf')
      expect(shouldSkip('conv-clear-below', 'leaf')).toBe(false)
    })

    it('should clear an entry at threshold', () => {
      recordFailure('conv-clear-threshold', 'leaf')
      recordFailure('conv-clear-threshold', 'leaf')
      recordFailure('conv-clear-threshold', 'leaf')
      expect(shouldSkip('conv-clear-threshold', 'leaf')).toBe(true)

      recordSuccess('conv-clear-threshold', 'leaf')
      expect(shouldSkip('conv-clear-threshold', 'leaf')).toBe(false)
    })

    it('should allow failure counter to start fresh after success', () => {
      recordFailure('conv-fresh', 'leaf')
      recordFailure('conv-fresh', 'leaf')
      recordFailure('conv-fresh', 'leaf')
      recordSuccess('conv-fresh', 'leaf')

      const failures = recordFailure('conv-fresh', 'leaf')
      expect(failures).toBe(1)
    })

    it('does not clear a sibling level', () => {
      recordFailure('conv-sib', 'branch')
      recordFailure('conv-sib', 'branch')
      recordFailure('conv-sib', 'branch')
      expect(shouldSkip('conv-sib', 'branch')).toBe(true)

      recordSuccess('conv-sib', 'leaf')
      expect(shouldSkip('conv-sib', 'branch')).toBe(true)
      expect(shouldSkip('conv-sib', 'leaf')).toBe(false)
    })
  })

  describe('recordTerminal', () => {
    it('opens shouldSkip immediately without needing THRESHOLD failures', () => {
      recordTerminal('conv-4xx', 'branch')
      expect(shouldSkip('conv-4xx', 'branch')).toBe(true)
      expect(shouldSkip('conv-4xx', 'leaf')).toBe(false)
    })

    it('does not expire after the 1-hour transient window', () => {
      vi.useFakeTimers()
      const now = Date.now()
      recordTerminal('conv-perm', 'root')
      vi.setSystemTime(now + 3_600_001)
      expect(shouldSkip('conv-perm', 'root')).toBe(true)
    })

    it('clears on recordSuccess', () => {
      recordTerminal('conv-fix', 'branch')
      recordSuccess('conv-fix', 'branch')
      expect(shouldSkip('conv-fix', 'branch')).toBe(false)
    })
  })

  describe('logBreakerSkip', () => {
    it('emits a JSON payload with event=circuit_breaker_skip', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      recordFailure('conv-log', 'leaf')
      recordFailure('conv-log', 'leaf')
      recordFailure('conv-log', 'leaf')
      logBreakerSkip('conv-log', 'leaf')
      expect(warn).toHaveBeenCalledOnce()
      const line = String(warn.mock.calls[0]?.[0])
      expect(line).toContain('circuit-breaker skip')
      expect(line).toContain('"event":"circuit_breaker_skip"')
      expect(line).toContain('"kind":"leaf"')
      expect(line).toContain('"conversationId":"conv-log"')
      expect(line).toContain('"terminal":false')
    })
  })

  describe('threshold constant', () => {
    it('should expose breakerThreshold', () => {
      expect(breakerThreshold).toBe(3)
    })
  })

  describe('integration: open → half-open → closed transition', () => {
    it('should transition from closed to open to closed', () => {
      vi.useFakeTimers()
      const now = Date.now()

      expect(shouldSkip('conv-transition', 'leaf')).toBe(false)

      recordFailure('conv-transition', 'leaf')
      recordFailure('conv-transition', 'leaf')
      recordFailure('conv-transition', 'leaf')
      expect(shouldSkip('conv-transition', 'leaf')).toBe(true)

      vi.setSystemTime(now + 3_600_001)
      expect(shouldSkip('conv-transition', 'leaf')).toBe(false)

      const failures = recordFailure('conv-transition', 'leaf')
      expect(failures).toBe(1)
    })

    it('should re-open if half-open fails again within reset window', () => {
      vi.useFakeTimers()
      const now = Date.now()

      recordFailure('conv-flaky', 'leaf')
      recordFailure('conv-flaky', 'leaf')
      recordFailure('conv-flaky', 'leaf')
      expect(shouldSkip('conv-flaky', 'leaf')).toBe(true)

      vi.setSystemTime(now + 3_600_001)
      expect(shouldSkip('conv-flaky', 'leaf')).toBe(false)

      recordFailure('conv-flaky', 'leaf')
      recordFailure('conv-flaky', 'leaf')
      recordFailure('conv-flaky', 'leaf')
      expect(shouldSkip('conv-flaky', 'leaf')).toBe(true)
    })
  })
})
