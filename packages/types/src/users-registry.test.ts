import { describe, expect, it } from 'vitest'
import {
  mergeUserDbs,
  parseUsersRegistry,
  registryFromEnv,
  resolveUser,
  sessionVisibleTo,
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
  it('synthesizes coco + owner and leaves unmappedIsOwner on (strangler)', () => {
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
