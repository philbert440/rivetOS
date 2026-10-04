import { afterEach, describe, expect, it } from 'vitest'
import { clearUserTokens, mintUserToken, userForToken } from './user-tokens.js'
import { resolveUserById, type UsersRegistry } from './users-registry.js'

afterEach(() => {
  clearUserTokens()
})

describe('user tokens', () => {
  it('mints one token per user and maps it back to that user only', () => {
    const guest = mintUserToken('guest')
    expect(guest).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mintUserToken('guest')).toBe(guest)
    const visitor = mintUserToken('visitor')
    expect(visitor).not.toBe(guest)
    expect(userForToken(guest)).toBe('guest')
    expect(userForToken(visitor)).toBe('visitor')
  })

  it('knows no token it did not mint, and none after a restart', () => {
    const guest = mintUserToken('guest')
    expect(userForToken('')).toBeUndefined()
    expect(userForToken('guest')).toBeUndefined()
    expect(userForToken(`${guest}x`)).toBeUndefined()
    expect(userForToken('x'.repeat(10_000))).toBeUndefined()
    clearUserTokens()
    expect(userForToken(guest)).toBeUndefined()
  })
})

describe('resolveUserById', () => {
  const registry = (localStores: boolean): UsersRegistry => ({
    ownerUserId: 'alice',
    unmappedIsOwner: false,
    users: {
      alice: { id: 'alice', devices: [] },
      guest: { id: 'guest', devices: ['dev1'] },
    },
    ...(localStores ? { localStores: true } : {}),
  })

  it('resolves a registry user on a node with file stores, never as the owner', () => {
    const resolved = resolveUserById(registry(true), 'guest')
    expect(resolved).toMatchObject({ ok: true, ctx: { userId: 'guest', isOwner: false, deviceId: null } })
  })

  it('fails closed for an unknown user and for a user with nothing to route to', () => {
    expect(resolveUserById(registry(true), 'nobody')).toMatchObject({ ok: false })
    expect(resolveUserById(registry(false), 'guest')).toMatchObject({ ok: false })
  })
})
