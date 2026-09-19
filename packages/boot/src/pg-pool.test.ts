import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  POOL_END_TIMEOUT_MS,
  cleanupAfterBootFailure,
  createEndSharedPool,
  createSharedPgPool,
  resolvePgPoolMax,
} from './pg-pool.js'

const DUMMY_URL = 'postgres://user:pass@localhost:5432/db'

const pools: Array<{ end: () => Promise<void> }> = []
afterEach(async () => {
  vi.useRealTimers()
  const pending = pools.splice(0)
  await Promise.all(pending.map((p) => p.end().catch(() => undefined)))
})

describe('resolvePgPoolMax', () => {
  it('defaults to 8 when unset or empty', () => {
    expect(resolvePgPoolMax({})).toBe(8)
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: '' })).toBe(8)
  })

  it('honours a numeric override', () => {
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: '12' })).toBe(12)
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: '4' })).toBe(4)
  })

  it('clamps values below 4 to 4', () => {
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: '3' })).toBe(4)
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: '0' })).toBe(4)
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: '-2' })).toBe(4)
  })

  it('falls back to 8 for non-numeric garbage', () => {
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: 'nope' })).toBe(8)
    expect(resolvePgPoolMax({ RIVETOS_PG_POOL_MAX: ' ' })).toBe(8)
  })
})

describe('createSharedPgPool', () => {
  it('installs both error and connect listeners', async () => {
    const pool = createSharedPgPool(DUMMY_URL)
    pools.push(pool)
    expect(pool.listeners('error').length).toBeGreaterThan(0)
    expect(pool.listeners('connect').length).toBeGreaterThan(0)
    await pool.end()
  })

  it('applies the resolved max', async () => {
    const pool = createSharedPgPool(DUMMY_URL, { RIVETOS_PG_POOL_MAX: '6' })
    pools.push(pool)
    expect(pool.options.max).toBe(6)
    await pool.end()
  })

  it('uses a 30s connect / queue-wait timeout', async () => {
    const pool = createSharedPgPool(DUMMY_URL)
    pools.push(pool)
    expect(pool.options.connectionTimeoutMillis).toBe(30_000)
    await pool.end()
  })
})

describe('createEndSharedPool', () => {
  it('two concurrent calls share one end() and stay pending until it resolves', async () => {
    let resolveEnd!: () => void
    const end = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEnd = resolve
        }),
    )
    const poolLog = { error: vi.fn(), warn: vi.fn() }
    const endSharedPool = createEndSharedPool({ end }, poolLog)
    const first = endSharedPool()
    const second = endSharedPool()
    expect(end).toHaveBeenCalledTimes(1)
    let firstSettled = false
    let secondSettled = false
    void first.then(() => {
      firstSettled = true
    })
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    resolveEnd()
    await Promise.all([first, second])
    expect(end).toHaveBeenCalledTimes(1)
  })
})

describe('cleanupAfterBootFailure', () => {
  it('rethrows the original error, stops runtime before pool.end, and finishes within the bound', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const runtime = {
      stop: vi.fn(async () => {
        order.push('stop')
      }),
    }
    const pool = {
      end: vi.fn(() => {
        order.push('end')
        return new Promise<void>(() => {
          /* never resolves — a checked-out LISTEN client */
        })
      }),
    }
    const poolLog = { error: vi.fn(), warn: vi.fn() }
    const endPool = createEndSharedPool(pool, poolLog)
    const original = new Error('later boot step failed')
    const pending = cleanupAfterBootFailure({ runtime, endPool, log: poolLog, err: original })
    const assertion = expect(pending).rejects.toBe(original)
    await vi.advanceTimersByTimeAsync(POOL_END_TIMEOUT_MS)
    await assertion
    expect(order).toEqual(['stop', 'end'])
    expect(String(poolLog.error.mock.calls[0]?.[0])).toContain('later boot step failed')
    expect(poolLog.warn).toHaveBeenCalled()
    expect(runtime.stop.mock.invocationCallOrder[0]).toBeLessThan(
      pool.end.mock.invocationCallOrder[0],
    )
  })
})
