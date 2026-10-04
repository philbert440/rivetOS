/**
 * Backend-neutral memory routes: `POST /api/capture` and `/api/memory/*`
 * served from a `MemoryBackend`. The wire contract is the one the Postgres
 * routes serve (types in `@rivetos/types` gateway-api), so the hub's Memory
 * pages, the harness capture hooks and the MCP sidecar's den transport work
 * on any backend that implements the interface.
 *
 * HARD INVARIANT (same as the Postgres routes): only mount behind
 * den-server's strip-and-stamp of `x-rivetos-user`. An absent header means
 * the node owner. A backend serves one store, so a request stamped for a
 * routed user is refused: it must never fall through to the owner's data.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  MemoryRequestError,
  MemoryUnsupportedError,
  parseTagLiteral,
  routedUserResult,
} from '@rivetos/types'
import type {
  CaptureBatchRequest,
  CaptureMessage,
  GatewayRoute,
  MemoryBackend,
  MemoryTagsBackend,
  Tag,
  TagEntityType,
  TagState,
  Tool,
} from '@rivetos/types'

const MAX_CAPTURE_BYTES = 1024 * 1024
const MAX_JSON_BYTES = 256 * 1024

const TOO_LARGE = Symbol('body too large')

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Read a bounded body. On overflow the socket is closed once the 413 is out. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | typeof TOO_LARGE> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > max) {
      req.pause()
      return TOO_LARGE
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  const socket = req.socket
  const closeSocket = (): void => {
    socket.destroy()
  }
  res.once('finish', closeSocket)
  res.once('close', closeSocket)
  res.setHeader('connection', 'close')
  json(res, 413, { error: 'body too large' })
}

async function readJsonObject(
  req: IncomingMessage,
  res: ServerResponse,
  max: number,
): Promise<Record<string, unknown> | undefined> {
  const raw = await readBody(req, max)
  if (raw === TOO_LARGE) {
    tooLarge(req, res)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    json(res, 400, { error: 'invalid JSON' })
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    json(res, 400, { error: 'body must be a JSON object' })
    return undefined
  }
  return parsed as Record<string, unknown>
}

/** Owner requests only. Returns false after answering a routed or malformed one. */
function ownerOnly(req: IncomingMessage, res: ServerResponse): boolean {
  const routed = routedUserResult(req.headers)
  if (routed.kind === 'invalid') {
    json(res, 503, { error: 'malformed routing identity' })
    return false
  }
  if (routed.kind !== 'owner') {
    json(res, 503, { error: `memory is not available for user "${routed.id}"` })
    return false
  }
  return true
}

