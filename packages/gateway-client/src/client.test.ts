import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  CatalogSheet,
  OutcomesResponse,
  SessionDeleteResponse,
  SessionsDeleteResponse,
  SessionsListResponse,
  SessionTrashResponse,
  TaskResponse,
  TaskWire,
} from '@rivetos/types'
import { GatewayError } from './http.js'
import { RivetGateway } from './client.js'
import { decodeSessionIdSegment, encodeSessionIdSegment } from '@rivetos/types'

/**
 * Fixture stub of the gateway. Responses are declared `satisfies` the wire
 * contracts, so this suite is the client-side half of the shape lock: if a
 * contract changes, these fixtures (and the server handlers, via their own
 * satisfies) both fail to compile.
 */

const TASK_FIXTURE = {
  id: 't-1',
  goal: 'demo',
  contextRefs: [],
  acceptanceCriteria: [],
  spec: {},
  executor: 'chat-loop',
  agentId: 'rivet',
  origin: 'api',
  chainDepth: 0,
  budget: {},
  status: 'queued',
  attempt: 0,
  maxAttempts: 1,
  harnessSessionIds: [],
  evalAttempt: 0,
  createdAt: 1_751_900_000_000,
} satisfies TaskWire

const SESSIONS_FIXTURE = {
  sessions: [{ id: 'lobby', lastActive: 1_751_900_000_000, messages: 3 }],
} satisfies SessionsListResponse

const CATALOG_FIXTURE = {
  node: 'testnode',
  agents: [
    { id: 'rivet', provider: 'vllm', model: 'qwen-27b', node: 'testnode', local: true },
    { id: 'claude', node: 'othernode', local: false },
  ],
  executors: [],
  tools: ['echo'],
  skills: [],
} satisfies CatalogSheet

const OUTCOMES_FIXTURE = {
  filter: {},
  totals: {
    tasks: 1,
    completed: 1,
    failed: 0,
    verified: 1,
    refuted: 0,
    escalated: 0,
    diverged: 0,
    divergenceRate: 0,
  },
  byAgent: {},
  byExecutor: {},
  byDay: {},
} satisfies OutcomesResponse

const DEL_SID = 'claude-code:00000000-0000-4000-8000-000000000001'
const LIVE_SID = 'claude-code:00000000-0000-4000-8000-000000000002'
const GONE_SID = 'claude-code:00000000-0000-4000-8000-000000000003'

const TRASH_FIXTURE = {
  candidates: [
    {
      session: DEL_SID,
      harness: 'claude-code',
      title: null,
      updatedAt: '2026-10-01T00:00:00Z',
      reason: 'empty',
      userTurns: 0,
      reply: null,
    },
  ],
} satisfies SessionTrashResponse

interface Captured {
  method?: string
  url?: string
  auth?: string
  body?: string
  contentType?: string
}

let server: Server
let baseUrl: string
const captured: Captured = {}

