import type { MemoryHealthResponse } from '@rivetos/types'

export const HEALTH_REFRESH_MS = 120_000
export const HEALTH_STALE_MS = 180_000

/** Older servers without observation times cannot establish current health. */
export function memoryHealthState(
  health: MemoryHealthResponse | undefined,
  failed: boolean,
  now = Date.now(),
): {
  tone: 'good' | 'warn' | 'bad'
  label: string
  stale: boolean
} {
  const observed = health?.observedAt ? Date.parse(health.observedAt) : NaN
  const stale = !Number.isFinite(observed) || now - observed > HEALTH_STALE_MS
  if (failed) return { tone: 'bad', label: 'Health check unavailable', stale: true }
  if (!health) return { tone: 'warn', label: 'Checking memory', stale: true }
  if (stale) return { tone: 'warn', label: 'Health observation is stale', stale }
  if (health.status !== 'ok') return { tone: 'warn', label: 'Memory needs attention', stale }
  if (health.capture?.status === 'unknown' || health.queueStatus !== 'available')
    return { tone: 'good', label: 'Observed checks OK · partial coverage', stale }
  return { tone: 'good', label: 'Memory checks OK', stale }
}
