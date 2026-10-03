/**
 * /api/memory/tags — the hub's tag surface. Dispatched from memory-api.ts
 * after its routing gate, so `pool` is already the right tenant.
 *
 *   GET  /api/memory/tags?entity_type=&entity_id=&key=&value=&state=a,b&limit=
 *   GET  /api/memory/tags/pending?limit=            review queue, newest first
 *   GET  /api/memory/tags/counts?key=&limit=        accepted usage, for group-by
 *   GET  /api/memory/tags/taxonomy?key=&state=
 *   POST /api/memory/tags/decide     { ids, state: accepted|rejected, decided_by? }
 *   POST /api/memory/tags/add        { entity_type, entity_id | session_key, tag | key+value, display?, reason? }
 *   POST /api/memory/tags/lookup     { session_keys: [...] , states? }  → { [session_key]: Tag[] }
 *   POST /api/memory/tags/taxonomy   { key, value, display?, parent_value?, aliases?, state?, reason? }
 *   POST /api/memory/tags/taxonomy/decide  { entries: [{key,value}], state }
 *   POST /api/memory/tags/taxonomy/merge   { key, from, into }
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Tag, TagState } from '@rivetos/types'
import type pg from 'pg'
import {
  addTag,
  decideTags,
  decideTaxonomy,
  isEntityType,
  isTagState,
  listTags,
  listTaxonomy,
  mergeTaxonomyValue,
  pendingTags,
  tagCounts,
  tagsForSessionKeys,
  upsertTaxonomy,
} from '../tags/store.js'

const MAX_BODY_BYTES = 256 * 1024

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const BODY_TOO_LARGE = Symbol('body too large')

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | typeof BODY_TOO_LARGE> {
  const chunks: Buffer[] = []
  let size = 0
  // Leave the request intact on overflow so the 413 can flush before socket teardown.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) {
      req.pause()
      return BODY_TOO_LARGE
    }
    chunks.push(buf)
  }
  if (size === 0) throw new SyntaxError('invalid JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SyntaxError('invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

const BAD_STATE = Symbol('bad state')

/** Comma-separated states. An unknown token is the caller's error, not "use the default". */
function statesParam(raw: string | null | undefined): TagState[] | undefined | typeof BAD_STATE {
  if (!raw) return undefined
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (!tokens.every(isTagState)) return BAD_STATE
  return tokens.length > 0 ? tokens : undefined
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name)
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids reach `::uuid` casts; a malformed one is the caller's 400, not a 500. */
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

/**
 * Who decided, for the audit columns. A routed user is always recorded as
 * themselves. The owner surface (the hub, which knows which person is at the
 * keyboard) may name the decider in `decided_by`.
 */
function decider(body: Record<string, unknown>, who: Routed): string {
  if (!who.owner) return who.id
  const routedId = who.id
  return typeof body.decided_by === 'string' && body.decided_by.trim() !== ''
    ? body.decided_by.trim().slice(0, 120)
    : routedId
}

/** The identity memory-api resolved for this request. */
export interface Routed {
  /** Audit name: 'owner' or the routed user id. */
  id: string
  /** True only for the node owner's (unstamped) requests. */
  owner: boolean
}

function isMissingTagSchema(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /relation "?ros_tag[a-z_]*"? does not exist/i.test(msg)
}

/** Empty 200 body for a GET on a database that has not run migration 0019. */
function emptyTagsBody(path: string): unknown {
  if (path === 'counts') return { counts: [] }
  if (path === 'taxonomy') return { entries: [] }
  return { tags: [] }
}

/**
 * Entry point. On a database without the tag tables (migration 0019 not
 * applied) reads answer with their empty shape and writes with 503 — a
 * mutation must never look like it succeeded.
 */
export async function handleTags(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sub: string[],
  pool: pg.Pool,
  routed: Routed,
): Promise<void> {
  try {
    await handleTagsInner(req, res, url, sub, pool, routed)
  } catch (err) {
    if (!isMissingTagSchema(err)) throw err
    const path = sub.join('/')
    if ((req.method ?? 'GET') === 'GET') return json(res, 200, emptyTagsBody(path))
    // lookup is a read that happens to carry a body.
    if (path === 'lookup') return json(res, 200, { sessions: {} })
    return json(res, 503, {
      error: 'tag tables are missing: apply migration 0019 (rivetos db migrate)',
    })
  }
}

