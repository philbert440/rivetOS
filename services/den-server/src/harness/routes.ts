/**
 * Harness control-plane gateway surface (Phase 2).
 *
 * Two route families, mounted by the den server behind its bearer gate exactly
 * like `/api/devices` and `/files/*`:
 *
 *   GET  /api/harnesses                              drivers + capability flags
 *   GET  /api/harnesses/:harnessId                   one driver's capabilities
 *   GET  /api/harnesses/:harnessId/sessions          listSessions
 *   POST /api/harnesses/:harnessId/sessions          startSession
 *   WS   /api/harnesses/ws[?harness=<id>]            registry stream
 *
 *   GET  /api/harness-sessions/:enc                  getSession
 *   GET  /api/harness-sessions/:enc/transcript       hard-resync source
 *   POST /api/harness-sessions/:enc/resume           resumeSession
 *   POST /api/harness-sessions/:enc/turns            sendUserTurn
 *   POST /api/harness-sessions/:enc/interrupt        interrupt
 *   POST /api/harness-sessions/:enc/approvals/:reqId resolveApproval
 *   WS   /api/harness-sessions/ws?session=<enc>      subscribe stream
 *
 * Attachment staging for those turns is the third, single-route family, in
 * `uploads.ts` (`POST /api/uploads`): it needs the node's state dir rather
 * than the registry, so den mounts it alongside these rather than through
 * them.
 *
 * `:enc` is `enc(SessionId)` — unpadded base64url of the UTF-8 SessionId
 * (`encodeSessionIdSegment`). Percent-encoded `/` inside a path segment is
 * unreliable across routers and proxies, and Claude's path-fallback capture
 * keys contain `/`. A bare native uuid is also accepted so the den drawer and
 * hub chat can migrate at leisure; the control plane aliases it to canonical.
 *
 * **Transport note.** The design doc writes the two streams as
 * `GET /harnesses/:id/events` and `GET /sessions/:sessionId/events`. den's WS
 * mounts are exact-path (`/ws`, `/term?id=`, `/api/sessions/ws`,
 * `/api/notifications/ws`) with the resource in the query string, so these
 * follow that existing convention rather than introducing dynamic-segment
 * upgrade matching. Names, payloads and semantics are otherwise the contract.
 *
 * The legacy `/term/harness-sessions/*` endpoints are untouched — the hub
 * still uses them (the doc prunes them in Phase 5).
 *
 * **Capabilities are runtime-truthed here.** Both capability reads
 * (`GET /api/harnesses`, `GET /api/harnesses/:harnessId`) `await
 * registry.verifyCapabilities()` before they answer, so the sheet is what the
 * node can do at the moment it is read rather than what it was configured to
 * hope: a node with terminals enabled but a failed `node-pty` import reports
 * `interrupt`/`resume` as `false`, matching the 501 its methods already gave.
 * The probe is memoized per driver, so the cost is one PTY-host resolution per
 * process — paid on the first capability read, which is also the first moment
 * an optimistic flag could have misled anyone.
 *
 * A flip that happens AFTER a client read the sheet rides the registry stream
 * as a `harness-capabilities` frame (`capabilities.ts` explains why it is a
 * den-level frame and not a `HarnessEvent`: the contract's union is
 * session-scoped, and a driver-level flip has no session to name). An attach to
 * `/api/harnesses/ws` also kicks a verify, so a client that only ever watches
 * the stream still learns the truth.
 *
 * **Known gap** (Phase 3+ work, recorded so clients aren't surprised):
 *
 *   - *Session status for out-of-den harnesses.* A harness process started
 *     outside den (no `RIVET_DEN_SESSION`) is invisible to its driver's live
 *     map and reads as `ended` until its den hooks speak. Sessions spawned
 *     through a driver or the `/term` drawer are adopted at spawn time.
 *
 * See docs/plans/harness-control-plane.md.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  HarnessError,
  decodeSessionIdSegment,
  type ApprovalDecision,
  type HarnessEvent,
  type HarnessTranscriptTurn,
  type SessionId,
  type UserTurn,
} from '@rivetos/types'
import { isBareNativeUuid } from './alias.js'
import type { HarnessCapabilityEvent } from './capabilities.js'
import { isHarnessId, type HarnessRegistry, type ResolvedSession } from './registry.js'

/** Drivers that can serve the hard-resync transcript (feature-detected). */
export interface HarnessTranscriptSource {
  transcript(sessionId: SessionId): Promise<{ turns: HarnessTranscriptTurn[] }>
}

/** HarnessErrorCode → HTTP, per packages/types/src/errors.ts. */
const ERROR_STATUS: Record<string, number> = {
  invalid_session_id: 400,
  session_id_collision: 409,
  capability_unsupported: 501,
  unknown_approval: 404,
  turn_in_flight: 409,
}

