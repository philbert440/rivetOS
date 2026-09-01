import { afterEach, describe, expect, it } from 'vitest'
import {
  checkDeviceChunkGrant,
  checkEmbeddingWidth,
  DEVICE_CHUNK_GRANT_SQL,
} from './doctor.js'

const ORIGINAL_DIMS = process.env.EMBED_TRUNCATE_DIMS

afterEach(() => {
  if (ORIGINAL_DIMS === undefined) delete process.env.EMBED_TRUNCATE_DIMS
  else process.env.EMBED_TRUNCATE_DIMS = ORIGINAL_DIMS
})

describe('doctor embedding-width check', () => {
  it('passes when atttypmod matches the default 1024', async () => {
    delete process.env.EMBED_TRUNCATE_DIMS
    const results = await checkEmbeddingWidth({
      query: async () => ({ rows: [{ atttypmod: 1024 }] }),
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('embedding-width')
    expect(results[0]?.status).toBe('pass')
    expect(results[0]?.message).toMatch(/halfvec\(1024\)/)
  })

  it('warns when atttypmod differs from EMBED_TRUNCATE_DIMS', async () => {
    process.env.EMBED_TRUNCATE_DIMS = '1024'
    const results = await checkEmbeddingWidth({
      query: async () => ({ rows: [{ atttypmod: 4000 }] }),
    })
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.message).toMatch(/halfvec\(4000\)/)
    expect(results[0]?.message).toMatch(/halfvec\(1024\)/)
    expect(results[0]?.message).toMatch(/#624/)
    expect(results[0]?.detail).toMatch(/0015_embedding_width/)
  })

  it('warns when the embedding column is missing', async () => {
    const results = await checkEmbeddingWidth({
      query: async () => ({ rows: [] }),
    })
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.message).toMatch(/not found/)
  })

  it('warns when the fake query throws', async () => {
    const results = await checkEmbeddingWidth({
      query: async () => {
        throw new Error('connection refused')
      },
    })
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.message).toMatch(/unable to read/)
    expect(results[0]?.detail).toMatch(/connection refused/)
  })

  it('reads atttypmod from the pg_attribute query', async () => {
    let seen = ''
    await checkEmbeddingWidth({
      query: async (sql) => {
        seen = sql
        return { rows: [{ atttypmod: 1024 }] }
      },
    })
    expect(seen).toMatch(/pg_attribute/)
    expect(seen).toMatch(/atttypmod/)
    expect(seen).toMatch(/ros_messages/)
    expect(seen).toMatch(/embedding/)
  })

  it('returns no checks when called without a shared query (no second pg connection)', async () => {
    const results = await checkEmbeddingWidth()
    expect(results).toEqual([])
  })
})

describe('doctor device-chunk-grant check', () => {
  it('warns with the exact GRANT when rivet_device lacks SELECT', async () => {
    let seen = ''
    const results = await checkDeviceChunkGrant({
      query: async (sql) => {
        seen = sql
        return { rows: [{ allowed: false }] }
      },
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('device-chunk-grant')
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.detail).toBe(DEVICE_CHUNK_GRANT_SQL)
    expect(results[0]?.detail).toBe('GRANT SELECT ON ros_message_chunks TO rivet_device;')
    expect(seen).toMatch(/has_table_privilege/)
    expect(seen).toMatch(/rivet_device/)
    expect(seen).toMatch(/ros_message_chunks/)
  })

  it('passes when rivet_device has SELECT', async () => {
    const results = await checkDeviceChunkGrant({
      query: async () => ({ rows: [{ allowed: true }] }),
    })
    expect(results[0]?.status).toBe('pass')
  })

  it('skips when the role or table is missing (allowed NULL)', async () => {
    const results = await checkDeviceChunkGrant({
      query: async () => ({ rows: [{ allowed: null }] }),
    })
    expect(results).toEqual([])
  })

  it('skips when the stubbed query throws (backend already reported)', async () => {
    const results = await checkDeviceChunkGrant({
      query: async () => {
        throw new Error('connection refused')
      },
    })
    expect(results).toEqual([])
  })
})
