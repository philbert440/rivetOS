/**
 * First-class user tenancy registry.
 *
 * Source of truth: users.json (RIVETOS_USERS_FILE / `<shared>/rivetos/users.json`
 * / `~/.rivetos/users.json`). User id → device CN(s) → database handle →
 * persona. Resolve once at the TLS edge into a `UserContext`; nothing
 * downstream re-derives identity.
 *
 * A user is routable IFF they have a usable `UserDbEntry` (same policy as
 * user-dbs.ts). Mapped-without-a-DB fails closed — falling through to the
 * node owner is a data leak, not a default.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'
import { sharedDir } from './shared-dir.js'
import { isUsableUserDb, type UserDbEntry } from './user-dbs.js'

/** Identity resolved at the connection edge and carried through den. */
export interface UserContext {
  userId: string
  /** Bare device id (no `device:` prefix). Null = loopback / node operator. */
  deviceId: string | null
  db: UserDbEntry
  persona?: string
  /** Node owner — untagged sessions and loopback traffic belong here. */
  isOwner: boolean
}

export interface UserRecord {
  id: string
  devices: string[]
  db?: UserDbEntry
  persona?: string
}

export interface UsersRegistry {
  ownerUserId: string
  /**
   * When true, an enrolled device that is not in any user's `devices` list
   * resolves as the owner. A file registry should set false (fail closed).
   */
  unmappedIsOwner: boolean
  users: Record<string, UserRecord>
}

export type ResolveUserResult = { ok: true; ctx: UserContext } | { ok: false, error: string }

function asDeviceId(raw: string): string {
  const t = raw.trim()
  return t.startsWith('device:') ? t.slice('device:'.length) : t
}

function ownerRecord(registry: UsersRegistry): UserRecord | undefined {
  return registry.users[registry.ownerUserId]
}

function contextFor(
  registry: UsersRegistry,
  record: UserRecord,
  deviceId: string | null,
  db: UserDbEntry,
): UserContext {
  return {
    userId: record.id,
    deviceId,
    db,
    persona: record.persona,
    isOwner: record.id === registry.ownerUserId,
  }
}

function dbFor(record: UserRecord): UserDbEntry | undefined {
  return record.db && isUsableUserDb(record.db) ? record.db : undefined
}

/**
 * Parse a users.json document. Malformed input returns undefined and logs —
 * never throws. Secrets (`pgUrl`) are optional on the file; {@link loadUsersRegistry}
 * fills the owner from RIVETOS_PG_URL when omitted.
 */
export function parseUsersRegistry(raw: string | undefined): UsersRegistry | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    console.error('[rivetos] users registry is not valid JSON — tenancy file ignored')
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[rivetos] users registry is not a JSON object — tenancy file ignored')
    return undefined
  }
  const o = parsed as Record<string, unknown>
  const ownerUserId = typeof o.ownerUserId === 'string' ? o.ownerUserId.trim() : ''
  if (!ownerUserId) {
    console.error('[rivetos] users registry missing ownerUserId — tenancy file ignored')
    return undefined
  }
  const unmappedIsOwner = o.unmappedIsOwner === true
  const usersIn = o.users
  if (!usersIn || typeof usersIn !== 'object' || Array.isArray(usersIn)) {
    console.error('[rivetos] users registry.users is not an object — tenancy file ignored')
    return undefined
  }
  const users: Record<string, UserRecord> = {}
  for (const [id, rec] of Object.entries(usersIn as Record<string, unknown>)) {
    const uid = id.trim()
    if (!uid || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    const r = rec as Record<string, unknown>
    const devices: string[] = []
    if (Array.isArray(r.devices)) {
      for (const d of r.devices) {
        if (typeof d === 'string' && d.trim() !== '') devices.push(asDeviceId(d))
      }
    }
    let db: UserDbEntry | undefined
    if (typeof r.pgUrl === 'string' && r.pgUrl.trim()) {
      db = { pgUrl: r.pgUrl.trim() }
      if (typeof r.envFile === 'string' && r.envFile.trim()) db.envFile = r.envFile.trim()
    }
    const persona = typeof r.persona === 'string' && r.persona.trim() ? r.persona.trim() : undefined
    users[uid] = { id: uid, devices, db, persona }
  }
  if (!users[ownerUserId]) {
    users[ownerUserId] = { id: ownerUserId, devices: [] }
  }
  return { ownerUserId, unmappedIsOwner, users }
}

