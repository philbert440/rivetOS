// Client half of the harness control-plane shape lock (see
// docs/ARCHITECTURE.md § Gateway surface (as built)). The stub server records the
// exact path/method/body it was called with, so these assertions pin the URL
// shapes — including `enc(SessionId)` round-tripping through ids that contain
// `:` and `/` — and the typed-error → GatewayError mapping.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  decodeSessionIdSegment,
  encodeSessionIdSegment,
  type HarnessesResponse,
  type HarnessSessionListResponse,
  type HarnessSessionSummary,
  type HarnessSessionTranscriptResponse,
  type HarnessTurnAccepted,
  type SessionId,
} from '@rivetos/types'
import { GatewayError } from './http.js'
import { RivetGateway } from './client.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
const SID = `claude-code:${UUID}` as SessionId
/** Claude's capture path fallback — a native id carrying a `/`. */
const PATH_SID = `claude-code:home-rivet-proj/${UUID}` as SessionId
/** Native ids may themselves contain `:` (split on the FIRST colon only). */
const COLON_SID = `grok-build:sess:${UUID}` as SessionId

const SUMMARY = {
  sessionId: SID,
  harnessId: 'claude-code',
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:01:00.000Z',
  status: 'idle',
} satisfies HarnessSessionSummary

const HARNESSES = {
  harnesses: [
    {
      harnessId: 'claude-code',
      capabilities: {
        interrupt: true,
        resume: true,
        approvals: false,
        liveStream: true,
        listSessions: true,
      },
    },
  ],
} satisfies HarnessesResponse

const TRANSCRIPT = {
  sessionId: SID,
  harnessId: 'claude-code',
  turns: [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ],
} satisfies HarnessSessionTranscriptResponse

interface Captured {
  method?: string
  path?: string
  query?: string
  body?: string
}

let server: Server
let baseUrl: string
const captured: Captured = {}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const [path = '', query = ''] = (req.url ?? '').split('?')
  captured.method = req.method
  captured.path = path
  captured.query = query
  let raw = ''
  req.on('data', (c: Buffer) => (raw += c.toString()))
  req.on('end', () => {
    captured.body = raw
    const respond = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (path === '/api/harnesses') return respond(200, HARNESSES)
    if (path === '/api/harnesses/claude-code') return respond(200, HARNESSES.harnesses[0])
    if (path === '/api/harnesses/claude-code/sessions' && req.method === 'GET') {
      return respond(200, { sessions: [SUMMARY] } satisfies HarnessSessionListResponse)
    }
    if (path === '/api/harnesses/claude-code/sessions' && req.method === 'POST') {
      return respond(201, SUMMARY)
    }
    const rest = path.startsWith('/api/harness-sessions/')
      ? path.slice('/api/harness-sessions/'.length).split('/')
      : []
    if (rest.length > 0) {
      const [segment = '', action, requestId] = rest
      // The stub decodes the segment the same way den does — a client that
      // hand-rolled the encoding would fail here, not in a shape assertion.
      let decoded: string
      try {
        decoded = decodeSessionIdSegment(segment)
      } catch {
        decoded = decodeURIComponent(segment)
      }
      if (action === undefined) return respond(200, { ...SUMMARY, sessionId: decoded })
      if (action === 'transcript') return respond(200, { ...TRANSCRIPT, sessionId: decoded })
      if (action === 'resume') return respond(200, { ...SUMMARY, sessionId: decoded })
      if (action === 'turns') {
        // The one typed error a chat client must handle by hand: v1 drivers
        // never queue, so a mid-turn send is the caller's problem.
        if (raw.includes('boom')) {
          return respond(409, { error: 'claude-code is mid-turn', code: 'turn_in_flight' })
        }
        return respond(202, { ok: true, sessionId: decoded } satisfies HarnessTurnAccepted)
      }
      if (action === 'interrupt') return respond(202, { ok: true, sessionId: decoded })
      if (action === 'approvals') {
        return respond(501, {
          error: 'claude-code does not surface approvals',
          code: 'capability_unsupported',
          requestId,
        })
      }
    }
    respond(500, { error: `unhandled ${req.method ?? '?'} ${path}` })
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

const gw = (): RivetGateway => new RivetGateway({ baseUrl })

describe('harness control plane — registry', () => {
  it('lists drivers with their capability flags', async () => {
    const res = await gw().harnesses()
    expect(captured.path).toBe('/api/harnesses')
    expect(res.harnesses[0].capabilities.approvals).toBe(false)
  })

  it('reads one driver capability sheet', async () => {
    const res = await gw().harnessCapabilities('claude-code')
    expect(captured.path).toBe('/api/harnesses/claude-code')
    expect(res.harnessId).toBe('claude-code')
  })

  it('lists a driver sessions and starts a new one', async () => {
    const list = await gw().harnessSessionList('claude-code')
    expect(captured.path).toBe('/api/harnesses/claude-code/sessions')
    expect(captured.method).toBe('GET')
    expect(list.sessions[0].sessionId).toBe(SID)

    const started = await gw().startHarnessSession('claude-code', { nativeSessionId: UUID })
    expect(captured.method).toBe('POST')
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ nativeSessionId: UUID })
    expect(started.harnessId).toBe('claude-code')
  })
})

