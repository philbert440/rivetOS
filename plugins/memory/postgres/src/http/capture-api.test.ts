import { Readable } from 'node:stream'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { captureBatch, type CaptureBatch } from '../tools/write-tools.js'
import { createCaptureApiRoute, type CaptureApiOptions } from './capture-api.js'
import { resetProjectRuleWarnings } from '../tags/rule-project.js'

const batch: CaptureBatch = {
  session_key: 'codex:s',
  agent: 'rivet',
  messages: [{ event_id: 'e', role: 'user', content: 'hello' }],
}
function database() {
  const events = new Set<string>()
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO ros_conversations')) return { rows: [{ id: 'conversation' }] }
    if (sql.includes('AS event_id')) return { rows: [...events].map((event_id) => ({ event_id })) }
    if (sql.includes('INSERT INTO ros_messages'))
      events.add(JSON.parse(String(params?.[8])).event_id)
    return { rows: [] }
  })
  const release = vi.fn()
  const client = { query, release } as unknown as pg.PoolClient
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, query, release }
}
async function request(
  opts: CaptureApiOptions,
  body: unknown = batch,
  method = 'POST',
  headers: IncomingMessage['headers'] = {},
) {
  const req = Readable.from([
    typeof body === 'string' ? body : JSON.stringify(body),
  ]) as IncomingMessage
  req.method = method
  req.headers = headers
  req.url = '/api/capture'
  let status = 0
  let response = ''
  const res = {
    once: vi.fn(),
    setHeader: vi.fn(),
    writeHead: (code: number) => {
      status = code
    },
    end: (text: string) => {
      response = text
    },
  } as unknown as ServerResponse
  await createCaptureApiRoute(opts).handler(req, res)
  return { status, body: JSON.parse(response) }
}

describe('capture transaction', () => {
  it('writes once, dedupes repeats within a batch and across requests', async () => {
    const db = database()
    const input = { ...batch, messages: [...batch.messages, ...batch.messages] }
    expect(await request(db, input)).toEqual({
      status: 200,
      body: { ok: true, conversation_id: 'conversation', inserted: 1, skipped: 1 },
    })
    expect((await request(db, input)).body).toMatchObject({ inserted: 0, skipped: 2 })
    expect(db.query.mock.calls.filter(([sql]) => sql.includes('AS event_id'))).toHaveLength(2)
    expect(db.query.mock.calls.slice(0, 2)).toEqual([
      ['BEGIN'],
      ['SELECT pg_advisory_xact_lock(hashtext($1))', ['codex:s']],
    ])
    expect(db.query.mock.calls.at(-1)).toEqual(['COMMIT'])
    expect(db.release).toHaveBeenCalledTimes(2)
  })
  it('updates title, settings and task and finalizes after all inserts', async () => {
    const db = database()
    await captureBatch(db.pool, {
      ...batch,
      title: 'new',
      settings: { x: true },
      task_id: 'task',
      finalize: true,
    })
    expect(db.query.mock.calls[2][1]).toEqual([
      'codex:s',
      'rivet',
      'unknown',
      'new',
      '{"x":true}',
      'task',
      true,
      true,
      true,
    ])
    expect(db.query.mock.calls.at(-2)).toEqual([
      'UPDATE ros_conversations SET active=false, updated_at=now() WHERE id=$1 AND active=true',
      ['conversation'],
    ])
    const sql = db.query.mock.calls[2][0]
    expect(sql).toContain('title = CASE WHEN $7')
    expect(sql).toContain('settings = CASE WHEN $8')
    expect(sql).toContain('task_id = CASE WHEN $9')
  })
  it('accepts finalize-only and preserves absent conversation fields', async () => {
    const db = database()
    expect((await request(db, { ...batch, messages: [], finalize: true })).body).toMatchObject({
      inserted: 0,
      skipped: 0,
    })
    expect(db.query.mock.calls[2][1]?.slice(-3)).toEqual([false, false, false])
    expect(db.query).toHaveBeenCalledWith(
      'UPDATE ros_conversations SET active=false, updated_at=now() WHERE id=$1 AND active=true',
      ['conversation'],
    )
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO ros_messages'))).toBe(
      false,
    )
  })
  it('preserves tool fields and timestamps, caps both text fields, and event_id wins', async () => {
    const db = database()
    const created_at = '2026-09-26T12:00:00Z'
    await captureBatch(db.pool, {
      ...batch,
      messages: [
        {
          event_id: 'e',
          role: 'tool',
          content: 'x'.repeat(16001),
          tool_result: 'y'.repeat(16002),
          tool_name: 'exec',
          tool_args: { cmd: 'ls' },
          metadata: { event_id: 'wrong', source: 'codex' },
          created_at,
        },
      ],
    })
    const params = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO ros_messages'),
    )?.[1]
    expect(params?.[4]).toBe('x'.repeat(16000))
    expect(params?.slice(5, 8)).toEqual(['exec', '{"cmd":"ls"}', 'y'.repeat(16000)])
    expect(JSON.parse(String(params?.[8]))).toEqual({
      event_id: 'e',
      source: 'codex',
      full_content_length: 16001,
      full_tool_result_length: 16002,
      truncated: true,
    })
    expect(params?.[9]).toBe(created_at)
  })
  it('backs off split surrogate pairs in both capture text fields', async () => {
    const db = database()
    const prefix = 'x'.repeat(15999)
    const text = `${prefix}😀`
    await captureBatch(db.pool, {
      ...batch,
      messages: [{ ...batch.messages[0], content: text, tool_result: text }],
    })
    const params = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO ros_messages'),
    )?.[1]
    expect(params?.[4]).toBe(prefix)
    expect(params?.[7]).toBe(prefix)
    expect(JSON.parse(String(params?.[8]))).toMatchObject({
      full_content_length: 16001,
      full_tool_result_length: 16001,
      truncated: true,
    })
  })
  it('rolls back and releases on error; a supplied client remains caller-owned', async () => {
    const db = database()
    db.query.mockRejectedValueOnce(new Error('database down'))
    await expect(captureBatch(db.pool, batch)).rejects.toThrow('database down')
    expect(db.query.mock.calls.at(-1)).toEqual(['ROLLBACK'])
    expect(db.release).toHaveBeenCalledOnce()
    await captureBatch(db.client, batch)
    expect(db.release).toHaveBeenCalledOnce()
  })
})