async function handleTagsInner(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  /** Path segments after `tags`. */
  sub: string[],
  pool: pg.Pool,
  routed: Routed,
): Promise<void> {
  const method = req.method ?? 'GET'
  const path = sub.join('/')

  if (method === 'GET') {
    if (path === '') {
      const entityType = url.searchParams.get('entity_type')
      if (entityType && !isEntityType(entityType))
        return json(res, 400, { error: 'bad entity_type' })
      const entityIdParam = url.searchParams.get('entity_id')
      if (entityIdParam && !isUuid(entityIdParam)) return json(res, 400, { error: 'bad entity_id' })
      const listStates = statesParam(url.searchParams.get('state'))
      if (listStates === BAD_STATE) return json(res, 400, { error: 'bad state' })
      const tags = await listTags(pool, {
        ...(isEntityType(entityType) ? { entityType } : {}),
        entityId: url.searchParams.get('entity_id') ?? undefined,
        key: url.searchParams.get('key') ?? undefined,
        value: url.searchParams.get('value') ?? undefined,
        states: listStates,
        limit: intParam(url, 'limit', 200),
      })
      return json(res, 200, { tags })
    }
    if (path === 'pending')
      return json(res, 200, { tags: await pendingTags(pool, intParam(url, 'limit', 50)) })
    if (path === 'counts') {
      return json(res, 200, {
        counts: await tagCounts(
          pool,
          url.searchParams.get('key') ?? undefined,
          intParam(url, 'limit', 200),
        ),
      })
    }
    if (path === 'taxonomy') {
      const taxStates = statesParam(url.searchParams.get('state'))
      if (taxStates === BAD_STATE) return json(res, 400, { error: 'bad state' })
      return json(res, 200, {
        entries: await listTaxonomy(pool, {
          key: url.searchParams.get('key') ?? undefined,
          states: taxStates,
          limit: intParam(url, 'limit', 500),
        }),
      })
    }
    return json(res, 404, { error: 'unknown tags resource' })
  }

  if (method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  let body: Record<string, unknown>
  try {
    const read = await readBody(req)
    if (read === BODY_TOO_LARGE) {
      const socket = req.socket
      const closeSocket = (): void => {
        socket.destroy()
      }
      res.once('finish', closeSocket)
      res.once('close', closeSocket)
      res.setHeader('connection', 'close')
      return json(res, 413, { error: 'body too large' })
    }
    body = read
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'invalid JSON' })
  }

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
      const changed = await decideTags(pool, ids, state, decider(body, routed))
      return json(res, 200, { changed })
    }
    if (path === 'add') {
      const hasEntity = typeof body.entity_id === 'string' && body.entity_id !== ''
      if (hasEntity && !isUuid(body.entity_id)) return json(res, 400, { error: 'bad entity_id' })
      const hasSession = typeof body.session_key === 'string' && body.session_key !== ''
      if (!isEntityType(body.entity_type) || (!hasEntity && !hasSession)) {
        return json(res, 400, { error: 'entity_type and entity_id (or session_key) required' })
      }
      const tag = await addTag(
        pool,
        {
          entityType: body.entity_type,
          entityId: hasEntity ? (body.entity_id as string) : undefined,
          sessionKey: hasSession ? (body.session_key as string) : undefined,
          agent: typeof body.agent === 'string' && body.agent !== '' ? body.agent : undefined,
          tag: typeof body.tag === 'string' ? body.tag : undefined,
          key: typeof body.key === 'string' ? body.key : undefined,
          value: typeof body.value === 'string' ? body.value : undefined,
          display: typeof body.display === 'string' ? body.display : undefined,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        },
        decider(body, routed),
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
      const map = await tagsForSessionKeys(
        pool,
        keys,
        states && states.length > 0 ? states : undefined,
      )
      const sessions: Record<string, Tag[]> = {}
      for (const [k, v] of map) sessions[k] = v
      return json(res, 200, { sessions })
    }
    if (path === 'taxonomy') {
      if (typeof body.key !== 'string' || typeof body.value !== 'string') {
        return json(res, 400, { error: 'key and value required' })
      }
      const entry = await upsertTaxonomy(pool, {
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
      const entries = Array.isArray(body.entries)
        ? body.entries.filter(
            (e): e is { key: string; value: string } =>
              typeof e === 'object' &&
              e !== null &&
              typeof (e as { key?: unknown }).key === 'string' &&
              typeof (e as { value?: unknown }).value === 'string',
          )
        : []
      if (entries.length === 0) return json(res, 400, { error: 'entries required' })
      if (body.state !== 'accepted' && body.state !== 'rejected') {
        return json(res, 400, { error: 'state must be accepted or rejected' })
      }
      return json(res, 200, { changed: await decideTaxonomy(pool, entries, body.state) })
    }
    if (path === 'taxonomy/merge') {
      if (
        typeof body.key !== 'string' ||
        typeof body.from !== 'string' ||
        typeof body.into !== 'string'
      ) {
        return json(res, 400, { error: 'key, from and into required' })
      }
      return json(res, 200, await mergeTaxonomyValue(pool, body.key, body.from, body.into))
    }
    return json(res, 404, { error: 'unknown tags resource' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Validation errors thrown by the store are the caller's fault.
    if (/required|invalid|cannot be|needs one key|no conversation captured|at most/.test(msg))
      return json(res, 400, { error: msg })
    throw err
  }
}
