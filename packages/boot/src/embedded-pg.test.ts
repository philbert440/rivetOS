/**
 * Embedded PGlite host — real WASM engine, no mocks.
 * Ports the spike (boot + migrate + search arms + multiplex + reset-on-close).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import pg from 'pg'
import type { RivetConfig } from './config.js'
import {
  acquireEmbeddedPg,
  applyEmbeddedPgUrl,
  migrateEmbedded,
  resolveEmbeddedPg,
  type EmbeddedPgHandle,
} from './embedded-pg.js'

const { Client, Pool } = pg

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
    if (parent === dir) {
      throw new Error('could not find plugins/memory/postgres/src/schema/migrations')
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function halfvecLiteral(dims: number): string {
  const parts = Array.from({ length: dims }, () => (Math.random() * 2 - 1).toFixed(4))
  return `[${parts.join(',')}]`
}

const ORIG_PG_URL = process.env.RIVETOS_PG_URL
const ORIG_EMBEDDED = process.env.RIVETOS_PG_EMBEDDED
const ORIG_EMBED_URL = process.env.RIVETOS_EMBED_URL

afterEach(() => {
  if (ORIG_PG_URL === undefined) delete process.env.RIVETOS_PG_URL
  else process.env.RIVETOS_PG_URL = ORIG_PG_URL
  if (ORIG_EMBEDDED === undefined) delete process.env.RIVETOS_PG_EMBEDDED
  else process.env.RIVETOS_PG_EMBEDDED = ORIG_EMBEDDED
  if (ORIG_EMBED_URL === undefined) delete process.env.RIVETOS_EMBED_URL
  else process.env.RIVETOS_EMBED_URL = ORIG_EMBED_URL
})

describe('resolveEmbeddedPg', () => {
  it('returns undefined when embedded is absent', () => {
    const config = { memory: { postgres: {} } } as RivetConfig
    expect(resolveEmbeddedPg(config, '/home/rivet')).toBeUndefined()
  })

  it('expands ~ and applies defaults', () => {
    delete process.env.RIVETOS_EMBED_URL
    const config = { memory: { postgres: { embedded: {} } } } as unknown as RivetConfig
    const resolved = resolveEmbeddedPg(config, '/tmp/fakehome')
    expect(resolved).toBeDefined()
    expect(resolved!.dataDir).toBe('/tmp/fakehome/.rivetos/pglite')
    expect(resolved!.port).toBe(5433)
    expect(resolved!.autoMigrate).toBe(true)
    expect(resolved!.maxConnections).toBe(96)
    expect(resolved!.pgUrl).toBe('postgres://postgres:postgres@127.0.0.1:5433/postgres')
    expect(resolved!.liteMode).toBe(true)
  })

  it('liteMode is false when embed_endpoint or RIVETOS_EMBED_URL is set', () => {
    delete process.env.RIVETOS_EMBED_URL
    const withEndpoint = {
      memory: { postgres: { embedded: {}, embed_endpoint: 'http://127.0.0.1:9402/v1' } },
    } as unknown as RivetConfig
    expect(resolveEmbeddedPg(withEndpoint, '/tmp/fakehome')!.liteMode).toBe(false)

    const bare = { memory: { postgres: { embedded: {} } } } as unknown as RivetConfig
    process.env.RIVETOS_EMBED_URL = 'http://127.0.0.1:9402/v1'
    expect(resolveEmbeddedPg(bare, '/tmp/fakehome')!.liteMode).toBe(false)
  })
})

describe('applyEmbeddedPgUrl', () => {
  it('sets RIVETOS_PG_URL, RIVETOS_PG_EMBEDDED, and connection_string', () => {
    const config = { memory: { postgres: {} } } as unknown as RivetConfig
    const url = 'postgres://postgres:postgres@127.0.0.1:5433/postgres'
    applyEmbeddedPgUrl(config, url)
    expect(process.env.RIVETOS_PG_URL).toBe(url)
    expect(process.env.RIVETOS_PG_EMBEDDED).toBe('1')
    expect(config.memory?.postgres.connection_string).toBe(url)
  })
})

describe('acquireEmbeddedPg (real PGlite)', () => {
  it(
    'boots, migrates, searches, resets session state, multiplexes, and attaches',
    async () => {
      delete process.env.RIVETOS_EMBED_URL

      const tmp = await mkdtemp(join(tmpdir(), 'rivetos-pglite-'))
      const port = await freePort()
      const dataDir = join(tmp, 'data')
      const pgUrl = `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`
      const resolved = {
        dataDir,
        port,
        autoMigrate: true,
        maxConnections: 96,
        pgUrl,
        liteMode: true,
      }

      let handle: EmbeddedPgHandle | undefined
      try {
        handle = await acquireEmbeddedPg(resolved, { log })
        expect(handle.owned).toBe(true)

        const probe = new Client({ connectionString: pgUrl })
        await probe.connect()
        await probe.query('SELECT 1')
        await probe.end()

        await migrateEmbedded(pgUrl, findMigrationsDir())
        await handle.exec?.(`SET rivet.defer_embed_enqueue = 'on'`)

        const c = new Client({ connectionString: pgUrl })
        await c.connect()

        const applied = await c.query<{ n: number }>(
          'select count(*)::int as n from _rivetos_migrations',
        )
        expect(applied.rows[0].n).toBe(16)

        const idx = await c.query<{ reg: string | null }>(
          `select to_regclass('ros_message_chunks_embedding_hnsw')::text as reg`,
        )
        expect(idx.rows[0].reg).not.toBeNull()

        const graphile = await c.query<{ reg: string | null }>(
          `select to_regclass('graphile_worker.jobs')::text as reg`,
        )
        expect(graphile.rows[0].reg).toBeNull()

        const conv = await c.query<{ id: string }>(
          `insert into ros_conversations (session_key, channel, agent)
           values ('embedded-pg-test', 'test', 'test') returning id`,
        )
        const cid = conv.rows[0].id
        const msg = await c.query<{ id: string }>(
          `insert into ros_messages (conversation_id, agent, channel, role, content)
           values ($1, 'test', 'test', 'user', 'pglite embedded memory')
           returning id`,
          [cid],
        )
        const mid = msg.rows[0].id
        await c.query(`update ros_messages set embedding = $1::halfvec where id = $2`, [
          halfvecLiteral(1024),
          mid,
        ])

        const fts = await c.query(
          `select id from ros_messages
           where content_tsv @@ plainto_tsquery('english', $1) limit 5`,
          ['pglite embedded memory'],
        )
        expect(fts.rows.length).toBeGreaterThan(0)

        const trgm = await c.query(
          `select id, similarity(content, $1) as s from ros_messages
           where similarity(content, $1) > 0.1 order by s desc limit 5`,
          ['pglite embedded memory'],
        )
        expect(trgm.rows.length).toBeGreaterThan(0)

        await c.query('BEGIN')
        await c.query('SET LOCAL hnsw.ef_search = 100')
        const ann = await c.query(
          `select id, (1 - (embedding <=> $1::halfvec)) as sim
           from ros_messages where embedding is not null
           order by embedding <=> $1::halfvec limit 5`,
          [halfvecLiteral(1024)],
        )
        await c.query('COMMIT')
        expect(ann.rows.length).toBeGreaterThan(0)
        await c.end()

        const A = new Client({ connectionString: pgUrl })
        await A.connect()
        await A.query(`SET application_name = 'client-A'`)
        await A.query(`SET statement_timeout = 12345`)
        await A.query(`SET default_transaction_read_only = on`)
        await A.query({ name: 'stmt_x', text: 'select 1::int as v' })
        await A.end()
        await sleep(400)

        const B = new Client({ connectionString: pgUrl })
        await B.connect()
        const an = (await B.query('SHOW application_name')).rows[0].application_name as string
        const st = (await B.query('SHOW statement_timeout')).rows[0].statement_timeout as string
        const ro = (await B.query('SHOW default_transaction_read_only')).rows[0]
          .default_transaction_read_only as string
        const v = (await B.query({ name: 'stmt_x', text: 'select 2::int as v' })).rows[0].v as number
        await B.query(
          `insert into ros_conversations (session_key, channel, agent)
           values ('after-reset', 'test', 'test')`,
        )
        await B.end()
        expect(an).not.toBe('client-A')
        expect(st).not.toBe('12345ms')
        expect(ro).toBe('off')
        expect(v).toBe(2)

        const poolA = new Pool({ connectionString: pgUrl, max: 10 })
        const poolB = new Pool({ connectionString: pgUrl, max: 10 })
        try {
          await Promise.all(
            Array.from({ length: 20 }, (_, i) => {
              const pool = i % 2 === 0 ? poolA : poolB
              return pool.query(
                `insert into ros_messages (conversation_id, agent, channel, role, content)
                 values ($1, 'test', 'test', 'user', $2)`,
                [cid, `concurrent ${String(i)}`],
              )
            }),
          )
        } finally {
          await poolA.end()
          await poolB.end()
        }
        const count = new Client({ connectionString: pgUrl })
        await count.connect()
        const n = await count.query<{ n: number }>(
          'select count(*)::int as n from ros_messages',
        )
        await count.end()
        expect(n.rows[0].n).toBe(21)

        const attached = await acquireEmbeddedPg(resolved, { log })
        expect(attached.owned).toBe(false)
        expect(attached.pgUrl).toBe(pgUrl)
        await attached.close()
      } finally {
        await handle?.close()
        await rm(tmp, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