describe('capture HTTP validation and routing', () => {
  it.each([
    null,
    [],
    {},
    '{',
    { ...batch, session_key: '' },
    { ...batch, agent: '' },
    { ...batch, messages: {} },
    { ...batch, messages: [{ role: 'user', content: '' }] },
    { ...batch, messages: [{ event_id: 'e', role: 'invalid', content: '' }] },
    { ...batch, messages: [{ event_id: 'e', role: 'user', content: 1 }] },
    { ...batch, finalize: 'true' },
    { ...batch, settings: [] },
    { ...batch, messages: [{ ...batch.messages[0], metadata: [] }] },
    { ...batch, messages: [{ ...batch.messages[0], created_at: 'yesterday' }] },
  ])('rejects invalid body %#', async (body) => {
    const db = database()
    expect((await request(db, body)).status).toBe(400)
    expect(db.pool.connect).not.toHaveBeenCalled()
  })
  it.each(['GET', 'PUT', 'DELETE', 'OPTIONS'])('rejects method %s', async (method) => {
    expect((await request(database(), batch, method)).status).toBe(405)
  })
  it('enforces the 1 MiB byte limit', async () => {
    const db = database()
    expect((await request(db, { ...batch, title: 'é'.repeat(524288) })).status).toBe(413)
    expect(db.pool.connect).not.toHaveBeenCalled()
  })
  it('sends 413 and closes the socket for an unfinished chunked upload over 1 MiB', async () => {
    let serverSocket: Socket | undefined
    const db = database()
    const api = createCaptureApiRoute(db)
    const server = createServer((req, res) => {
      void api.handler(req, res)
    })
    server.on('connection', (socket) => {
      serverSocket = socket
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      await new Promise<void>((resolve, reject) => {
        const client = httpRequest(`${base}/api/capture`, { method: 'POST' })
        const timer = setTimeout(() => {
          client.destroy()
          reject(new Error('unfinished oversized upload socket did not close within 2 seconds'))
        }, 2000)
        let responseEnded = false
        client.on('error', reject)
        client.on('socket', (socket) => {
          socket.once('close', () => {
            clearTimeout(timer)
            try {
              expect(responseEnded).toBe(true)
              expect(socket.destroyed).toBe(true)
              expect(serverSocket?.destroyed).toBe(true)
              resolve()
            } catch (error) {
              reject(error)
            }
          })
        })
        client.on('response', (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            body += chunk
          })
          res.on('end', () => {
            try {
              expect(res.statusCode).toBe(413)
              expect(res.headers.connection).toBe('close')
              expect(JSON.parse(body)).toEqual({ error: 'body too large' })
              responseEnded = true
            } catch (error) {
              reject(error)
            }
          })
        })
        for (let chunk = 0; chunk < 65; chunk++) client.write(Buffer.alloc(16 * 1024, 'q'))
        // Deliberately never end the request: the server must close the connection.
      })
      expect(db.pool.connect).not.toHaveBeenCalled()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each(['', ['alice', 'bob'], 'unknown'])(
    'refuses malformed or unknown identity %#',
    async (identity) => {
      const db = database()
      expect((await request(db, batch, 'POST', { 'x-rivetos-user': identity })).status).toBe(503)
      expect(db.pool.connect).not.toHaveBeenCalled()
    },
  )
  it('uses the stamped user pool and refuses a tombstone', async () => {
    const owner = database()
    const user = database()
    const options = {
      pool: owner.pool,
      userPools: new Map([
        ['alice', user.pool],
        ['deleted', null],
      ]),
    }
    expect((await request(options, batch, 'POST', { 'x-rivetos-user': 'alice' })).status).toBe(200)
    expect(owner.pool.connect).not.toHaveBeenCalled()
    expect(user.pool.connect).toHaveBeenCalledOnce()
    expect((await request(options, batch, 'POST', { 'x-rivetos-user': 'deleted' })).status).toBe(
      503,
    )
  })
  it('returns only the error message for a writer failure', async () => {
    const response = await request({
      ...database(),
      writer: () => async () => {
        throw new Error('failed')
      },
    })
    expect(response).toEqual({ status: 500, body: { error: 'failed' } })
  })
})

describe('rule-based project tag', () => {
  const HIT = {
    key: 'project' as const,
    value: 'rivetos',
    display: 'rivetOS',
    rule: 'git-remote' as const,
    reason: 'git-remote: github.com/philbert440/rivetOS',
    gitRoot: '/srv/code/rivetos',
  }
  const CWD = '/srv/code/rivetos/packages/types'
  const resolveProject = vi.fn((cwd: string) => (cwd === CWD ? HIT : null))
  const tagInserts = (db: ReturnType<typeof database>) =>
    db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ros_tags'))
  const sqls = (db: ReturnType<typeof database>) => db.query.mock.calls.map(([sql]) => sql)

  it('resolves before BEGIN and writes an accepted, attributed rule tag under a savepoint', async () => {
    const db = database()
    resolveProject.mockClear()
    let beganWhenResolved: boolean | undefined
    resolveProject.mockImplementationOnce((cwd: string) => {
      beganWhenResolved = db.query.mock.calls.length > 0
      return cwd === CWD ? HIT : null
    })
    const input = { ...batch, settings: { cwd: `  ${CWD}  ` } }
    expect((await request({ ...db, capture: { resolveProject } }, input)).status).toBe(200)
    expect(resolveProject).toHaveBeenCalledWith(CWD)
    expect(beganWhenResolved).toBe(false)
    const inserts = tagInserts(db)
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toMatch(/ON CONFLICT \(entity_type, entity_id, key, value\) DO NOTHING/)
    expect(inserts[0][0]).toMatch(/'rule', 'accepted', \$5, \$6, \$5, now\(\)/)
    expect(inserts[0][1]).toEqual([
      'conversation',
      'project',
      'rivetos',
      'rivetOS',
      'cwd-git-root',
      'git-remote: github.com/philbert440/rivetOS',
    ])
    const order = sqls(db)
    expect(order.indexOf('SAVEPOINT rivet_project_rule')).toBeGreaterThan(
      order.findIndex((s) => s.includes('INSERT INTO ros_conversations')),
    )
    expect(order.indexOf('RELEASE SAVEPOINT rivet_project_rule')).toBeLessThan(
      order.findIndex((s) => s.includes('INSERT INTO ros_messages')),
    )
    expect(order.at(-1)).toBe('COMMIT')
  })

  it('never fails capture when the tag write throws: rolls back to the savepoint and commits the messages', async () => {
    const db = database()
    const base = db.query.getMockImplementation()!
    db.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM ros_tags')) throw new Error('relation "ros_tags" does not exist')
      return base(sql, params)
    })
    resetProjectRuleWarnings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await request({ ...db, capture: { resolveProject } }, { ...batch, settings: { cwd: CWD } })
      expect(res).toEqual({
        status: 200,
        body: { ok: true, conversation_id: 'conversation', inserted: 1, skipped: 0 },
      })
      const order = sqls(db)
      expect(order).toContain('ROLLBACK TO SAVEPOINT rivet_project_rule')
      expect(order.indexOf('ROLLBACK TO SAVEPOINT rivet_project_rule')).toBeLessThan(
        order.findIndex((s) => s.includes('INSERT INTO ros_messages')),
      )
      expect(order.at(-1)).toBe('COMMIT')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('tag tables missing'))
      // The same failure on the next batch is not logged again.
      await request({ ...db, capture: { resolveProject } }, { ...batch, settings: { cwd: CWD } })
      expect(warn.mock.calls.filter(([m]) => String(m).includes('tag tables missing'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('a throwing resolver means no tag, not a failed capture', async () => {
    const db = database()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const boom = vi.fn(() => {
        throw new Error('EIO')
      })
      const res = await request({ ...db, capture: { resolveProject: boom } }, { ...batch, settings: { cwd: CWD } })
      expect(res.status).toBe(200)
      expect(tagInserts(db)).toHaveLength(0)
      expect(sqls(db)).not.toContain('SAVEPOINT rivet_project_rule')
    } finally {
      warn.mockRestore()
    }
  })

  it('writes at most once per conversation: an existing rule project tag (even rejected or merged) stops it', async () => {
    const db = database()
    const base = db.query.getMockImplementation()!
    db.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT 1 FROM ros_tags')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      return base(sql, params)
    })
    await captureBatch(db.pool, { ...batch, settings: { cwd: CWD } }, { resolveProject })
    expect(tagInserts(db)).toHaveLength(0)
  })

  it('follows a vocabulary merge to the survivor and skips a rejected value', async () => {
    const merged = database()
    const base = merged.query.getMockImplementation()!
    merged.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM ros_tag_taxonomy'))
        return { rows: [{ value: 'rivet-os', display: 'RivetOS', state: 'accepted' }], rowCount: 1 }
      return base(sql, params)
    })
    await captureBatch(merged.pool, { ...batch, settings: { cwd: CWD } }, { resolveProject })
    expect(tagInserts(merged)[0][1]).toEqual([
      'conversation',
      'project',
      'rivet-os',
      'RivetOS',
      'cwd-git-root',
      HIT.reason,
    ])

    const rejected = database()
    const base2 = rejected.query.getMockImplementation()!
    rejected.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM ros_tag_taxonomy'))
        return { rows: [{ value: 'rivetos', display: '', state: 'rejected' }], rowCount: 1 }
      return base2(sql, params)
    })
    await captureBatch(rejected.pool, { ...batch, settings: { cwd: CWD } }, { resolveProject })
    expect(tagInserts(rejected)).toHaveLength(0)
  })

  it('never resolves a routed user\'s cwd against this host: basename rule only', async () => {
    const owner = database()
    const user = database()
    resolveProject.mockClear()
    const res = await request(
      { ...owner, userPools: new Map([['alice', user.pool]]), capture: { resolveProject } },
      { ...batch, settings: { cwd: CWD } },
      'POST',
      { 'x-rivetos-user': 'alice' },
    )
    expect(res.status).toBe(200)
    expect(resolveProject).not.toHaveBeenCalled()
    expect(tagInserts(owner)).toHaveLength(0)
    const inserts = tagInserts(user)
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toEqual([
      'conversation',
      'project',
      'types',
      'types',
      'cwd-git-root',
      'cwd-basename: types',
    ])
  })

  it('a writer override is handed the per-request options, so it cannot bypass the routed-user guard', async () => {
    const owner = database()
    const user = database()
    const seen: Array<boolean | undefined> = []
    const writer = vi.fn((_pool: pg.Pool, options: { allowFilesystem?: boolean }) => {
      seen.push(options.allowFilesystem)
      return async () => ({ ok: true as const, conversation_id: 'c', inserted: 0, skipped: 0 })
    })
    const opts = { ...owner, userPools: new Map([['alice', user.pool]]), writer }
    await request(opts, batch)
    await request(opts, batch, 'POST', { 'x-rivetos-user': 'alice' })
    expect(seen).toEqual([true, false])
  })

  it('skips the rule for no cwd, a relative or dotted cwd, a root-like cwd, or when disabled', async () => {
    const db = database()
    resolveProject.mockClear()
    for (const settings of [{ source: 'x' }, { cwd: 'relative/dir' }, { cwd: '/srv/../etc' }, { cwd: 42 }]) {
      await captureBatch(db.pool, { ...batch, settings }, { resolveProject })
    }
    expect(resolveProject).not.toHaveBeenCalled()
    await captureBatch(db.pool, { ...batch, settings: { cwd: '/tmp' } }, { allowFilesystem: false })
    await captureBatch(db.pool, { ...batch, settings: { cwd: CWD } }, { resolveProject: null })
    expect(tagInserts(db)).toHaveLength(0)
    expect(sqls(db)).not.toContain('SAVEPOINT rivet_project_rule')
  })
})
