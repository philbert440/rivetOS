import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PRESET_POOL_CONNECTION_TIMEOUT_MS,
  PRESET_POOL_QUERY_TIMEOUT_MS,
  createPresetPool,
  endPresetPool,
} from './preset-pool.js'

describe('createPresetPool', () => {
  const pools: Array<{ end: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()))
  })

  it('logs a pool error instead of throwing', () => {
    const logs: string[] = []
    const pool = createPresetPool('postgres://127.0.0.1:9/none', (msg) => {
      logs.push(msg)
    })
    pools.push(pool)
    expect(pool.options.connectionTimeoutMillis).toBe(PRESET_POOL_CONNECTION_TIMEOUT_MS)
    expect(pool.options.query_timeout).toBe(PRESET_POOL_QUERY_TIMEOUT_MS)
    expect(pool.options.statement_timeout).toBe(PRESET_POOL_QUERY_TIMEOUT_MS)
    expect(pool.options.max).toBe(2)

    const err = new Error('Connection terminated unexpectedly')
    expect(() => {
      pool.emit('error', err)
    }).not.toThrow()
    expect(logs.join('\n')).toMatch(/Connection terminated unexpectedly/)
  })

  it('logs a client error from the connect listener instead of throwing', () => {
    const logs: string[] = []
    const pool = createPresetPool('postgres://127.0.0.1:9/none', (msg) => {
      logs.push(msg)
    })
    pools.push(pool)
    const client = new EventEmitter()
    pool.emit('connect', client)
    expect(() => {
      client.emit('error', new Error('client socket dropped'))
    }).not.toThrow()
    expect(logs.join('\n')).toMatch(/client socket dropped/)
  })

  it('returns from end when the pool does not finish', async () => {
    const logs: string[] = []
    const hung = {
      end: () => new Promise<void>(() => undefined),
    }
    await endPresetPool(hung, (msg) => logs.push(msg), 30)
    expect(logs.join('\n')).toMatch(/timed out after 30ms/)
  })
})
