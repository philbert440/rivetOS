/**
 * ensureEmbedderSchema — catalog check first, lock_timeout on the same client
 * as ALTER, 55P03 retries that resolve without throwing.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  assertLockTimeout,
  EMBEDDER_LOCK_BACKOFF_MS,
  ensureEmbedderSchema,
  isLockNotAvailable,
} from './embedder.js'

type QueryFn = (sql: string) => Promise<{ rows: unknown[] }>

function sqlText(sql: unknown): string {
  if (typeof sql === 'string') return sql
  if (sql && typeof sql === 'object' && 'text' in sql) {
    return String((sql as { text: unknown }).text)
  }
  return String(sql)
}

function allColumnsRows(): { table_name: string; column_name: string }[] {
  return [
    { table_name: 'ros_messages', column_name: 'embed_failures' },
    { table_name: 'ros_messages', column_name: 'embed_error' },
    { table_name: 'ros_messages', column_name: 'embed_status' },
    { table_name: 'ros_summaries', column_name: 'embed_failures' },
    { table_name: 'ros_summaries', column_name: 'embed_error' },
    { table_name: 'ros_summaries', column_name: 'embed_status' },
  ]
}

function fakePool(opts: {
  catalogRows?: { table_name: string; column_name: string }[]
  clientQuery?: QueryFn
}) {
  const poolSql: string[] = []
  const clientSql: string[] = []
  const client = {
    query: vi.fn(async (sql: unknown) => {
      const text = sqlText(sql)
      clientSql.push(text)
      if (opts.clientQuery) return opts.clientQuery(text)
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const pool = {
    query: vi.fn(async (sql: unknown) => {
      const text = sqlText(sql)
      poolSql.push(text)
      if (/information_schema\.columns/i.test(text)) {
        return { rows: opts.catalogRows ?? [] }
      }
      throw new Error(`unexpected pool.query: ${text}`)
    }),
    connect: vi.fn(async () => client),
  }
  return { pool: pool as never, client, poolSql, clientSql }
}

function lockTimeoutError(): Error & { code: string } {
  const err = new Error('canceling statement due to lock timeout') as Error & { code: string }
  err.code = '55P03'
  return err
}

describe('isLockNotAvailable', () => {
  it('matches 55P03 and nothing else', () => {
    expect(isLockNotAvailable(lockTimeoutError())).toBe(true)
    expect(isLockNotAvailable(new Error('nope'))).toBe(false)
    expect(isLockNotAvailable({ code: '40P01' })).toBe(false)
    expect(isLockNotAvailable(null)).toBe(false)
  })
})

describe('ensureEmbedderSchema', () => {
  it('issues zero DDL when every column already exists', async () => {
    const { pool, client, clientSql } = fakePool({ catalogRows: allColumnsRows() })
    await ensureEmbedderSchema(pool)
    expect(pool.connect).not.toHaveBeenCalled()
    expect(client.query).not.toHaveBeenCalled()
    expect(clientSql.some((s) => /ALTER TABLE/i.test(s))).toBe(false)
  })

  it('sets lock_timeout on the same client before ALTER and resets it after', async () => {
    const { pool, client, clientSql } = fakePool({ catalogRows: [] })
    await ensureEmbedderSchema(pool, { sleep: async () => undefined })
    expect(pool.connect).toHaveBeenCalledTimes(1)
    const lockIdx = clientSql.findIndex((s) => /SET lock_timeout/i.test(s))
    const alterIdx = clientSql.findIndex((s) => /ALTER TABLE/i.test(s))
    const resetIdx = clientSql.findIndex((s) => /RESET lock_timeout/i.test(s))
    expect(lockIdx).toBeGreaterThanOrEqual(0)
    expect(alterIdx).toBeGreaterThan(lockIdx)
    expect(resetIdx).toBeGreaterThan(alterIdx)
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(clientSql.filter((s) => /ALTER TABLE/i.test(s)).length).toBe(6)
  })

  it('retries 55P03 a bounded number of times then resolves without throwing', async () => {
    const sleeps: number[] = []
    const { pool, clientSql } = fakePool({
      catalogRows: [],
      clientQuery: async (sql) => {
        if (/ALTER TABLE/i.test(sql)) throw lockTimeoutError()
        return { rows: [] }
      },
    })
    await expect(
      ensureEmbedderSchema(pool, {
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        log: () => undefined,
      }),
    ).resolves.toBeUndefined()
    const alters = clientSql.filter((s) => /ALTER TABLE/i.test(s))
    // First ALTER per table fails → skip the rest of that table. 2 tables × 5 attempts.
    expect(alters.length).toBe(2 * EMBEDDER_LOCK_BACKOFF_MS.length)
    expect(sleeps).toEqual([...EMBEDDER_LOCK_BACKOFF_MS.slice(1)])
  })

  it('succeeds on a later retry after 55P03', async () => {
    let alterCalls = 0
    const { pool, clientSql } = fakePool({
      catalogRows: [],
      clientQuery: async (sql) => {
        if (/ALTER TABLE/i.test(sql)) {
          alterCalls++
          // Fail the first pass (one ALTER per table, rest skipped), succeed after that.
          if (alterCalls <= 2) throw lockTimeoutError()
        }
        return { rows: [] }
      },
    })
    await expect(
      ensureEmbedderSchema(pool, { sleep: async () => undefined, log: () => undefined }),
    ).resolves.toBeUndefined()
    const alters = clientSql.filter((s) => /ALTER TABLE/i.test(s))
    expect(alters.length).toBe(8)
    expect(alterCalls).toBe(8)
  })

  it('on 55P03 skips remaining ALTERs for the same table in that attempt', async () => {
    const { pool, clientSql } = fakePool({
      catalogRows: [],
      clientQuery: async (sql) => {
        if (/ALTER TABLE ros_messages/i.test(sql)) throw lockTimeoutError()
        return { rows: [] }
      },
    })
    await ensureEmbedderSchema(pool, {
      sleep: async () => undefined,
      log: () => undefined,
      backoffMs: [0],
    })
    const alters = clientSql.filter((s) => /ALTER TABLE/i.test(s))
    expect(alters.filter((s) => /ros_messages/.test(s)).length).toBe(1)
    expect(alters.filter((s) => /ros_summaries/.test(s)).length).toBe(3)
  })

  it('resets lock_timeout, releases, and rethrows a non-55P03 error without retrying', async () => {
    const boom = new Error('undefined_column') as Error & { code: string }
    boom.code = '42703'
    let alters = 0
    const { pool, client, clientSql } = fakePool({
      catalogRows: [],
      clientQuery: async (sql) => {
        if (/ALTER TABLE/i.test(sql)) {
          alters++
          throw boom
        }
        return { rows: [] }
      },
    })
    await expect(
      ensureEmbedderSchema(pool, { sleep: async () => undefined, log: () => undefined }),
    ).rejects.toThrow('undefined_column')
    expect(alters).toBe(1)
    expect(clientSql.some((s) => /RESET lock_timeout/i.test(s))).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('releases the pooled client with the error when RESET fails', async () => {
    const { pool, client } = fakePool({
      catalogRows: [],
      clientQuery: async (sql) => {
        if (/RESET lock_timeout/i.test(sql)) throw new Error('reset failed')
        return { rows: [] }
      },
    })
    await expect(
      ensureEmbedderSchema(pool, { sleep: async () => undefined, log: () => undefined }),
    ).resolves.toBeUndefined()
    expect(client.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it('rejects a lockTimeout that is not a Postgres interval literal', async () => {
    expect(() => assertLockTimeout(`3s'; DROP TABLE ros_messages; --`)).toThrow(
      /invalid lock_timeout/,
    )
    expect(assertLockTimeout('3s')).toBe('3s')
  })
})