function fail(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof MemoryRequestError) return json(res, 400, { error: message })
  if (err instanceof MemoryUnsupportedError) return json(res, 501, { error: message })
  json(res, 500, { error: message })
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a capture body. Returns the batch, or a message saying what is wrong. */
export function parseCaptureBatch(body: unknown): CaptureBatchRequest | string {
  if (!isRecord(body)) return 'body must be a JSON object'
  const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
  const optString = (name: string): string | undefined | null => {
    const v = body[name]
    if (v === undefined) return undefined
    return typeof v === 'string' ? v : null
  }
  if (!nonBlank(body.session_key)) return 'session_key is required'
  if (!nonBlank(body.agent)) return 'agent is required'
  const channel = optString('channel')
  const title = optString('title')
  const taskId = optString('task_id')
  if (channel === null) return 'channel must be a string'
  if (title === null) return 'title must be a string'
  if (taskId === null) return 'task_id must be a string'
  if (body.settings !== undefined && !isRecord(body.settings)) return 'settings must be an object'
  if (body.finalize !== undefined && typeof body.finalize !== 'boolean') {
    return 'finalize must be a boolean'
  }
  if (!Array.isArray(body.messages)) return 'messages must be an array'
  const messages: CaptureMessage[] = []
  for (const [i, raw] of (body.messages as unknown[]).entries()) {
    const at = `messages[${String(i)}]`
    if (!isRecord(raw)) return `${at} must be an object`
    if (typeof raw.event_id !== 'string' || raw.event_id.length === 0) {
      return `${at}.event_id is required`
    }
    if (typeof raw.role !== 'string' || !ROLES.has(raw.role)) return `${at}.role is invalid`
    if (typeof raw.content !== 'string') return `${at}.content must be a string`
    if (raw.tool_name !== undefined && typeof raw.tool_name !== 'string') {
      return `${at}.tool_name must be a string`
    }
    if (raw.tool_result !== undefined && typeof raw.tool_result !== 'string') {
      return `${at}.tool_result must be a string`
    }
    if (raw.metadata !== undefined && !isRecord(raw.metadata)) {
      return `${at}.metadata must be an object`
    }
    if (
      raw.created_at !== undefined &&
      (typeof raw.created_at !== 'string' ||
        !ISO_WITH_OFFSET.test(raw.created_at) ||
        Number.isNaN(Date.parse(raw.created_at)))
    ) {
      return `${at}.created_at must be an ISO timestamp with an offset`
    }
    messages.push({
      event_id: raw.event_id,
      role: raw.role as CaptureMessage['role'],
      content: raw.content,
      ...(raw.tool_name !== undefined ? { tool_name: raw.tool_name } : {}),
      ...(raw.tool_args !== undefined ? { tool_args: raw.tool_args } : {}),
      ...(raw.tool_result !== undefined ? { tool_result: raw.tool_result } : {}),
      ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
      ...(raw.created_at !== undefined ? { created_at: raw.created_at } : {}),
    })
  }
  return {
    session_key: body.session_key,
    agent: body.agent,
    ...(channel !== undefined ? { channel } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(body.settings !== undefined ? { settings: body.settings } : {}),
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    ...(body.finalize !== undefined ? { finalize: body.finalize } : {}),
    messages,
  }
}

/** `POST /api/capture` on a `MemoryBackend`. */
export function createBackendCaptureRoute(backend: MemoryBackend): GatewayRoute {
  return {
    prefix: '/api/capture',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!ownerOnly(req, res)) return
        const raw = await readBody(req, MAX_CAPTURE_BYTES)
        if (raw === TOO_LARGE) return tooLarge(req, res)
        let body: unknown
        try {
          body = JSON.parse(raw.toString('utf8'))
        } catch {
          return json(res, 400, { error: 'invalid JSON' })
        }
        const batch = parseCaptureBatch(body)
        if (typeof batch === 'string') return json(res, 400, { error: batch })
        return json(res, 200, await backend.capture(batch, { allowFilesystem: true }))
      } catch (err) {
        fail(res, err)
      }
    },
  }
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name)
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(Math.trunc(n), lo), hi)
}

/** `/api/memory/{search,browse,stats,health,tool/<name>,tags/*}` on a `MemoryBackend`. */
export function createBackendMemoryRoute(backend: MemoryBackend): GatewayRoute {
  let tools: Tool[] | undefined
  return {
    prefix: '/api/memory',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const parts = url.pathname.slice('/api/memory'.length).replace(/^\//, '').split('/')
        const head = parts[0]
        const method = req.method ?? 'GET'
        if (head === 'tool') {
          if (method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        } else if (head === 'tags') {
          if (method !== 'GET' && method !== 'POST') {
            return json(res, 405, { error: 'method not allowed' })
          }
        } else if (method !== 'GET') {
          return json(res, 405, { error: 'method not allowed' })
        }
        if (!ownerOnly(req, res)) return

        if (head === 'tool') {
          const name = parts[1]
          if (parts.length !== 2 || !name) return json(res, 404, { error: 'unknown memory tool' })
          const args = await readJsonObject(req, res, MAX_JSON_BYTES)
          if (!args) return
          tools ??= backend.tools()
          const tool = tools.find((candidate) => candidate.name === name)
          if (!tool) return json(res, 404, { error: 'unknown memory tool' })
          return json(res, 200, { ok: true, result: await tool.execute(args) })
        }
        if (head === 'tags') {
          return await handleTags(req, res, url, parts.slice(1).filter(Boolean), backend.tags())
        }
        if (head === 'search') {
          const q = (url.searchParams.get('q') ?? '').trim()
          if (!q) return json(res, 400, { error: 'q required' })
          const scopeRaw = url.searchParams.get('scope') ?? 'both'
          const scope =
            scopeRaw === 'messages' || scopeRaw === 'summaries' || scopeRaw === 'both'
              ? scopeRaw
              : 'both'
          const tag = url.searchParams.get('tag')
          if (tag && !parseTagLiteral(tag))
            return json(res, 400, { error: 'tag must be key:value' })
          return json(
            res,
            200,
            await backend.search(q, {
              scope,
              limit: clamp(intParam(url, 'limit', 20), 1, 50),
              ...(tag ? { tag } : {}),
            }),
          )
        }
        if (head === 'browse') {
          const tag = url.searchParams.get('tag')
          if (tag && !parseTagLiteral(tag))
            return json(res, 400, { error: 'tag must be key:value' })
          const pick = (name: string): string | undefined => url.searchParams.get(name) || undefined
          return json(
            res,
            200,
            await backend.browse({
              role: pick('role'),
              agent: pick('agent'),
              toolName: pick('tool_name'),
              tag: tag ?? undefined,
              window: pick('window'),
              since: pick('since'),
              before: pick('before'),
              limit: clamp(intParam(url, 'limit', 50), 1, 200),
            }),
          )
        }
        if (head === 'stats') return json(res, 200, await backend.stats())
        if (head === 'health') return json(res, 200, await backend.health())
        return json(res, 404, { error: 'unknown memory resource' })
      } catch (err) {
        fail(res, err)
      }
    },
  }
}

