import { afterEach, describe, expect, it } from 'vitest'
import { clearUserTokens, mintUserToken, userForToken } from './user-tokens.js'
import { ownerUserIdFromEnv, resolveUserById, type UsersRegistry } from './users-registry.js'

afterEach(() => {
  clearUserTokens()
})

describe('user tokens', () => {
  it('mints one token per user and maps it back to that user only', () => {
    const guest = mintUserToken('guest')
    // The user's id in front, then 32 random bytes.
    expect(guest).toMatch(/^Z3Vlc3Q\.[A-Za-z0-9_-]{43}$/)
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

  it('honours the longest id it mints for, and refuses to mint for a longer one', () => {
    const long = 'u'.repeat(256)
    expect(userForToken(mintUserToken(long))).toBe(long)
    expect(() => mintUserToken('u'.repeat(257))).toThrow(/too long/)
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

describe('ownerUserIdFromEnv', () => {
  it('is the registry owner, or the default owner id without a registry', () => {
    const none = { RIVETOS_USERS_FILE: '/nonexistent/users.json', HOME: '/nonexistent' }
    expect(ownerUserIdFromEnv(none)).toBe('owner')
    expect(ownerUserIdFromEnv({ ...none, RIVETOS_OWNER_USER_ID: 'alice' })).toBe('alice')
    // A session's own user id is not the node owner's.
    expect(ownerUserIdFromEnv({ ...none, RIVETOS_USER_ID: 'guest' })).toBe('owner')
  })
})