/**
 * Default node-owner user id when users.json / RIVETOS_OWNER_USER_ID is unset.
 * Fleet installs historically used `phil`; deployments override via
 * RIVETOS_OWNER_USER_ID (forwarded to the embedded den by buildGatewayEnv).
 */
export const DEFAULT_OWNER_USER_ID = 'phil'

export type EnvLike = Record<string, string | undefined>

export interface LoadUsersRegistryOptions {
  /** Explicit file path; overrides env.RIVETOS_USERS_FILE. */
  path?: string
  /** Injected file read (missing → undefined). Default: node:fs. */
  readFile?: (path: string) => string | undefined
  /** Injected homedir for the ~/.rivetos/users.json fallback. */
  homedir?: () => string
}

function defaultReadFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    console.error(`[rivetos] users registry "${path}" unreadable`)
    return undefined
  }
}

function failClosedOwner(env: EnvLike): UsersRegistry {
  const ownerUserId = env.RIVETOS_OWNER_USER_ID?.trim() || DEFAULT_OWNER_USER_ID
  return mergeUserDbs(
    {
      ownerUserId,
      unmappedIsOwner: false,
      users: { [ownerUserId]: { id: ownerUserId, devices: [] } },
    },
    undefined,
    env.RIVETOS_PG_URL,
  )
}

/**
 * Load users.json. Path resolution (first hit wins):
 *   1. opts.path or env.RIVETOS_USERS_FILE
 *   2. $RIVETOS_SHARED_DIR/rivetos/users.json (default /rivet-shared)
 *   3. ~/.rivetos/users.json
 *
 * Explicit path set but missing/invalid → fail-closed owner-only registry
 * (`unmappedIsOwner=false`). Shared-dir file present but invalid → same
 * fail-closed (does not fall through to home or tenancy-off). Absent
 * shared-dir file still falls through. No file anywhere → undefined
 * (tenancy off). Owner `pgUrl` is filled from RIVETOS_PG_URL when the
 * file omits it.
 */
export function loadUsersRegistry(
  env: EnvLike = process.env,
  opts?: LoadUsersRegistryOptions,
): UsersRegistry | undefined {
  const read = opts?.readFile ?? defaultReadFile
  const home = opts?.homedir ?? osHomedir
  const explicit = (opts?.path ?? env.RIVETOS_USERS_FILE)?.trim() || undefined
  const sharedRoot = env.RIVETOS_SHARED_DIR?.trim() || sharedDir()

  const tryParse = (path: string | undefined): UsersRegistry | undefined => {
    if (!path) return undefined
    const raw = read(path)
    if (raw === undefined) return undefined
    return parseUsersRegistry(raw)
  }

  if (explicit) {
    const fileReg = tryParse(explicit)
    if (!fileReg) {
      console.error(
        `[rivetos] RIVETOS_USERS_FILE="${explicit}" missing or invalid — ALL device identities refused (fail closed); fix or unset the file`,
      )
      return failClosedOwner(env)
    }
    return mergeUserDbs(fileReg, undefined, env.RIVETOS_PG_URL)
  }

  const sharedFile = join(sharedRoot, 'rivetos', 'users.json')
  const sharedRaw = read(sharedFile)
  if (sharedRaw !== undefined) {
    const fileReg = parseUsersRegistry(sharedRaw)
    if (!fileReg) {
      console.error(
        `[rivetos] users registry "${sharedFile}" exists but is invalid — ALL device identities refused (fail closed); fix the file`,
      )
      return failClosedOwner(env)
    }
    return mergeUserDbs(fileReg, undefined, env.RIVETOS_PG_URL)
  }

  const homeReg = tryParse(join(home(), '.rivetos', 'users.json'))
  if (!homeReg) return undefined
  return mergeUserDbs(homeReg, undefined, env.RIVETOS_PG_URL)
}

/**
 * Per-user db map for routing consumers. The owner is omitted — their store
 * is RIVETOS_PG_URL / the plugin main store. Unusable entries are dropped.
 * A user is routable IFF they appear here.
 */