const TAG_STATES: readonly string[] = ['suggested', 'accepted', 'rejected']
const ENTITY_TYPES: readonly string[] = ['conversation', 'summary']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isTagState(v: unknown): v is TagState {
  return typeof v === 'string' && TAG_STATES.includes(v)
}
function isEntityType(v: unknown): v is TagEntityType {
  return typeof v === 'string' && ENTITY_TYPES.includes(v)
}
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

const BAD_STATE = Symbol('bad state')

function statesParam(raw: string | null): TagState[] | undefined | typeof BAD_STATE {
  if (!raw) return undefined
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (!tokens.every(isTagState)) return BAD_STATE
  return tokens.length > 0 ? tokens : undefined
}

/** The owner may name who decided; the default is "owner". */
function decider(body: Record<string, unknown>): string {
  return typeof body.decided_by === 'string' && body.decided_by.trim() !== ''
    ? body.decided_by.trim().slice(0, 120)
    : 'owner'
}

async function handleTags(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sub: string[],
  tags: MemoryTagsBackend,
): Promise<void> {
  const path = sub.join('/')
  if ((req.method ?? 'GET') === 'GET') {
    if (path === '') {
      const entityType = url.searchParams.get('entity_type')
      if (entityType && !isEntityType(entityType)) {
        return json(res, 400, { error: 'bad entity_type' })
      }
      const entityId = url.searchParams.get('entity_id')
      if (entityId && !isUuid(entityId)) return json(res, 400, { error: 'bad entity_id' })
      const states = statesParam(url.searchParams.get('state'))
      if (states === BAD_STATE) return json(res, 400, { error: 'bad state' })
      return json(res, 200, {
        tags: await tags.list({
          ...(isEntityType(entityType) ? { entityType } : {}),
          entityId: entityId ?? undefined,
          key: url.searchParams.get('key') ?? undefined,
          value: url.searchParams.get('value') ?? undefined,
          states,
          limit: intParam(url, 'limit', 200),
        }),
      })
    }
    if (path === 'pending') {
      return json(res, 200, { tags: await tags.pending(intParam(url, 'limit', 50)) })
    }
    if (path === 'counts') {
      return json(res, 200, {
        counts: await tags.counts(
          url.searchParams.get('key') ?? undefined,
          intParam(url, 'limit', 200),
        ),
      })
    }
    if (path === 'taxonomy') {
      const states = statesParam(url.searchParams.get('state'))
      if (states === BAD_STATE) return json(res, 400, { error: 'bad state' })
      return json(res, 200, {
        entries: await tags.taxonomy({
          key: url.searchParams.get('key') ?? undefined,
          states,
          limit: intParam(url, 'limit', 500),
        }),
      })
    }
    return json(res, 404, { error: 'unknown tags resource' })
  }

  const body = await readJsonObject(req, res, MAX_JSON_BYTES)
  if (!body) return
  try {
    if (path === 'decide') {
      const ids = strings(body.ids)
      const state = body.state
      if (ids.length === 0) return json(res, 400, { error: 'ids required' })
      if (!ids.every(isUuid)) return json(res, 400, { error: 'ids must be uuids' })
      if (ids.length > 1000) return json(res, 400, { error: 'at most 1000 ids' })
      if (state !== 'accepted' && state !== 'rejected') {
        return json(res, 400, { error: 'state must be accepted or rejected' })
      }
      return json(res, 200, { changed: await tags.decide(ids, state, decider(body)) })
    }
    if (path === 'add') {
      const hasEntity = typeof body.entity_id === 'string' && body.entity_id !== ''
      if (hasEntity && !isUuid(body.entity_id)) return json(res, 400, { error: 'bad entity_id' })
      const hasSession = typeof body.session_key === 'string' && body.session_key !== ''
      if (!isEntityType(body.entity_type) || (!hasEntity && !hasSession)) {
        return json(res, 400, { error: 'entity_type and entity_id (or session_key) required' })
      }
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      const tag = await tags.add(
        {
          entityType: body.entity_type,
          entityId: hasEntity ? (body.entity_id as string) : undefined,
          sessionKey: hasSession ? (body.session_key as string) : undefined,
          agent: typeof body.agent === 'string' && body.agent !== '' ? body.agent : undefined,
          tag: str(body.tag),
          key: str(body.key),
          value: str(body.value),
          display: str(body.display),
          reason: str(body.reason),
        },
        decider(body),
      )
      return json(res, 200, { tag })
    }
    if (path === 'lookup') {
      const keys = strings(body.session_keys)
      if (keys.length === 0) return json(res, 400, { error: 'session_keys required' })
      if (keys.length > 500) return json(res, 400, { error: 'at most 500 session_keys' })
      if (Array.isArray(body.states) && !body.states.every(isTagState)) {
        return json(res, 400, { error: 'bad state' })
      }
      const states = Array.isArray(body.states) ? body.states.filter(isTagState) : undefined
      const map = await tags.forSessionKeys(keys, states && states.length > 0 ? states : undefined)
      const sessions: Record<string, Tag[]> = {}
      for (const [k, v] of map) sessions[k] = v
      return json(res, 200, { sessions })
    }
    if (path === 'taxonomy') {
      if (!tags.upsertTaxonomy) throw new MemoryUnsupportedError(VOCABULARY_READ_ONLY)
      if (typeof body.key !== 'string' || typeof body.value !== 'string') {
        return json(res, 400, { error: 'key and value required' })
      }
      const entry = await tags.upsertTaxonomy({
        key: body.key,
        value: body.value,
        display: typeof body.display === 'string' ? body.display : undefined,
        parentValue:
          body.parent_value === null || typeof body.parent_value === 'string'
            ? body.parent_value
            : undefined,
        aliases: Array.isArray(body.aliases) ? strings(body.aliases) : undefined,
        state: isTagState(body.state) ? body.state : undefined,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      })
      return json(res, 200, { entry })
    }
    if (path === 'taxonomy/decide') {
      if (!tags.decideTaxonomy) throw new MemoryUnsupportedError(VOCABULARY_READ_ONLY)
      const entries = Array.isArray(body.entries)
        ? body.entries.filter(
            (e): e is { key: string; value: string } =>
              isRecord(e) && typeof e.key === 'string' && typeof e.value === 'string',
          )
        : []
      if (entries.length === 0) return json(res, 400, { error: 'entries required' })
      if (body.state !== 'accepted' && body.state !== 'rejected') {
        return json(res, 400, { error: 'state must be accepted or rejected' })
      }
      return json(res, 200, { changed: await tags.decideTaxonomy(entries, body.state) })
    }
    if (path === 'taxonomy/merge') {
      if (!tags.mergeTaxonomy) throw new MemoryUnsupportedError(VOCABULARY_READ_ONLY)
      if (
        typeof body.key !== 'string' ||
        typeof body.from !== 'string' ||
        typeof body.into !== 'string'
      ) {
        return json(res, 400, { error: 'key, from and into required' })
      }
      return json(res, 200, await tags.mergeTaxonomy(body.key, body.from, body.into))
    }
    return json(res, 404, { error: 'unknown tags resource' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      !(err instanceof MemoryUnsupportedError) &&
      /required|invalid|cannot be|needs one key|no conversation captured|at most/.test(msg)
    ) {
      return json(res, 400, { error: msg })
    }
    throw err
  }
}

const VOCABULARY_READ_ONLY = 'this memory backend does not edit the tag vocabulary'