export function harnessErrorStatus(err: unknown): number {
  if (err instanceof HarnessError) return ERROR_STATUS[err.code] ?? 500
  return 500
}

const MAX_BODY_BYTES = 256 * 1024
const MAX_BUFFERED = 1024 * 1024

const json = (res: ServerResponse, code: number, body: unknown): boolean => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}

function fail(res: ServerResponse, err: unknown): boolean {
  if (err instanceof HarnessError) {
    return json(res, harnessErrorStatus(err), {
      error: err.message,
      code: err.code,
      retryable: err.retryable,
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  return json(res, 500, { error: message })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_BODY_BYTES) {
        req.pause()
        reject(new Error('body too large'))
        return
      }
      chunks.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Decode a `:sessionId` path segment. `enc(SessionId)` wins; a bare native
 * uuid is accepted as the documented legacy shape (den drawer / hub chat) and
 * resolved to canonical by the registry. Order matters: enc() is checked first
 * so a base64url string that happens to look like a uuid is never misread.
 */
export function decodeSessionSegment(segment: string): string {
  try {
    return decodeSessionIdSegment(segment)
  } catch (err) {
    if (isBareNativeUuid(segment)) return segment
    throw err
  }
}

export interface HarnessRoutes {
  /** `true` when the request was handled. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  /** `true` when the upgrade was handled (socket owned from here on). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean
  heartbeat(): void
  close(): void
}

export function createHarnessRoutes(opts: {
  registry: HarnessRegistry
  log?: (msg: string) => void
}): HarnessRoutes {
  const { registry } = opts
  const log = opts.log ?? ((): void => undefined)
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Map<WebSocket, { alive: boolean; off: () => void }>()

  const send = (ws: WebSocket, event: HarnessEvent | HarnessCapabilityEvent): void => {
    if (ws.readyState !== 1) return
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate()
      return
    }
    ws.send(JSON.stringify(event))
  }

  const attach = (
    ws: WebSocket,
    subscribe: (sink: (e: HarnessEvent | HarnessCapabilityEvent) => void) => () => void,
  ): void => {
    let off: () => void
    try {
      off = subscribe((e) => send(ws, e))
    } catch (err) {
      // capability_unsupported on a stream the node can't serve: say so on the
      // wire, then close — a silently-idle socket looks like a live stream.
      ws.send(
        JSON.stringify({
          type: 'error',
          code: err instanceof HarnessError ? err.code : 'error',
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      ws.close()
      return
    }
    clients.set(ws, { alive: true, off })
    ws.on('pong', () => {
      const entry = clients.get(ws)
      if (entry) entry.alive = true
    })
    const drop = (): void => {
      const entry = clients.get(ws)
      if (!entry) return
      clients.delete(ws)
      entry.off()
    }
    ws.on('close', drop)
    ws.on('error', () => {
      drop()
      ws.terminate()
    })
  }

  /** Resolve a `:enc` segment all the way to a driver, or answer the request. */
  const resolve = async (
    res: ServerResponse,
    segment: string,
  ): Promise<ResolvedSession | undefined> => {
    let raw: string
    try {
      raw = decodeSessionSegment(segment)
    } catch (err) {
      fail(res, err)
      return undefined
    }
    try {
      return await registry.resolve(raw)
    } catch (err) {
      fail(res, err)
      return undefined
    }
  }

  const parseJsonBody = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Record<string, unknown> | undefined> => {
    let body: string
    try {
      body = await readBody(req)
    } catch {
      json(res, 413, { error: 'body too large' })
      return undefined
    }
    if (body.trim() === '') return {}
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      json(res, 400, { error: 'invalid JSON' })
      return undefined
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      json(res, 400, { error: 'expected a JSON object' })
      return undefined
    }
    return raw as Record<string, unknown>
  }

  // -- /api/harnesses --------------------------------------------------------

  const handleHarnesses = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const rest = url.pathname.slice('/api/harnesses'.length).replace(/^\//, '')
    if (rest === '') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      // Truth the flags before publishing them: a declared-only sheet is how a
      // node with a failed `node-pty` advertises an interrupt it will 501.
      await registry.verifyCapabilities()
      return json(res, 200, { harnesses: registry.list() })
    }
    const parts: (string | undefined)[] = rest.split('/')
    const [harnessId = '', sub, ...extra] = parts
    if (extra.length > 0) return json(res, 404, { error: 'not found' })
    if (!isHarnessId(harnessId)) return json(res, 404, { error: `unknown harness: ${harnessId}` })
    const driver = registry.get(harnessId)
    if (!driver) return json(res, 404, { error: `no driver registered for ${harnessId}` })

    if (sub === undefined) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      await registry.verifyCapabilities(harnessId)
      return json(res, 200, { harnessId, capabilities: driver.capabilities })
    }
    if (sub !== 'sessions') return json(res, 404, { error: 'not found' })

    if (req.method === 'GET') {
      if (!driver.capabilities.listSessions) {
        return fail(
          res,
          new HarnessError('capability_unsupported', `${harnessId} cannot list sessions`, {
            harnessId,
          }),
        )
      }
      try {
        // Through the registry, not the driver: superseded ids must never
        // reach a client (§ Contract semantics, canonical-only listSessions).
        return json(res, 200, { sessions: await registry.listSessions(harnessId) })
      } catch (err) {
        return fail(res, err)
      }
    }
    if (req.method === 'POST') {
      const body = await parseJsonBody(req, res)
      if (!body) return true
      const { cwd, model, nativeSessionId, metadata } = body
      if (cwd !== undefined && typeof cwd !== 'string')
        return json(res, 400, { error: 'cwd must be a string' })
      if (model !== undefined && typeof model !== 'string')
        return json(res, 400, { error: 'model must be a string' })
      if (nativeSessionId !== undefined && typeof nativeSessionId !== 'string')
        return json(res, 400, { error: 'nativeSessionId must be a string' })
      if (
        metadata !== undefined &&
        (typeof metadata !== 'object' ||
          metadata === null ||
          Object.values(metadata).some((v) => typeof v !== 'string'))
      ) {
        return json(res, 400, { error: 'metadata must be a string map' })
      }
      // Alias chains occupy the namespace: a pinned id anywhere in one is a
      // collision even if the harness store itself has forgotten it. The rule
      // is control-plane-owned, so the registry enforces it.
      if (typeof nativeSessionId === 'string') {
        try {
          registry.assertPinnable(harnessId, nativeSessionId)
        } catch (err) {
          return fail(res, err)
        }
      }
      try {
        const summary = await driver.startSession({
          ...(cwd !== undefined ? { cwd } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
          ...(metadata !== undefined ? { metadata: metadata as Record<string, string> } : {}),
        })
        return json(res, 201, summary)
      } catch (err) {
        return fail(res, err)
      }
    }
    return json(res, 405, { error: 'method not allowed' })
  }

  // -- /api/harness-sessions -------------------------------------------------

  const handleSessions = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const rest = url.pathname.slice('/api/harness-sessions'.length).replace(/^\//, '')
    if (rest === '') return json(res, 404, { error: 'not found' })
    const parts: (string | undefined)[] = rest.split('/')
    const [segment = '', action, requestId, ...extra] = parts
    if (extra.length > 0) return json(res, 404, { error: 'not found' })

    const resolved = await resolve(res, segment)
    if (!resolved) return true
    const { driver, sessionId, requestedId } = resolved
    /** Superseded/legacy ids answer with the canonical they redirected to. */
    const redirect = requestedId ? { redirectedTo: sessionId } : {}

    if (action === undefined) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      try {
        const summary = await driver.getSession(sessionId)
        if (!summary) return json(res, 404, { error: `unknown session ${sessionId}` })
        return json(res, 200, { ...summary, ...redirect })
      } catch (err) {
        return fail(res, err)
      }
    }

    if (action === 'transcript') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const source = driver as unknown as Partial<HarnessTranscriptSource>
      if (typeof source.transcript !== 'function') {
        return fail(
          res,
          new HarnessError(
            'capability_unsupported',
            `${driver.harnessId} has no transcript source`,
            { harnessId: driver.harnessId, sessionId },
          ),
        )
      }
      try {
        const { turns } = await source.transcript(sessionId)
        return json(res, 200, {
          sessionId,
          harnessId: driver.harnessId,
          turns,
          ...redirect,
        })
      } catch (err) {
        return fail(res, err)
      }
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

    if (action === 'resume') {
      if (!driver.capabilities.resume) {
        return fail(
          res,
          new HarnessError('capability_unsupported', `${driver.harnessId} cannot resume`, {
            harnessId: driver.harnessId,
            sessionId,
          }),
        )
      }
      try {
        return json(res, 200, { ...(await driver.resumeSession(sessionId)), ...redirect })
      } catch (err) {
        return fail(res, err)
      }
    }

    if (action === 'interrupt') {
      if (!driver.capabilities.interrupt) {
        return fail(
          res,
          new HarnessError('capability_unsupported', `${driver.harnessId} cannot interrupt`, {
            harnessId: driver.harnessId,
            sessionId,
          }),
        )
      }
      try {
        await driver.interrupt(sessionId)
        return json(res, 202, { ok: true, sessionId, ...redirect })
      } catch (err) {
        return fail(res, err)
      }
    }

    if (action === 'turns') {
      const body = await parseJsonBody(req, res)
      if (!body) return true
      const { text, attachments } = body
      if (typeof text !== 'string' || text === '')
        return json(res, 400, { error: 'text (non-empty string) is required' })
      const turn: UserTurn = { text }
      if (attachments !== undefined) {
        if (
          !Array.isArray(attachments) ||
          attachments.some(
            (a) =>
              typeof a !== 'object' ||
              a === null ||
              typeof (a as { mime?: unknown }).mime !== 'string' ||
              typeof (a as { pathOrUri?: unknown }).pathOrUri !== 'string',
          )
        ) {
          return json(res, 400, { error: 'attachments must be {mime,pathOrUri,name?} objects' })
        }
        turn.attachments = attachments as UserTurn['attachments']
      }
      try {
        await driver.sendUserTurn(sessionId, turn)
        return json(res, 202, { ok: true, sessionId, ...redirect })
      } catch (err) {
        return fail(res, err)
      }
    }

    if (action === 'approvals') {
      if (!requestId) return json(res, 404, { error: 'approval requestId is required' })
      if (!driver.capabilities.approvals) {
        return fail(
          res,
          new HarnessError(
            'capability_unsupported',
            `${driver.harnessId} does not surface approvals`,
            { harnessId: driver.harnessId, sessionId },
          ),
        )
      }
      const body = await parseJsonBody(req, res)
      if (!body) return true
      const decision = body.decision
      if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-session') {
        return json(res, 400, { error: 'decision must be allow | deny | allow-session' })
      }
      try {
        await driver.resolveApproval(sessionId, requestId, decision satisfies ApprovalDecision)
        return json(res, 202, { ok: true, sessionId, requestId, ...redirect })
      } catch (err) {
        return fail(res, err)
      }
    }

    return json(res, 404, { error: 'not found' })
  }

  return {
    async handle(req, res, url): Promise<boolean> {
      try {
        if (url.pathname === '/api/harnesses' || url.pathname.startsWith('/api/harnesses/')) {
          if (url.pathname === '/api/harnesses/ws')
            return json(res, 426, { error: 'ws upgrade required' })
          return await handleHarnesses(req, res, url)
        }
        if (
          url.pathname === '/api/harness-sessions' ||
          url.pathname.startsWith('/api/harness-sessions/')
        ) {
          if (url.pathname === '/api/harness-sessions/ws')
            return json(res, 426, { error: 'ws upgrade required' })
          return await handleSessions(req, res, url)
        }
        return false
      } catch (err) {
        log(
          `[den-server] harness route failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        if (!res.headersSent) fail(res, err)
        return true
      }
    },

    handleUpgrade(req, socket, head, url): boolean {
      if (url.pathname === '/api/harnesses/ws') {
        const filter = url.searchParams.get('harness') ?? undefined
        if (filter !== undefined && !isHarnessId(filter)) {
          socket.destroy()
          return true
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Two streams, one socket: session lifecycle (the contract's
          // `HarnessEvent`s) and driver-level capability flips (a den frame —
          // see `capabilities.ts`). A client that does not know the second type
          // ignores it, which is why this needed no contract change.
          attach(ws, (sink) => {
            const offEvents = registry.subscribe(sink, filter)
            const offCapabilities = registry.subscribeCapabilities(sink, filter)
            return () => {
              offEvents()
              offCapabilities()
            }
          })
          // Kick a probe now that someone is listening: a watcher who never
          // GETs the sheet still learns about a flag that was never true.
          void registry.verifyCapabilities(filter)
        })
        return true
      }
      if (url.pathname === '/api/harness-sessions/ws') {
        const segment = url.searchParams.get('session') ?? ''
        if (!segment) {
          socket.destroy()
          return true
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          void (async (): Promise<void> => {
            let target: ResolvedSession
            try {
              target = await registry.resolve(decodeSessionSegment(segment))
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  code: err instanceof HarnessError ? err.code : 'error',
                  message: err instanceof Error ? err.message : String(err),
                }),
              )
              ws.close()
              return
            }
            // Registry, not driver: the tail must follow the alias chain, so
            // a rotation mid-stream never costs the client its socket
            // (§ Contract semantics, "Subscriptions survive rotation").
            attach(ws, (sink) => registry.subscribeSession(target.sessionId, sink))
          })()
        })
        return true
      }
      return false
    },

    heartbeat(): void {
      for (const [ws, entry] of [...clients]) {
        if (!entry.alive) {
          clients.delete(ws)
          entry.off()
          ws.terminate()
          continue
        }
        entry.alive = false
        ws.ping()
      }
    },

    close(): void {
      for (const [ws, entry] of [...clients]) {
        entry.off()
        ws.terminate()
      }
      clients.clear()
      wss.close()
    },
  }
}