export function userDbsFromRegistry(
  registry: UsersRegistry | undefined,
): Record<string, UserDbEntry> | undefined {
  if (!registry) return undefined
  const out: Record<string, UserDbEntry> = {}
  for (const rec of Object.values(registry.users)) {
    if (rec.id === registry.ownerUserId) continue
    const db = dbFor(rec)
    if (db) out[rec.id] = db
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Build a registry from device→user and user→db maps. Test / fixture helper;
 * production loads the file registry via {@link loadUsersRegistry}.
 */
export function registryFromEnv(opts: {
  deviceUsers?: Record<string, string>
  userDbs?: Record<string, UserDbEntry>
  ownerPgUrl?: string
  ownerUserId?: string
}): UsersRegistry | undefined {
  const ownerUserId = opts.ownerUserId?.trim() || DEFAULT_OWNER_USER_ID
  const users: Record<string, UserRecord> = {}
  const ownerDb = opts.ownerPgUrl?.trim() ? { pgUrl: opts.ownerPgUrl.trim() } : undefined
  users[ownerUserId] = { id: ownerUserId, devices: [], db: ownerDb }

  for (const [deviceId, userId] of Object.entries(opts.deviceUsers ?? {})) {
    const id = userId.trim()
    const dev = asDeviceId(deviceId)
    if (!id || !dev) continue
    if (!users[id]) users[id] = { id, devices: [] }
    if (!users[id].devices.includes(dev)) users[id].devices.push(dev)
  }
  for (const [userId, db] of Object.entries(opts.userDbs ?? {})) {
    const id = userId.trim()
    if (!id) continue
    if (!users[id]) users[id] = { id, devices: [] }
    users[id].db = db
  }

  const hasExtra = Object.keys(users).some((id) => id !== ownerUserId)
  if (!hasExtra && !opts.deviceUsers && !opts.userDbs) return undefined
  return { ownerUserId, unmappedIsOwner: true, users }
}

/** Fill missing db handles from a side map, then the owner PG URL. */
export function mergeUserDbs(
  registry: UsersRegistry,
  userDbs: Record<string, UserDbEntry> | undefined,
  ownerPgUrl?: string,
): UsersRegistry {
  const users: Record<string, UserRecord> = {}
  for (const [id, rec] of Object.entries(registry.users)) {
    const db =
      rec.db ??
      userDbs?.[id] ??
      (id === registry.ownerUserId && ownerPgUrl?.trim() ? { pgUrl: ownerPgUrl.trim() } : undefined)
    users[id] = { ...rec, db }
  }
  return { ...registry, users }
}

/**
 * Resolve a device (or loopback) to a UserContext.
 *
 * Fail closed: a mapped user without a usable DB, or an unknown device when
 * `unmappedIsOwner` is false, returns an error. Callers must refuse the
 * session — never fall through to another user's store.
 */
export function resolveUser(registry: UsersRegistry, deviceId: string | null): ResolveUserResult {
  const owner = ownerRecord(registry)
  if (!owner) return { ok: false, error: `owner user "${registry.ownerUserId}" is missing` }

  if (deviceId === null) {
    const db = dbFor(owner)
    if (!db) return { ok: false, error: `owner user "${owner.id}" has no usable database` }
    return { ok: true, ctx: contextFor(registry, owner, null, db) }
  }

  const bare = asDeviceId(deviceId)
  let matched: UserRecord | undefined
  for (const rec of Object.values(registry.users)) {
    if (rec.devices.includes(bare)) {
      matched = rec
      break
    }
  }

  if (!matched) {
    if (!registry.unmappedIsOwner) {
      return { ok: false, error: `device "${bare}" is not in the users registry` }
    }
    const db = dbFor(owner)
    if (!db) return { ok: false, error: `owner user "${owner.id}" has no usable database` }
    return { ok: true, ctx: contextFor(registry, owner, bare, db) }
  }

  const db = dbFor(matched)
  if (!db) {
    return {
      ok: false,
      error: `user "${matched.id}" has no usable database (mapped device "${bare}")`,
    }
  }
  return { ok: true, ctx: contextFor(registry, matched, bare, db) }
}

/** Sessions with no owner row belong to the node owner. */
export function sessionVisibleTo(ownerUserId: string | undefined, ctx: UserContext): boolean {
  if (!ownerUserId) return ctx.isOwner
  return ownerUserId === ctx.userId
}
