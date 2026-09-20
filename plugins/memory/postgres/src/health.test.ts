/**
 * Degraded-schema handling for the embedding health diagnostic.
 */
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { isMissingSchemaError, queryEmbeddingHealth } from './health.js'

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function rejectingPool(err: unknown): pg.Pool {
  return { query: () => Promise.reject(err) } as unknown as pg.Pool
}

describe('isMissingSchemaError', () => {
  it('matches undefined_table and undefined_column only', () => {
    expect(isMissingSchemaError(pgError('relation does not exist', '42P01'))).toBe(true)
    expect(isMissingSchemaError(pgError('column does not exist', '42703'))).toBe(true)
    expect(isMissingSchemaError(pgError('connection terminated', '08006'))).toBe(false)
    expect(isMissingSchemaError(new Error('no code'))).toBe(false)
    expect(isMissingSchemaError(null)).toBe(false)
  })
})

describe('queryEmbeddingHealth', () => {
  it('degrades to null when embed columns are absent (42703)', async () => {
    const pool = rejectingPool(pgError('column "embed_status" does not exist', '42703'))
    await expect(queryEmbeddingHealth(pool)).resolves.toBeNull()
  })

  it('degrades to null when embed relations are absent (42P01)', async () => {
    const pool = rejectingPool(pgError('relation "ros_messages" does not exist', '42P01'))
    await expect(queryEmbeddingHealth(pool)).resolves.toBeNull()
  })

  it('rethrows any other error', async () => {
    const boom = pgError('connection terminated unexpectedly', '08006')
    await expect(queryEmbeddingHealth(rejectingPool(boom))).rejects.toBe(boom)
  })

  it('returns query rows unchanged on the healthy path', async () => {
    const rows = [
      { msg_queue: '3', sum_queue: '1', unembeddable: '4', failed: '2', recent_failed: '0' },
    ]
    const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
    await expect(queryEmbeddingHealth(pool)).resolves.toEqual({ rows })
  })
})
