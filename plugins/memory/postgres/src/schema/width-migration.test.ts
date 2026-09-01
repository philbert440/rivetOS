import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listMigrations } from './migrate.js'
import { decideWidthMigration } from './width-migration.js'

describe('decideWidthMigration', () => {
  it('skips when typmod already matches target, even with data', () => {
    expect(decideWidthMigration({ typmod: 1024, nonNullCount: 99, target: 1024 })).toBe('skip')
  })

  it('skips when the column is missing (null typmod)', () => {
    expect(decideWidthMigration({ typmod: null, nonNullCount: 0, target: 1024 })).toBe('skip')
  })

  it('alters when width differs and the column is empty', () => {
    expect(decideWidthMigration({ typmod: 4000, nonNullCount: 0, target: 1024 })).toBe('alter')
  })

  it('alters unconstrained typmod (-1) when there are no rows', () => {
    expect(decideWidthMigration({ typmod: -1, nonNullCount: 0, target: 1024 })).toBe('alter')
  })

  it('refuses when width differs and non-null rows exist', () => {
    expect(decideWidthMigration({ typmod: 4000, nonNullCount: 1, target: 1024 })).toBe('refuse')
  })

  it('refuses unconstrained typmod (-1) when rows exist', () => {
    expect(decideWidthMigration({ typmod: -1, nonNullCount: 3, target: 1024 })).toBe('refuse')
  })
})

describe('0014_chunks.sql + 0015_embedding_width.sql', () => {
  const migrationsDir = resolve(__dirname, 'migrations')
  const chunksSql = readFileSync(resolve(migrationsDir, '0014_chunks.sql'), 'utf8')
  const widthSql = readFileSync(resolve(migrationsDir, '0015_embedding_width.sql'), 'utf8')

  it('is discovered by the runner: 0013 < 0014_chunks < 0015_embedding_width', () => {
    const names = listMigrations(migrationsDir).map((m) => m.name)
    expect(names).toContain('0013_owner_user_id.sql')
    expect(names).toContain('0014_chunks.sql')
    expect(names).toContain('0015_embedding_width.sql')
    expect(names.indexOf('0014_chunks.sql')).toBeGreaterThan(names.indexOf('0013_owner_user_id.sql'))
    expect(names.indexOf('0015_embedding_width.sql')).toBeGreaterThan(
      names.indexOf('0014_chunks.sql'),
    )
  })

  it('0014_chunks.sql has content_hash, chunks table, trigger, offset comments; no width ALTER', () => {
    expect(chunksSql).toMatch(/ADD COLUMN IF NOT EXISTS content_hash TEXT/)
    expect(chunksSql).toMatch(/CREATE TABLE IF NOT EXISTS ros_message_chunks/)
    expect(chunksSql).toMatch(
      /message_id\s+UUID NOT NULL REFERENCES ros_messages\(id\) ON DELETE CASCADE/,
    )
    expect(chunksSql).toMatch(/embedding\s+halfvec\(1024\)/)
    expect(chunksSql).toMatch(/UNIQUE \(message_id, idx\)/)
    expect(chunksSql).toMatch(/idx_ros_message_chunks_message_id/)
    expect(chunksSql).toMatch(/ros_message_chunks_embedding_hnsw/)
    expect(chunksSql).toMatch(/notify_chunk_embedding_queue/)
    expect(chunksSql).toMatch(/targetTable',\s*'ros_message_chunks'/)
    expect(chunksSql).toMatch(/trg_embed_message_chunk/)
    expect(chunksSql).toMatch(/offset into the composed embed text/)
    expect(chunksSql).toMatch(/max_attempts => 5/)
    expect(chunksSql).toMatch(/embed_status\s+TEXT/)
    expect(chunksSql).toMatch(/embed_failures INT NOT NULL DEFAULT 0/)
    expect(chunksSql).toMatch(/NEW\.embed_status IS NULL/)
    expect(chunksSql).toMatch(/WHEN \(NEW\.embedding IS NULL AND NEW\.embed_status IS NULL\)/)
    expect(chunksSql).not.toMatch(/ALTER COLUMN embedding TYPE/)
    expect(chunksSql).not.toMatch(/RAISE EXCEPTION/)
  })

  it('0015_embedding_width.sql has the guarded width fix only; no chunks table', () => {
    expect(widthSql).toMatch(/RAISE EXCEPTION/)
    expect(widthSql).toMatch(/non-null row/)
    expect(widthSql).toMatch(/Manual procedure/)
    expect(widthSql).toMatch(/checkEmbeddingWidth/)
    expect(widthSql).not.toMatch(/subvector/)
    expect(widthSql).toMatch(/DROP INDEX IF EXISTS/)
    expect(widthSql).toMatch(/ALTER COLUMN embedding TYPE halfvec\(1024\)/)
    expect(widthSql).toMatch(/hnsw \(embedding halfvec_cosine_ops\)/)
    expect(widthSql).toMatch(/m = 32/)
    expect(widthSql).toMatch(/ef_construction = 120/)
    expect(widthSql).not.toMatch(/am\.amname = 'hnsw'/)
    expect(widthSql).not.toMatch(/CREATE TABLE IF NOT EXISTS ros_message_chunks/)
    expect(widthSql).not.toMatch(/ADD COLUMN IF NOT EXISTS content_hash/)
  })
})
