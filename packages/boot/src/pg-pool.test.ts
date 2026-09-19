import { afterEach, describe, expect, it } from 'vitest'
import { createSharedPgPool, resolvePgPoolMax } from './pg-pool.js'

const DUMMY_URL = 'postgres://user:pass@localhost:5432/db'

const pools: Array<{ end: () => Promise<void> }> = []
afterEach(async () => {
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
})