function handle(req: IncomingMessage, res: ServerResponse): void {
  captured.method = req.method
  captured.url = req.url
  captured.auth = req.headers.authorization
  captured.contentType = req.headers['content-type']
  let raw = ''
  req.on('data', (c: Buffer) => (raw += c.toString()))
  req.on('end', () => {
    captured.body = raw
    const respond = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const path = (req.url ?? '').split('?')[0]
    if (path === '/healthz') return respond(200, { ok: true })
    if (path === '/api/sessions/trash' && req.method === 'GET') return respond(200, TRASH_FIXTURE)
    if (path === '/api/sessions/delete' && req.method === 'POST') {
      const ids = (JSON.parse(raw) as { sessions: string[] }).sessions
      return respond(200, {
        results: ids.map((session) =>
          session === LIVE_SID
            ? { session, ok: false as const, error: 'session is live' }
            : { session, ok: true as const, conversations: 1, messages: 2, summaries: 0 },
        ),
      } satisfies SessionsDeleteResponse)
    }
    if (path.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const session = decodeSessionIdSegment(path.slice('/api/sessions/'.length))
      if (session === LIVE_SID) return respond(409, { error: 'session is live' })
      if (session === GONE_SID) return respond(404, { error: 'not found' })
      return respond(200, {
        ok: true,
        session,
        conversations: 1,
        messages: 4,
        summaries: 1,
      } satisfies SessionDeleteResponse)
    }
    if (path === '/api/sessions') return respond(200, SESSIONS_FIXTURE)
    if (path === '/api/tasks' && req.method === 'POST')
      return respond(201, { task: TASK_FIXTURE } satisfies TaskResponse)
    if (path === '/api/tasks' && req.method === 'GET')
      return respond(200, { tasks: [TASK_FIXTURE] })
    if (path === '/api/tasks/t-1') return respond(200, { task: TASK_FIXTURE })
    if (path === '/api/catalog') return respond(200, CATALOG_FIXTURE)
    if (path === '/api/outcomes') return respond(200, OUTCOMES_FIXTURE)
    if (path === '/api/wiki/some-slug/raw') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
      return res.end('# raw markdown')
    }
    if (path === '/api/memory/search') {
      return respond(200, {
        query: 'loopback',
        scope: 'both',
        degraded: null,
        results: [],
      })
    }
    if (path === '/api/memory/health') {
      return respond(200, {
        status: 'ok',
        embeddings: { status: 'ok' },
        embedQueueDepth: 0,
      })
    }
    if (path === '/api/uploads' && req.method === 'POST') {
      return respond(201, {
        uri: '/home/rivet/.rivetos/den/uploads/u1.png',
        name: 'shot.png',
        mime: 'image/png',
        size: raw.length,
        expiresAt: 1_751_900_000_000,
      })
    }
    if (path === '/api/voice/transcribe' && req.method === 'POST') {
      if (raw === 'NOCONF')
        return respond(501, { error: 'voice transcription is not configured on this node' })
      return respond(200, { text: 'hello from mic' })
    }
    if (path === '/api/voice/speak' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      return res.end('WAVBYTES')
    }
    if (path === '/api/tasks/missing') return respond(404, { error: 'no task missing' })
    respond(500, { error: `unhandled ${req.method} ${path}` })
  })
}

