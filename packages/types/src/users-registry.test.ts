import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadUsersRegistry,
  mergeUserDbs,
  parseUsersRegistry,
  registryFromEnv,
  resolveUser,
  sessionVisibleTo,
  userDbsFromRegistry,
} from './users-registry.js'

const cocoDb = { pgUrl: 'postgres://coco@db/coco_memory' }
const philDb = { pgUrl: 'postgres://phil@db/phil_memory' }

describe('parseUsersRegistry', () => {
  it('parses a file document and strips device: prefixes', () => {
    const reg = parseUsersRegistry(
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: ['pixel-phil'], pgUrl: philDb.pgUrl, persona: 'phil' },
          coco: { devices: ['device:win-coco'], pgUrl: cocoDb.pgUrl, persona: 'coco' },
        },
      }),
    )
    expect(reg?.ownerUserId).toBe('phil')
    expect(reg?.unmappedIsOwner).toBe(false)
    expect(reg?.users.coco.devices).toEqual(['win-coco'])
    expect(reg?.users.coco.db).toEqual(cocoDb)
  })

  it('returns undefined on malformed JSON', () => {
    expect(parseUsersRegistry('{nope')).toBeUndefined()
    expect(parseUsersRegistry('[]')).toBeUndefined()
    expect(parseUsersRegistry('{"users":{}}')).toBeUndefined()
  })
})

describe('registryFromEnv', () => {
  it('synthesizes coco + owner and leaves unmappedIsOwner on', () => {
    const reg = registryFromEnv({
      deviceUsers: { 'win-coco': 'coco' },
      userDbs: { coco: cocoDb },
      ownerPgUrl: philDb.pgUrl,
      ownerUserId: 'phil',
    })
    expect(reg?.unmappedIsOwner).toBe(true)
    expect(reg?.users.coco.devices).toEqual(['win-coco'])
    expect(reg?.users.coco.db).toEqual(cocoDb)
    expect(reg?.users.phil.db).toEqual(philDb)
  })
})

describe('resolveUser', () => {
  const reg = mergeUserDbs(
    parseUsersRegistry(
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: ['pixel-phil'], persona: 'phil' },
          coco: { devices: ['win-coco'], persona: 'coco' },
        },
      }),
    )!,
    { coco: cocoDb },
    philDb.pgUrl,
  )

  it('resolves loopback as the owner', () => {
    const r = resolveUser(reg, null)
    expect(r.ok && r.ctx.userId).toBe('phil')
    expect(r.ok && r.ctx.isOwner).toBe(true)
    expect(r.ok && r.ctx.deviceId).toBeNull()
  })

  it('resolves win-coco as coco with her db', () => {
    const r = resolveUser(reg, 'win-coco')
    expect(r.ok && r.ctx.userId).toBe('coco')
    expect(r.ok && r.ctx.isOwner).toBe(false)
    expect(r.ok && r.ctx.db).toEqual(cocoDb)
  })

  it('fails closed on an unknown device when unmappedIsOwner is false', () => {
    const r = resolveUser(reg, 'stranger')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not in the users registry/)
  })

  it('fails closed when a mapped user has no database', () => {
    const broken = parseUsersRegistry(
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [], pgUrl: philDb.pgUrl },
          coco: { devices: ['win-coco'] },
        },
      }),
    )!
    const r = resolveUser(broken, 'win-coco')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no usable database/)
  })

  it('env bootstrap treats unmapped devices as owner', () => {
    const envReg = registryFromEnv({
      deviceUsers: { 'win-coco': 'coco' },
      userDbs: { coco: cocoDb },
      ownerPgUrl: philDb.pgUrl,
    })!
    const r = resolveUser(envReg, 'pixel-phil')
    expect(r.ok && r.ctx.userId).toBe('phil')
    expect(r.ok && r.ctx.isOwner).toBe(true)
  })
})

