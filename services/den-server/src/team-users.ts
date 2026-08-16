/**
 * rivet-team household users.
 *
 * Each user owns a dedicated schema (`team_u_<handle>`) and a dedicated
 * role (`rivet_team_<handle>`). That role is granted USAGE/CRUD on *that*
 * schema only. It is never granted anything on `ros_messages` /
 * `ros_conversations` / `ros_summaries` — the Rivet agent corpus stays
 * unreachable even if a client is buggy.
 *
 * Default store is a JSON file under stateDir (review / no-datahub). When
 * `RIVETOS_TEAM_PG_ADMIN_URL` is set, ensureUserSchema also mints the
 * schema+role on datahub. Pair redeem is unauthenticated (one-time code),
 * same posture as /api/devices/enroll.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import pg from 'pg'
import type {
  TeamCreateUserRequest,
  TeamDevice,
  TeamMeResponse,
  TeamNote,
  TeamNoteCreateRequest,
  TeamNotesSearchResponse,
  TeamPairRedeemRequest,
  TeamPairRedeemResponse,
  TeamPairStartResponse,
  TeamPersona,
  TeamPersonaCreateRequest,
  TeamPersonaResponse,
  TeamPersonasResponse,
  TeamUser,
  TeamUserResponse,
  TeamUsersListResponse,
} from '@rivetos/types'

export type {
  TeamCreateUserRequest,
  TeamDevice,
  TeamMeResponse,
  TeamNote,
  TeamNoteCreateRequest,
  TeamNotesSearchResponse,
  TeamPairRedeemRequest,
  TeamPairRedeemResponse,
  TeamPairStartResponse,
  TeamPersona,
  TeamPersonaCreateRequest,
  TeamPersonaResponse,
  TeamPersonasResponse,
  TeamUser,
  TeamUserResponse,
  TeamUsersListResponse,
}

const PG_IDENT = /^[a-z][a-z0-9_]*$/
const HANDLE = /^[a-z][a-z0-9_]{1,31}$/
const PAIR_TTL_MS = 15 * 60 * 1000
const TEAM_BEARER = /^Bearer\s+(.+)$/i

/** Strict handle → schema / role identifiers. Never interpolate raw input. */
export function teamSchemaName(handle: string): string {
  const h = normalizeHandle(handle)
  const name = `team_u_${h}`
  if (!PG_IDENT.test(name) || name.length > 63) {
    throw new Error(`schema name rejected: ${name}`)
  }
  return name
}

export function teamRoleName(handle: string): string {
  const h = normalizeHandle(handle)
  const name = `rivet_team_${h}`
  if (!PG_IDENT.test(name) || name.length > 63) {
    throw new Error(`role name rejected: ${name}`)
  }
  return name
}

const RESERVED = /^(ros_|pg_|rivet_team_|team_u_)/

export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase()
  if (!HANDLE.test(h)) throw new Error(`invalid team handle: ${handle}`)
  if (h === 'public' || RESERVED.test(h)) {
    throw new Error(`reserved team handle: ${handle}`)
  }
  return h
}

function pgIdent(name: string): string {
  if (!PG_IDENT.test(name)) throw new Error(`refusing unsafe pg identifier: ${name}`)
  return `"${name}"`
}

function pgLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * DDL applied inside the user's schema. No references to ros_* tables.
 * Identifiers are already allowlisted.
 */
