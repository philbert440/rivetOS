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