describe('loadUsersRegistry', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  })

  function emptyDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'users-reg-'))
    dirs.push(dir)
    return dir
  }

  it('loads a file via explicit path and fills owner pgUrl from env', () => {
    const dir = emptyDir()
    const file = join(dir, 'users.json')
    writeFileSync(
      file,
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [] },
          coco: { devices: ['win-coco'], pgUrl: cocoDb.pgUrl },
        },
      }),
    )
    const reg = loadUsersRegistry(
      { RIVETOS_PG_URL: philDb.pgUrl },
      { path: file, homedir: () => dir },
    )
    expect(reg?.users.phil.db).toEqual(philDb)
    expect(reg?.users.coco.db).toEqual(cocoDb)
    const r = resolveUser(reg!, 'win-coco')
    expect(r.ok && r.ctx.userId).toBe('coco')
  })

  it('resolves $shared/rivetos/users.json when no explicit path is set', () => {
    const dir = emptyDir()
    mkdirSync(join(dir, 'rivetos'))
    writeFileSync(
      join(dir, 'rivetos', 'users.json'),
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [], pgUrl: philDb.pgUrl },
          coco: { devices: ['win-coco'], pgUrl: cocoDb.pgUrl },
        },
      }),
    )
    const reg = loadUsersRegistry(
      { RIVETOS_SHARED_DIR: dir },
      { homedir: () => join(dir, 'no-home') },
    )
    expect(resolveUser(reg!, 'win-coco').ok).toBe(true)
  })

  it('fails closed when the explicit file is missing', () => {
    const dir = emptyDir()
    const reg = loadUsersRegistry(
      {
        RIVETOS_USERS_FILE: join(dir, 'missing.json'),
        RIVETOS_PG_URL: philDb.pgUrl,
      },
      { homedir: () => dir },
    )
    expect(reg?.unmappedIsOwner).toBe(false)
    expect(resolveUser(reg!, 'win-coco').ok).toBe(false)
    expect(resolveUser(reg!, null).ok).toBe(true)
  })

  it('env-var-only configuration yields NO routing', () => {
    // Deletion is behavioral: leftover #561 env maps must not synthesize a registry.
    const dir = emptyDir()
    const reg = loadUsersRegistry(
      {
        RIVETOS_USER_DBS: '{"coco":{"pgUrl":"postgres://coco@db/coco_memory"}}',
        RIVETOS_DEN_DEVICE_USERS: '{"win-coco":"coco"}',
        RIVETOS_PG_URL: philDb.pgUrl,
        RIVETOS_SHARED_DIR: dir,
      },
      { homedir: () => dir },
    )
    expect(reg).toBeUndefined()
    expect(userDbsFromRegistry(reg)).toBeUndefined()
  })
})

describe('userDbsFromRegistry', () => {
  it('omits the owner and drops users without a usable db', () => {
    const reg = parseUsersRegistry(
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [], pgUrl: philDb.pgUrl },
          coco: { devices: ['win-coco'], pgUrl: cocoDb.pgUrl },
          ghost: { devices: ['win-ghost'] },
        },
      }),
    )
    expect(userDbsFromRegistry(reg)).toEqual({ coco: cocoDb })
  })
})

describe('sessionVisibleTo', () => {
  const coco = {
    userId: 'coco',
    deviceId: 'win-coco',
    db: cocoDb,
    isOwner: false,
  }
  const phil = {
    userId: 'phil',
    deviceId: null,
    db: philDb,
    isOwner: true,
  }
  it('hides untagged sessions from a routed user', () => {
    expect(sessionVisibleTo(undefined, coco)).toBe(false)
    expect(sessionVisibleTo(undefined, phil)).toBe(true)
  })
  it('shows a session only to its owner', () => {
    expect(sessionVisibleTo('coco', coco)).toBe(true)
    expect(sessionVisibleTo('coco', phil)).toBe(false)
    expect(sessionVisibleTo('phil', phil)).toBe(true)
  })
})