export function userSchemaSql(schema: string, role: string): string {
  const s = pgIdent(schema)
  const r = pgIdent(role)
  return `
CREATE SCHEMA IF NOT EXISTS ${s};
REVOKE ALL ON SCHEMA ${s} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${s} TO ${r};
GRANT CREATE ON SCHEMA ${s} TO ${r};

CREATE TABLE IF NOT EXISTS ${s}.personas (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  system_prompt text NOT NULL DEFAULT '',
  thread_id text NOT NULL,
  created_at bigint NOT NULL,
  sample boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS ${s}.notes (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  persona_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at bigint NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ${s}.personas TO ${r};
GRANT SELECT, INSERT, UPDATE, DELETE ON ${s}.notes TO ${r};

ALTER TABLE ${s}.personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${s}.notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personas_owner ON ${s}.personas;
DROP POLICY IF EXISTS notes_owner ON ${s}.notes;
CREATE POLICY personas_owner ON ${s}.personas
  USING (user_id = current_setting('rivet.team_user', true))
  WITH CHECK (user_id = current_setting('rivet.team_user', true));
CREATE POLICY notes_owner ON ${s}.notes
  USING (user_id = current_setting('rivet.team_user', true))
  WITH CHECK (user_id = current_setting('rivet.team_user', true));
`.trim()
}

export interface TeamSchemaAdmin {
  ensureUserSchema(handle: string): Promise<{ schema: string; role: string; url: string }>
  dropUserSchema(handle: string): Promise<void>
}

export function createPgTeamSchemaAdmin(cfg: {
  adminUrl: string
  log?: (msg: string) => void
}): TeamSchemaAdmin {
  const log = cfg.log ?? (() => {})
  const withClient = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({
      connectionString: cfg.adminUrl,
      connectionTimeoutMillis: 10_000,
    })
    await client.connect()
    try {
      return await fn(client)
    } finally {
      await client.end().catch(() => {})
    }
  }

  return {
    async ensureUserSchema(handle) {
      const schema = teamSchemaName(handle)
      const role = teamRoleName(handle)
      const password = randomBytes(24).toString('base64url')
      const roleId = pgIdent(role)
      const passLit = pgLiteral(password)
      await withClient(async (client) => {
        const exists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
          [role],
        )
        if (exists.rows[0]?.exists) {
          await client.query(`ALTER ROLE ${roleId} LOGIN PASSWORD ${passLit}`)
        } else {
          await client.query(`CREATE ROLE ${roleId} LOGIN PASSWORD ${passLit}`)
        }
        // Team roles must not inherit public/ros_* access.
        await client.query(`REVOKE ALL ON SCHEMA public FROM ${roleId}`)
        await client.query(userSchemaSql(schema, role))
      })
      const url = new URL(cfg.adminUrl)
      url.username = role
      url.password = password
      log(`[team] ensured schema ${schema} role ${role}`)
      // DSN is returned so a later connect-as-role path can use it.
      // Never put this on the public TeamUser wire.
      return { schema, role, url: url.toString() }
    },

    async dropUserSchema(handle) {
      const schema = teamSchemaName(handle)
      const role = teamRoleName(handle)
      const schemaId = pgIdent(schema)
      const roleId = pgIdent(role)
      await withClient(async (client) => {
        await client.query(`DROP SCHEMA IF EXISTS ${schemaId} CASCADE`)
        const exists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
          [role],
        )
        if (exists.rows[0]?.exists) {
          await client.query(`ALTER ROLE ${roleId} NOLOGIN`)
          await client
            .query(
              `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`,
              [role],
            )
            .catch(() => {})
          await client.query(`DROP OWNED BY ${roleId}`)
          await client.query(`DROP ROLE IF EXISTS ${roleId}`)
        }
      })
      log(`[team] dropped schema ${schema} role ${role}`)
    },
  }
}

interface PairingCode {
  code: string
  userId: string
  expiresAt: number
  redeemedAt?: number
}

interface StoredDevice extends TeamDevice {
  token: string
}

interface StoredUser extends TeamUser {
  /** Minted role DSN when RIVETOS_TEAM_PG_ADMIN_URL is set. Never public. */
  pgUrl?: string
}

interface FileState {
  users: StoredUser[]
  pairing: PairingCode[]
  devices: StoredDevice[]
  personas: TeamPersona[]
  notes: TeamNote[]
}

const EMPTY: FileState = {
  users: [],
  pairing: [],
  devices: [],
  personas: [],
  notes: [],
}

function uuid(): string {
  return randomBytes(16).toString('hex')
}

