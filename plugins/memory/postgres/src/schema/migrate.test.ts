import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { listMigrations } from './migrate.js'

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
})