beforeAll(async () => {
  server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('RivetGateway HTTP', () => {
  it('deletes one session by its base64url session segment', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.deleteSession(DEL_SID)
    expect(captured.method).toBe('DELETE')
    // Same segment encoding as /api/sessions/{session}/placement, so native
    // ids containing '/' or ':' stay one path segment.
    expect(captured.url).toBe(`/api/sessions/${encodeSessionIdSegment(DEL_SID)}`)
    expect(res).toEqual({ ok: true, session: DEL_SID, conversations: 1, messages: 4, summaries: 1 })
  })

  it('surfaces a live session as a 409 GatewayError and a hidden one as 404', async () => {
    const gw = new RivetGateway({ baseUrl })
    const live = await gw.deleteSession(LIVE_SID).catch((e: unknown) => e)
    expect(live).toBeInstanceOf(GatewayError)
    expect((live as GatewayError).status).toBe(409)
    expect((live as GatewayError).message).toBe('session is live')
    const gone = await gw.deleteSession(GONE_SID).catch((e: unknown) => e)
    expect((gone as GatewayError).status).toBe(404)
  })

  it('bulk-deletes with a {sessions} body and keeps per-item failures', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.deleteSessions([DEL_SID, LIVE_SID])
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe('/api/sessions/delete')
    expect(captured.contentType).toBe('application/json')
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ sessions: [DEL_SID, LIVE_SID] })
    expect(res.results).toEqual([
      { session: DEL_SID, ok: true, conversations: 1, messages: 2, summaries: 0 },
      { session: LIVE_SID, ok: false, error: 'session is live' },
    ])
  })

  it('reads trash candidates with a GET and no body', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.trashSessions()
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe('/api/sessions/trash')
    expect(captured.body).toBe('')
    expect(res.candidates[0]?.reason).toBe('empty')
  })

  it('lists sessions', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.listSessions()
    expect(res.sessions[0].id).toBe('lobby')
    expect(captured.auth).toBeUndefined()
  })

  it('does not send Authorization (mTLS only)', async () => {
    const gw = new RivetGateway({ baseUrl })
    await gw.listSessions()
    expect(captured.auth).toBeUndefined()
  })

  it('creates a task with wait query and JSON body', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.createTask(
      { goal: 'demo', agentId: 'rivet' },
      { wait: true, timeoutMs: 5000 },
    )
    expect(res.task.id).toBe('t-1')
    expect(captured.url).toContain('wait=1')
    expect(captured.url).toContain('timeoutMs=5000')
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ goal: 'demo', agentId: 'rivet' })
  })

  it('omits undefined query params', async () => {
    const gw = new RivetGateway({ baseUrl })
    await gw.listTasks({ agentId: 'rivet' })
    expect(captured.url).toBe('/api/tasks?agentId=rivet')
  })

  it('parses the catalog sheet', async () => {
    const gw = new RivetGateway({ baseUrl })
    const sheet = await gw.catalog()
    expect(sheet.node).toBe('testnode')
    expect(sheet.agents).toHaveLength(2)
  })

  it('stages an upload with raw body and query metadata', async () => {
    const gw = new RivetGateway({ baseUrl })
    const staged = await gw.stageUpload('shot.png', new Blob(['PNGBYTES']), {
      mime: 'image/png',
    })
    expect(staged.uri).toBe('/home/rivet/.rivetos/den/uploads/u1.png')
    expect(captured.url).toBe('/api/uploads?name=shot.png&mediaType=image%2Fpng')
    expect(captured.body).toBe('PNGBYTES')
  })

  it('transcribes audio and synthesizes speech via the voice proxy', async () => {
    const gw = new RivetGateway({ baseUrl })
    const out = await gw.voiceTranscribe(new Blob(['AUDIO']), 'audio/webm')
    expect(out.text).toBe('hello from mic')
    expect(captured.url).toBe('/api/voice/transcribe')
    expect(captured.contentType).toBe('audio/webm')
    const wav = await gw.voiceSpeak({ input: 'hi', instructions: 'warm' })
    expect(Buffer.from(wav).toString()).toBe('WAVBYTES')
    expect(captured.url).toBe('/api/voice/speak')
    expect(captured.contentType).toBe('application/json')
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ input: 'hi', instructions: 'warm' })
  })

  it('maps voice-proxy errors like the other raw-body endpoints', async () => {
    const gw = new RivetGateway({ baseUrl })
    await expect(gw.voiceTranscribe(new Blob(['NOCONF']), 'audio/wav')).rejects.toMatchObject({
      status: 501,
      message: 'voice transcription is not configured on this node',
    })
    const dead = new RivetGateway({ baseUrl: 'http://127.0.0.1:1' })
    await expect(dead.voiceSpeak({ input: 'hi' })).rejects.toMatchObject({ status: 0 })
  })

  it('fetches outcomes', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.outcomes({ agentId: 'rivet' })
    expect(res.totals.tasks).toBe(1)
  })

  it('returns raw markdown verbatim', async () => {
    const gw = new RivetGateway({ baseUrl })
    expect(await gw.wikiRaw('some-slug')).toBe('# raw markdown')
  })

  it('searches memory and reads health', async () => {
    const gw = new RivetGateway({ baseUrl })
    const search = await gw.memorySearch({ q: 'loopback' })
    expect(search.query).toBe('loopback')
    const health = await gw.memoryHealth()
    expect(health.status).toBe('ok')
  })

  it('throws GatewayError with the wire error message', async () => {
    const gw = new RivetGateway({ baseUrl })
    const err = await gw.getTask('missing').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(404)
    expect((err as GatewayError).message).toBe('no task missing')
  })

  it('wraps network failure into GatewayError status 0', async () => {
    const gw = new RivetGateway({ baseUrl: 'http://127.0.0.1:1' })
    const err = await gw.listSessions().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(0)
    expect((err as GatewayError).message).toContain('unreachable')
  })

  it('health() is true against the stub and false against a dead port', async () => {
    expect(await new RivetGateway({ baseUrl }).health()).toBe(true)
    expect(await new RivetGateway({ baseUrl: 'http://127.0.0.1:1' }).health()).toBe(false)
  })
})