function token(): string {
  return randomBytes(32).toString('base64url')
}

function pairCode(): string {
  return randomBytes(16).toString('hex')
}

function defaultPersonas(userId: string): TeamPersona[] {
  const now = Date.now()
  return [
    {
      id: uuid(),
      userId,
      name: 'Research assistant',
      systemPrompt:
        'You help the user investigate questions. Prefer primary sources, flag uncertainty, and keep open threads visible.',
      threadId: `session-${userId.slice(0, 8)}-research`,
      createdAt: now,
      sample: true,
    },
    {
      id: uuid(),
      userId,
      name: 'Summarizer',
      systemPrompt:
        'You condense long material into tight briefs. Lead with the answer, then bullets, then action items.',
      threadId: `session-${userId.slice(0, 8)}-summarizer`,
      createdAt: now,
      sample: true,
    },
    {
      id: uuid(),
      userId,
      name: 'Informatics',
      systemPrompt:
        'You turn messy notes and logs into structured facts the user can reuse. Prefer tables, named entities, and stable ids.',
      threadId: `session-${userId.slice(0, 8)}-informatics`,
      createdAt: now,
      sample: true,
    },
  ]
}

function loadState(file: string): FileState {
  if (!existsSync(file)) return structuredClone(EMPTY)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FileState
    return {
      users: parsed.users ?? [],
      pairing: parsed.pairing ?? [],
      devices: parsed.devices ?? [],
      personas: parsed.personas ?? [],
      notes: parsed.notes ?? [],
    }
  } catch {
    return structuredClone(EMPTY)
  }
}

