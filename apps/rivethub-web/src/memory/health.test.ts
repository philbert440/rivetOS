import { expect, it } from 'vitest'
import { memoryHealthState, HEALTH_STALE_MS } from './health.js'
import type { MemoryHealthResponse } from '@rivetos/types'
const now = Date.now()
const healthy: MemoryHealthResponse = { status: 'ok', embeddings: { status: 'ok' }, embedQueueDepth: 50, observedAt: new Date(now).toISOString(), queueStatus: 'available' }
it('does not mistake a normal backlog for a failure', () => {
  expect(memoryHealthState(healthy, false, now).tone).toBe('good')
})
it('makes stale, failed and partial observations visible', () => {
  expect(memoryHealthState(healthy, false, now + HEALTH_STALE_MS + 1).stale).toBe(true)
  expect(memoryHealthState(healthy, true, now).tone).toBe('bad')
  expect(memoryHealthState({ ...healthy, observedAt: undefined }, false, now).stale).toBe(true)
  expect(memoryHealthState({ ...healthy, capture: { status: 'unknown', impact: 'Not measured' } }, false, now).label).toContain('partial')
  expect(memoryHealthState({ ...healthy, status: 'degraded' }, false, now).label).toContain('attention')
})
