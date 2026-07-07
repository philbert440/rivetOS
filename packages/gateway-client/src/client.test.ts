import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  CatalogSheet,
  OutcomesResponse,
  SessionsListResponse,
  TaskResponse,
  TaskWire,
} from '@rivetos/types'
import { GatewayError } from './http.js'
import { RivetGateway } from './client.js'

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

interface Captured {
  method?: string
  url?: string
  auth?: string
  body?: string
}

let server: Server
let baseUrl: string
const captured: Captured = {}

function handle(req: IncomingMessage, res: ServerResponse): void {
  captured.method = req.method
  captured.url = req.url
  captured.auth = req.headers.authorization
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
  it('lists sessions', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.listSessions()
    expect(res.sessions[0].id).toBe('lobby')
    expect(captured.auth).toBeUndefined()
  })

  it('sends the bearer token when configured', async () => {
    const gw = new RivetGateway({ baseUrl, token: 'sekrit' })
    await gw.listSessions()
    expect(captured.auth).toBe('Bearer sekrit')
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

  it('fetches outcomes', async () => {
    const gw = new RivetGateway({ baseUrl })
    const res = await gw.outcomes({ agentId: 'rivet' })
    expect(res.totals.tasks).toBe(1)
  })

  it('returns raw markdown verbatim', async () => {
    const gw = new RivetGateway({ baseUrl })
    expect(await gw.wikiRaw('some-slug')).toBe('# raw markdown')
  })

  it('throws GatewayError with the wire error message', async () => {
    const gw = new RivetGateway({ baseUrl })
    const err = await gw.getTask('missing').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(404)
    expect((err as GatewayError).message).toBe('no task missing')
  })

  it('health() is true against the stub and false against a dead port', async () => {
    expect(await new RivetGateway({ baseUrl }).health()).toBe(true)
    expect(await new RivetGateway({ baseUrl: 'http://127.0.0.1:1' }).health()).toBe(false)
  })
})