function saveState(file: string, state: FileState): void {
  // File holds live device tokens (and optional minted DSNs); owner-only.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

function publicUser(u: TeamUser): TeamUser {
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.displayName,
    schemaName: u.schemaName,
    roleName: u.roleName,
    createdAt: u.createdAt,
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-rivet-team-token',
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

const readJson = (req: IncomingMessage, limit = 32 * 1024): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (d: Buffer) => {
      size += d.length
      if (size > limit) {
        req.pause()
        reject(new Error('body too large'))
        return
      }
      chunks.push(d)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })

const tokenEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function teamTokenFrom(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  const m = TEAM_BEARER.exec(header)
  if (m) return m[1]
  const named = req.headers['x-rivet-team-token']
  if (typeof named === 'string' && named) return named
  return ''
}

export interface TeamUsersRoutes {
  /** Unauthenticated pair redeem. Call BEFORE the den bearer gate. */
  handleRedeem(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  /** All other /api/team/* routes. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

export function createTeamUsersRoutes(opts: {
  stateDir: string
  /** Den mesh bearer. When set, create-user / start-pair require it. */
  denToken: string
  /** Loopback / enrolled-device check from server.ts. Optional in unit tests. */
  isOperator?: (req: IncomingMessage) => boolean
  stateFile?: string
  schemaAdmin?: TeamSchemaAdmin | null
  now?: () => number
  log?: (msg: string) => void
}): TeamUsersRoutes {
  const file = opts.stateFile?.trim() || join(opts.stateDir, 'team-users.json')
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const admin = opts.schemaAdmin ?? null
  const denToken = opts.denToken

  const withState = <T>(fn: (state: FileState) => T): T => {
    const state = loadState(file)
    const result = fn(state)
    saveState(file, state)
    return result
  }

  const requireOperator = (req: IncomingMessage, url: URL, res: ServerResponse): boolean => {
    if (opts.isOperator?.(req)) return true
    if (!denToken) {
      if (!opts.isOperator) return true
    } else {
      const header = req.headers.authorization ?? ''
      const m = TEAM_BEARER.exec(header)
      const q = url.searchParams.get('token') ?? ''
      const got = m?.[1] ?? q
      if (got && tokenEqual(got, denToken)) return true
    }
    json(res, 401, { error: 'operator token required' })
    return false
  }

  const deviceFor = (state: FileState, tok: string): StoredDevice | undefined =>
    tok ? state.devices.find((d) => tokenEqual(d.token, tok)) : undefined

  const requireDevice = (
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
    state: FileState,
  ): StoredDevice | undefined => {
    const tok = teamTokenFrom(req)
    const dev = deviceFor(state, tok)
    if (!dev) {
      json(res, 401, { error: 'team device token required' })
      return undefined
    }
    return dev
  }

  return {
    async handleRedeem(req, res, url) {
      if (url.pathname !== '/api/team/pair/redeem') return false
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return true
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true
      let body: TeamPairRedeemRequest
      try {
        body = (await readJson(req)) as TeamPairRedeemRequest
      } catch (err) {
        json(res, 400, { error: (err as Error).message })
        return true
      }
      const code = (body.code ?? '').trim().toLowerCase()
      if (!code) return json(res, 400, { error: 'code required' }), true
      const result = withState((state) => {
        const row = state.pairing.find((p) => p.code === code)
        if (!row || row.redeemedAt || row.expiresAt < now()) return null
        const user = state.users.find((u) => u.id === row.userId)
        if (!user) return null
        row.redeemedAt = now()
        const device: StoredDevice = {
          id: uuid(),
          userId: user.id,
          label: (body.label ?? 'device').slice(0, 80),
          createdAt: now(),
          token: token(),
        }
        state.devices.push(device)
        const out: TeamPairRedeemResponse = {
          user: publicUser(user),
          deviceId: device.id,
          deviceToken: device.token,
        }
        return out
      })
      if (!result) return json(res, 400, { error: 'invalid or expired code' }), true
      log(`[team] redeemed pair code for user ${result.user.handle}`)
      json(res, 200, result)
      return true
    },

    async handle(req, res, url) {
      if (url.pathname !== '/api/team' && !url.pathname.startsWith('/api/team/')) return false
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return true
      }

      if (url.pathname === '/api/team/users' && req.method === 'GET') {
        if (!requireOperator(req, url, res)) return true
        const body: TeamUsersListResponse = {
          users: loadState(file).users.map(publicUser),
        }
        json(res, 200, body)
        return true
      }

      if (url.pathname === '/api/team/users' && req.method === 'POST') {
        if (!requireOperator(req, url, res)) return true
        let body: TeamCreateUserRequest
        try {
          body = (await readJson(req)) as TeamCreateUserRequest
        } catch (err) {
          json(res, 400, { error: (err as Error).message })
          return true
        }
        let handle: string
        try {
          handle = normalizeHandle(body.handle ?? '')
        } catch (err) {
          json(res, 400, { error: (err as Error).message })
          return true
        }
        const displayName = (body.displayName ?? handle).trim().slice(0, 80) || handle
        let mintedUrl: string | undefined
        try {
          if (admin) {
            const minted = await admin.ensureUserSchema(handle)
            mintedUrl = minted.url
          }
        } catch (err) {
          json(res, 502, { error: `schema mint failed: ${(err as Error).message}` })
          return true
        }
        const created = withState((state) => {
          if (state.users.some((u) => u.handle === handle)) return 'exists' as const
          const user: StoredUser = {
            id: uuid(),
            handle,
            displayName,
            schemaName: teamSchemaName(handle),
            roleName: teamRoleName(handle),
            createdAt: now(),
            ...(mintedUrl ? { pgUrl: mintedUrl } : {}),
          }
          state.users.push(user)
          state.personas.push(...defaultPersonas(user.id))
          return user
        })
        if (created === 'exists') return json(res, 409, { error: 'handle taken' }), true
        const out: TeamUserResponse = { user: publicUser(created) }
        json(res, 201, out)
        return true
      }

      const pairStart = url.pathname.match(/^\/api\/team\/users\/([^/]+)\/pair$/)
      if (pairStart && req.method === 'POST') {
        if (!requireOperator(req, url, res)) return true
        const userId = decodeURIComponent(pairStart[1])
        const created = withState((state) => {
          const user = state.users.find((u) => u.id === userId)
          if (!user) return null
          const row: PairingCode = {
            code: pairCode(),
            userId: user.id,
            expiresAt: now() + PAIR_TTL_MS,
          }
          state.pairing.push(row)
          const out: TeamPairStartResponse = { code: row.code, expiresAt: row.expiresAt }
          return out
        })
        if (!created) return json(res, 404, { error: 'user not found' }), true
        json(res, 200, created)
        return true
      }

      if (url.pathname === '/api/team/me' && req.method === 'GET') {
        const state = loadState(file)
        const dev = requireDevice(req, url, res, state)
        if (!dev) return true
        const user = state.users.find((u) => u.id === dev.userId)
        if (!user) return json(res, 404, { error: 'user not found' }), true
        const out: TeamMeResponse = {
          user: publicUser(user),
          device: { id: dev.id, userId: dev.userId, label: dev.label, createdAt: dev.createdAt },
        }
        json(res, 200, out)
        return true
      }

      if (url.pathname === '/api/team/personas' && req.method === 'GET') {
        const state = loadState(file)
        const dev = requireDevice(req, url, res, state)
        if (!dev) return true
        const out: TeamPersonasResponse = {
          personas: state.personas.filter((p) => p.userId === dev.userId),
        }
        json(res, 200, out)
        return true
      }

      if (url.pathname === '/api/team/personas' && req.method === 'POST') {
        const state0 = loadState(file)
        const dev = requireDevice(req, url, res, state0)
        if (!dev) return true
        let body: TeamPersonaCreateRequest
        try {
          body = (await readJson(req)) as TeamPersonaCreateRequest
        } catch (err) {
          json(res, 400, { error: (err as Error).message })
          return true
        }
        const name = (body.name ?? '').trim().slice(0, 80)
        if (!name) return json(res, 400, { error: 'name required' }), true
        const persona = withState((state) => {
          const p: TeamPersona = {
            id: uuid(),
            userId: dev.userId,
            name,
            systemPrompt: (body.systemPrompt ?? '').slice(0, 4000),
            threadId: `session-${uuid()}`,
            createdAt: now(),
          }
          state.personas.push(p)
          return p
        })
        const out: TeamPersonaResponse = { persona }
        json(res, 201, out)
        return true
      }

      if (url.pathname === '/api/team/notes' && req.method === 'POST') {
        const state0 = loadState(file)
        const dev = requireDevice(req, url, res, state0)
        if (!dev) return true
        let body: TeamNoteCreateRequest
        try {
          body = (await readJson(req)) as TeamNoteCreateRequest
        } catch (err) {
          json(res, 400, { error: (err as Error).message })
          return true
        }
        const content = (body.content ?? '').trim()
        if (!content) return json(res, 400, { error: 'content required' }), true
        const note = withState((state) => {
          const owns = state.personas.some(
            (p) => p.id === body.personaId && p.userId === dev.userId,
          )
          if (!owns) return null
          const n: TeamNote = {
            id: uuid(),
            userId: dev.userId,
            personaId: body.personaId,
            role: (body.role ?? 'user').slice(0, 32),
            content: content.slice(0, 16_000),
            createdAt: now(),
          }
          state.notes.push(n)
          return n
        })
        if (!note) return json(res, 404, { error: 'persona not found' }), true
        json(res, 201, { note })
        return true
      }

      if (url.pathname === '/api/team/notes/search' && req.method === 'GET') {
        const state = loadState(file)
        const dev = requireDevice(req, url, res, state)
        if (!dev) return true
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
        const notes = state.notes.filter((n) => {
          if (n.userId !== dev.userId) return false
          if (!q) return true
          return n.content.toLowerCase().includes(q)
        })
        const out: TeamNotesSearchResponse = { notes: notes.slice(0, limit) }
        json(res, 200, out)
        return true
      }

      json(res, 404, { error: 'not found' })
      return true
    },
  }
}
