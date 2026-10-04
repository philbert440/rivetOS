/**
 * `owner_user_id` is written by the Postgres writers (real engine, no mocks):
 * the adapter and the capture batch, on a migrated database and on one that
 * does not have the column yet.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { PostgresMemory, captureBatch } from '@rivetos/memory-postgres'
import { acquireEmbeddedPg, migrateEmbedded, type EmbeddedPgHandle } from './embedded-pg.js'

const log = {
  info(): void {},
  warn(): void {},
  error(): void {},
}

function findMigrationsDir(): string {
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, 'plugins/memory/postgres/src/schema/migrations')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error('could not find the migrations directory')
    dir = parent
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr !== 'object' || addr === null) {
        server.close()
        reject(new Error('listen(0) returned no address'))
        return
      }
      const port = addr.port
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
    server.on('error', reject)
  })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => undefined)
})

describe('owner_user_id on Postgres (real PGlite)', () => {
  it('is written by the adapter and by a capture batch, and skipped where the column is missing', async () => {
    vi.stubEnv('RIVETOS_EMBED_URL', '')
    cleanups.push(async () => {
      vi.unstubAllEnvs()
    })
    const tmp = await mkdtemp(join(tmpdir(), 'rivetos-pglite-owner-'))
    cleanups.push(() => rm(tmp, { recursive: true, force: true }))
    const port = await freePort()
    const pgUrl = `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`
    const handle: EmbeddedPgHandle = await acquireEmbeddedPg(
      {
        dataDir: join(tmp, 'data'),
        port,
        autoMigrate: true,
        maxConnections: 96,
        pgUrl,
        liteMode: true,
      },
      { log },
    )
    cleanups.push(() => handle.close())
    await migrateEmbedded(pgUrl, findMigrationsDir())
    await handle.exec?.(`SET rivet.defer_embed_enqueue = 'on'`)

    const pool = new pg.Pool({ connectionString: pgUrl, max: 2 })
    cleanups.push(() => pool.end())
    const owners = async (sessionKey: string): Promise<{ conv: unknown; msgs: unknown[] }> => {
      const conv = await pool.query<{ id: string; owner_user_id: string | null }>(
        'SELECT id, owner_user_id FROM ros_conversations WHERE session_key = $1',
        [sessionKey],
      )
      const msgs = await pool.query<{ owner_user_id: string | null }>(
        'SELECT owner_user_id FROM ros_messages WHERE conversation_id = $1 ORDER BY created_at, id',
        [conv.rows[0].id],
      )
      return { conv: conv.rows[0].owner_user_id, msgs: msgs.rows.map((r) => r.owner_user_id) }
    }

    // The adapter, told whose store it is.
    const alice = new PostgresMemory({ connectionString: pgUrl, pool, userId: 'alice' })
    await alice.append({ sessionId: 's-adapter', agent: 'rivet', channel: 'hub', role: 'user', content: 'hello' })
    await alice.append({ sessionId: 's-adapter', agent: 'rivet', channel: 'hub', role: 'assistant', content: 'hi' })
    expect(await owners('s-adapter')).toEqual({ conv: 'alice', msgs: ['alice', 'alice'] })

    // Not told: nothing is written, as before.
    const untold = new PostgresMemory({ connectionString: pgUrl, pool })
    await untold.append({ sessionId: 's-untold', agent: 'rivet', channel: 'hub', role: 'user', content: 'hello' })
    expect(await owners('s-untold')).toEqual({ conv: null, msgs: [null] })
    // A conversation that had no owner gets one from the next write that knows it; old rows are left as they were.
    await alice.append({ sessionId: 's-untold', agent: 'rivet', channel: 'hub', role: 'user', content: 'again' })
    expect(await owners('s-untold')).toEqual({ conv: 'alice', msgs: [null, 'alice'] })

    // A capture batch for a routed user.
    const batch = (sessionKey: string, eventId: string) => ({
      session_key: sessionKey,
      agent: 'rivet-claude',
      channel: 'claude-cli',
      messages: [{ event_id: eventId, role: 'user' as const, content: 'captured' }],
    })
    await captureBatch(pool, batch('s-capture', 'e1'), { ownerUserId: 'guest', resolveProject: null })
    await captureBatch(pool, batch('s-capture', 'e2'), { ownerUserId: 'guest', resolveProject: null })
    expect(await owners('s-capture')).toEqual({ conv: 'guest', msgs: ['guest', 'guest'] })
    // An existing owner is never overwritten by a later writer.
    await captureBatch(pool, batch('s-capture', 'e3'), { ownerUserId: 'alice', resolveProject: null })
    expect((await owners('s-capture')).conv).toBe('guest')

    // Half a migration (one table only) counts as none: no writer names the column.
    await pool.query('ALTER TABLE ros_messages DROP COLUMN owner_user_id')
    const half = new pg.Pool({ connectionString: pgUrl, max: 2 })
    cleanups.push(() => half.end())
    const halfMemory = new PostgresMemory({ connectionString: pgUrl, pool: half, userId: 'alice' })
    await halfMemory.append({ sessionId: 's-half', agent: 'rivet', channel: 'hub', role: 'user', content: 'hello' })
    await captureBatch(half, batch('s-half-capture', 'e1'), { ownerUserId: 'guest', resolveProject: null })
    const halfOwners = await half.query<{ owner_user_id: string | null }>(
      `SELECT owner_user_id FROM ros_conversations WHERE session_key IN ('s-half', 's-half-capture')`,
    )
    expect(halfOwners.rows.map((r) => r.owner_user_id)).toEqual([null, null])

    // A database that has not run migration 0013: every writer still works.
    await pool.query('ALTER TABLE ros_conversations DROP COLUMN owner_user_id')
    const older = new pg.Pool({ connectionString: pgUrl, max: 2 })
    cleanups.push(() => older.end())
    const olderMemory = new PostgresMemory({ connectionString: pgUrl, pool: older, userId: 'alice' })
    await olderMemory.append({ sessionId: 's-older', agent: 'rivet', channel: 'hub', role: 'user', content: 'hello' })
    await captureBatch(older, batch('s-older-capture', 'e1'), { ownerUserId: 'guest', resolveProject: null })
    const count = await older.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id
        WHERE c.session_key IN ('s-older', 's-older-capture')`,
    )
    expect(count.rows[0].n).toBe(2)
  }, 120_000)
})
