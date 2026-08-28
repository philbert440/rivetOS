import { mkdtempSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  legacySqlitePath,
  prepareMigration,
  readLegacyStorage,
} from './tauri-storage-migration.js'

/** Build a WebKit-shaped localStorage sqlite: ItemTable(key, value UTF-16LE blob). */
function fixtureDb(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tauri-ls-'))
  const file = join(dir, 'tauri_localhost_0.localstorage')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(entries)) {
    insert.run(key, Buffer.from(value, 'utf16le'))
  }
  db.close()
  return file
}

describe('legacySqlitePath', () => {
  it('points at the Tauri identifier under XDG data home', () => {
    expect(legacySqlitePath('/home/p/.local/share')).toBe(
      '/home/p/.local/share/dev.rivetos.rivethub/localstorage/tauri_localhost_0.localstorage',
    )
  })
})

describe('readLegacyStorage', () => {
  it('reads rivethub.* keys and decodes UTF-16LE values', () => {
    const file = fixtureDb({
      'rivethub.baseUrl': 'https://192.0.2.7:5174',
      'rivethub.roster': '[{"name":"Nodé","baseUrl":"https://192.0.2.7:5174"}]',
      'unrelated.key': 'must not appear',
    })
    expect(readLegacyStorage(file)).toEqual({
      'rivethub.baseUrl': 'https://192.0.2.7:5174',
      'rivethub.roster': '[{"name":"Nodé","baseUrl":"https://192.0.2.7:5174"}]',
    })
  })
})

describe('prepareMigration', () => {
  it('consume hands the payload out ONCE and writes the marker at hand-out', () => {
    const file = fixtureDb({ 'rivethub.baseUrl': 'https://192.0.2.7:5174' })
    const marker = join(mkdtempSync(join(tmpdir(), 'marker-')), 'done')
    const m = prepareMigration(marker, file)
    expect(m.consume()).toEqual({ 'rivethub.baseUrl': 'https://192.0.2.7:5174' })
    // Marker exists the moment the payload leaves main — no ack leg.
    expect(existsSync(marker)).toBe(true)
    expect(m.consume()).toBeNull()
    // A later run sees the marker and never re-reads.
    expect(prepareMigration(marker, file).consume()).toBeNull()
  })

  it('no legacy store: silent, no marker (a later install may still migrate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-legacy-'))
    expect(prepareMigration(join(dir, 'done'), join(dir, 'absent.db')).consume()).toBeNull()
    expect(existsSync(join(dir, 'done'))).toBe(false)
  })

  it('garbage legacy store: skipped AND marked — never re-read every launch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'garbage-'))
    const garbage = join(dir, 'garbage.db')
    writeFileSync(garbage, 'not a sqlite file')
    const marker = join(dir, 'done')
    expect(prepareMigration(marker, garbage).consume()).toBeNull()
    expect(existsSync(marker)).toBe(true)
  })
})