describe('harness control plane — session segments', () => {
  it('encodes the path segment with enc(SessionId), not percent-encoding', async () => {
    await gw().getHarnessSession(SID)
    expect(captured.path).toBe(`/api/harness-sessions/${encodeSessionIdSegment(SID)}`)
    expect(captured.path).not.toContain('%3A')
  })

  it.each([
    ['plain uuid', SID],
    ['path-fallback native id (contains /)', PATH_SID],
    ['native id containing : ', COLON_SID],
  ])('round-trips %s through the segment codec', async (_label, sessionId) => {
    const res = await gw().getHarnessSession(sessionId)
    // The stub decoded the segment; getting the same id back proves the
    // round-trip end to end (a `/` in the segment would have split the path).
    expect(res.sessionId).toBe(sessionId)
    expect(captured.path?.split('/')).toHaveLength(4)
  })

  it('passes a bare native id through as a legacy segment', async () => {
    const res = await gw().getHarnessSession(UUID)
    expect(captured.path).toBe(`/api/harness-sessions/${UUID}`)
    expect(res.sessionId).toBe(UUID)
  })
})

describe('harness control plane — session operations', () => {
  it('resumes, sends a turn, and interrupts', async () => {
    const seg = encodeSessionIdSegment(SID)
    await gw().resumeHarnessSession(SID)
    expect(captured.method).toBe('POST')
    expect(captured.path).toBe(`/api/harness-sessions/${seg}/resume`)

    const accepted = await gw().sendHarnessTurn(SID, { text: 'go' })
    expect(captured.path).toBe(`/api/harness-sessions/${seg}/turns`)
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ text: 'go' })
    expect(accepted.ok).toBe(true)

    await gw().interruptHarnessSession(SID)
    expect(captured.path).toBe(`/api/harness-sessions/${seg}/interrupt`)
  })

  it('reads the hard-resync transcript', async () => {
    const res = await gw().harnessSessionTranscript(SID)
    expect(captured.path).toBe(`/api/harness-sessions/${encodeSessionIdSegment(SID)}/transcript`)
    expect(res.turns.map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('surfaces turn_in_flight as a 409 GatewayError carrying the wire code', async () => {
    const err = await gw()
      .sendHarnessTurn(SID, { text: 'boom' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(409)
    expect((err as GatewayError).message).toBe('claude-code is mid-turn')
    expect((err as GatewayError).body).toMatchObject({ code: 'turn_in_flight' })
  })

  it('surfaces capability_unsupported as a 501 GatewayError (claude approvals)', async () => {
    const err = await gw()
      .resolveHarnessApproval(SID, 'req-1', 'allow')
      .catch((e: unknown) => e)
    expect(captured.path).toBe(
      `/api/harness-sessions/${encodeSessionIdSegment(SID)}/approvals/req-1`,
    )
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ decision: 'allow' })
    expect((err as GatewayError).status).toBe(501)
    expect((err as GatewayError).body).toMatchObject({ code: 'capability_unsupported' })
  })
})

describe('harness control plane — websockets', () => {
  it('puts the session segment in the query string (no token)', () => {
    const urls: string[] = []
    const factory = (url: string): never => {
      urls.push(url)
      throw new Error('stop') // URL is all this asserts; no socket needed
    }
    const client = new RivetGateway({ baseUrl })
    expect(() => client.watchHarnessSession(PATH_SID, () => {}, { factory })).toThrow('stop')
    const parsed = new URL(urls[0])
    expect(parsed.protocol).toBe('ws:')
    expect(parsed.pathname).toBe('/api/harness-sessions/ws')
    expect(parsed.searchParams.get('session')).toBe(encodeSessionIdSegment(PATH_SID))
    expect(parsed.searchParams.get('token')).toBeNull()
  })

  it('filters the registry stream by harness id, and omits the filter when absent', () => {
    const urls: string[] = []
    const factory = (url: string): never => {
      urls.push(url)
      throw new Error('stop')
    }
    const client = new RivetGateway({ baseUrl })
    expect(() => client.watchHarnesses(() => {}, 'claude-code', { factory })).toThrow('stop')
    expect(new URL(urls[0]).searchParams.get('harness')).toBe('claude-code')
    expect(() => client.watchHarnesses(() => {}, undefined, { factory })).toThrow('stop')
    expect(new URL(urls[1]).searchParams.has('harness')).toBe(false)
  })
})
