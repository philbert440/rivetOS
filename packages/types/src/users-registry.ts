/**
 * First-class user tenancy registry.
 *
 * Replaces the #561 env maps (`RIVETOS_DEN_DEVICE_USERS` / `RIVETOS_USER_DBS`)
 * as the source of truth: user id → device CN(s) → database handle → persona.
 * Resolve once at the TLS edge into a `UserContext`; nothing downstream
 * re-derives identity.
 *
 * A user is routable IFF they have a usable `UserDbEntry` (same policy as
 * user-dbs.ts). Mapped-without-a-DB fails closed — falling through to the
 * node owner is a data leak, not a default.
 */

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
   * resolves as the owner. Env-bootstrap sets this so existing Phil certs
   * keep working before they are listed. A file registry should set false
   * (fail closed).
   */
  unmappedIsOwner: boolean
  users: Record<string, UserRecord>
}

export type ResolveUserResult = { ok: true; ctx: UserContext } | { ok: false; error: string }

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

/**
 * Parse a users.json document. Malformed input returns undefined and logs —
 * never throws. Secrets (`pgUrl`) are optional on the file; callers merge
 * `UserDbEntry` maps separately.
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
 * Strangler: build a registry from the live #561 env maps so Coco's capture
 * path keeps working before a users.json is written.
 */
export function registryFromEnv(opts: {
  deviceUsers?: Record<string, string>
  userDbs?: Record<string, UserDbEntry>
  ownerPgUrl?: string
  ownerUserId?: string
}): UsersRegistry | undefined {
  const ownerUserId = opts.ownerUserId?.trim() || 'phil'
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

/** Merge pgUrl/envFile from the env map onto registry users that lack a db. */
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

function dbFor(record: UserRecord): UserDbEntry | undefined {
  return record.db && isUsableUserDb(record.db) ? record.db : undefined
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
