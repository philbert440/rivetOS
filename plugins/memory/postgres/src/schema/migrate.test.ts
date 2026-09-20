import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import {
  applyMigration,
  applySessionGuards,
  ensureMigrationsTable,
  listMigrations,
  MIGRATION_LOCK_TIMEOUT,
  resetSessionGuards,
} from './migrate.js'

describe('listMigrations', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivetos-migrate-'))
    writeFileSync(resolve(dir, '0002_zzz.sql'), '-- second')
    writeFileSync(resolve(dir, '0001_aaa.sql'), '-- first')
    writeFileSync(resolve(dir, 'README.md'), 'ignore me')
    mkdirSync(resolve(dir, 'subdir'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns only .sql files', () => {
    const ms = listMigrations(dir)
    expect(ms.map((m) => m.name)).toEqual(['0001_aaa.sql', '0002_zzz.sql'])
  })

  it('sorts lexically', () => {
    const ms = listMigrations(dir)
    expect(ms[0].name).toBe('0001_aaa.sql')
    expect(ms[1].name).toBe('0002_zzz.sql')
  })

  it('reads file contents', () => {
    const ms = listMigrations(dir)
    expect(ms[0].sql).toBe('-- first')
    expect(ms[1].sql).toBe('-- second')
  })
})

describe('baseline migration discovery', () => {
  it('ships at least the 0001 baseline', () => {
    const baselineDir = resolve(__dirname, 'migrations')
    const ms = listMigrations(baselineDir)
    expect(ms.length).toBeGreaterThanOrEqual(1)
    expect(ms[0].name).toBe('0001_baseline.sql')
    expect(ms[0].sql).toMatch(/CREATE TABLE.*ros_messages/)
  })

  it('0016 defers embed enqueue when rivet.defer_embed_enqueue is on', () => {
    const baselineDir = resolve(__dirname, 'migrations')
    const ms = listMigrations(baselineDir)
    const m = ms.find((row) => row.name === '0016_defer_embed_enqueue.sql')
    expect(m).toBeDefined()
    expect(m?.sql).toContain("current_setting('rivet.defer_embed_enqueue', true) = 'on'")
    expect(m?.sql).toContain('RETURN NEW')
  })
})

describe('startup DDL guards', () => {
  function sqlText(sql: unknown): string {
    return typeof sql === 'string' ? sql : String(sql)
  }

  it('applySessionGuards sets lock_timeout and resetSessionGuards clears it', async () => {
    const sqls: string[] = []
    const client = {
      query: vi.fn(async (sql: unknown) => {
        sqls.push(sqlText(sql))
        return { rows: [] }
      }),
    }
    await applySessionGuards(client as never)
    await resetSessionGuards(client as never)
    expect(sqls[0]).toContain(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`)
    expect(sqls[1]).toMatch(/RESET lock_timeout/i)
  })

  it('ensureMigrationsTable skips CREATE when the table already exists', async () => {
    const sqls: string[] = []
    const client = {
      query: vi.fn(async (sql: unknown) => {
        const text = sqlText(sql)
        sqls.push(text)
        if (/to_regclass/.test(text)) return { rows: [{ t: '_rivetos_migrations' }] }
        return { rows: [] }
      }),
    }
    await ensureMigrationsTable(client as never)
    expect(sqls.some((s) => /to_regclass/.test(s))).toBe(true)
    expect(sqls.some((s) => /CREATE TABLE/.test(s))).toBe(false)
  })

  it('ensureMigrationsTable creates the table when missing', async () => {
    const sqls: string[] = []
    const client = {
      query: vi.fn(async (sql: unknown) => {
        const text = sqlText(sql)
        sqls.push(text)
        if (/to_regclass/.test(text)) return { rows: [{ t: null }] }
        return { rows: [] }
      }),
    }
    await ensureMigrationsTable(client as never)
    expect(sqls.some((s) => /CREATE TABLE/.test(s))).toBe(true)
  })

  it('applyMigration retries 55P03 then succeeds', async () => {
    let begins = 0
    const sqls: string[] = []
    const client = {
      query: vi.fn(async (sql: unknown) => {
        const text = sqlText(sql)
        sqls.push(text)
        if (text === 'BEGIN') {
          begins++
          return { rows: [] }
        }
        if (text === 'some ddl' && begins === 1) {
          const err = new Error('lock timeout') as Error & { code: string }
          err.code = '55P03'
          throw err
        }
        return { rows: [] }
      }),
    }
    await applyMigration(
      client as never,
      { name: '0001_x.sql', path: '/x', sql: 'some ddl' },
      { sleep: async () => undefined, backoffMs: [0, 1] },
    )
    expect(begins).toBe(2)
    expect(sqls.filter((s) => s === 'COMMIT').length).toBe(1)
  })
})
