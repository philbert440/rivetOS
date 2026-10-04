import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  clearUserTokens,
  mintUserToken,
  registryFromEnv,
  resolveUser,
  resolveUserById,
  type UsersRegistry,
} from '@rivetos/types'
import { captureEnvFor, resolveRequestUser, stampUserHeader } from './identity.js'

const cocoDb = { pgUrl: 'postgres://coco@db/coco_memory', envFile: '/tmp/coco.env' }
const ownerDb = { pgUrl: 'postgres://owner@db/rivet_memory' }

describe('captureEnvFor', () => {
  const reg = registryFromEnv({
    deviceUsers: { 'win-coco': 'coco' },
    userDbs: { coco: cocoDb },
    ownerPgUrl: ownerDb.pgUrl,
  })!

  it('does not emit env for the owner (main store stays the process default)', () => {
    const r = resolveUser(reg, null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(captureEnvFor(r.ctx)).toBeUndefined()
  })

  it('emits USER_ID + PG_URL for coco and never USER_DBS', () => {
    const r = resolveUser(reg, 'win-coco')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const env = captureEnvFor(r.ctx)
    expect(env).toEqual({
      RIVETOS_USER_ID: 'coco',
      RIVETOS_PG_URL: cocoDb.pgUrl,
      RIVETOS_ENV_FILE: cocoDb.envFile,
    })
    expect(env && 'RIVETOS_USER_DBS' in env).toBe(false)
  })
})

describe('per-user tokens on a node with file stores', () => {
  const registry: UsersRegistry = {
    ownerUserId: 'alice',
    unmappedIsOwner: false,
    users: {
      alice: { id: 'alice', devices: [] },
      guest: { id: 'guest', devices: ['dev1'] },
    },
    localStores: true,
  }
  const request = (remoteAddress: string, headers: Record<string, string | string[]>): IncomingMessage =>
    ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage

  it('a spawned session gets a token instead of a database URL', () => {
    clearUserTokens()
    const resolved = resolveUserById(registry, 'guest')
    if (!resolved.ok) throw new Error(resolved.error)
    const env = captureEnvFor(resolved.ctx)
    expect(env).toEqual({ RIVETOS_USER_ID: 'guest', RIVETOS_USER_TOKEN: mintUserToken('guest') })
  })

  it('loopback with a minted token is that user; without one it is the owner', () => {
    clearUserTokens()
    const token = mintUserToken('guest')
    const withToken = resolveRequestUser(registry, request('127.0.0.1', { 'x-rivetos-user-token': token }))
    expect(withToken).toMatchObject({ ok: true, ctx: { userId: 'guest', isOwner: false } })
    expect(resolveRequestUser(registry, request('127.0.0.1', {}))).toMatchObject({
      ok: true,
      ctx: { userId: 'alice', isOwner: true },
    })
  })

  it('refuses an unknown, malformed or remote token, and never falls back to the owner', () => {
    clearUserTokens()
    const token = mintUserToken('guest')
    for (const req of [
      request('127.0.0.1', { 'x-rivetos-user-token': 'not-a-token-this-node-minted' }),
      request('127.0.0.1', { 'x-rivetos-user-token': '' }),
      request('127.0.0.1', { 'x-rivetos-user-token': [token, token] }),
      // From another machine, even the right token is refused.
      request('198.51.100.7', { 'x-rivetos-user-token': token }),
    ]) {
      expect(resolveRequestUser(registry, req).ok).toBe(false)
    }
    // A token outlives neither the node nor the user's place in the registry.
    clearUserTokens()
    expect(resolveRequestUser(registry, request('127.0.0.1', { 'x-rivetos-user-token': token })).ok).toBe(false)
    const stale = mintUserToken('visitor')
    expect(resolveRequestUser(registry, request('127.0.0.1', { 'x-rivetos-user-token': stale })).ok).toBe(false)
  })

  it('the token is stripped before a route sees the request', () => {
    clearUserTokens()
    const req = request('127.0.0.1', { 'x-rivetos-user-token': mintUserToken('guest'), 'x-rivetos-user': 'alice' })
    const resolved = resolveRequestUser(registry, req)
    if (!resolved.ok) throw new Error(resolved.error)
    stampUserHeader(req, resolved.ctx)
    expect(req.headers).toEqual({ 'x-rivetos-user': 'guest' })
  })
})
