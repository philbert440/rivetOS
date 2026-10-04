import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const KEYS = ['RIVETOS_USERS_FILE', 'RIVETOS_USER_STORES', 'RIVETOS_PG_URL'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const dirs: string[] = []

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.resetModules()
})

/** Load the module with a users file in place, as a node does at start. */
async function load(): Promise<typeof import('./claude-cli-model.js')> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-cli-users-'))
  dirs.push(dir)
  const file = join(dir, 'users.json')
  writeFileSync(
    file,
    JSON.stringify({
      ownerUserId: 'alice',
      unmappedIsOwner: false,
      users: {
        alice: { id: 'alice', devices: [] },
        guest: { id: 'guest', devices: ['dev1'] },
      },
    }),
  )
  process.env.RIVETOS_USERS_FILE = file
  delete process.env.RIVETOS_PG_URL
  delete process.env.RIVETOS_USER_STORES
  vi.resetModules()
  return import('./claude-cli-model.js')
}

const forUser = (userId: string) => ({ rivetos: { userId } })

describe('userRoutingEnv on a node with file stores', () => {
  it('hands a registry user a token and removes the owner\'s database variables', async () => {
    const { userRoutingEnv } = await load()
    // Boot says the stores are local once the memory plugin is registered,
    // which is after this module is loaded.
    process.env.RIVETOS_USER_STORES = 'local'
    const { userForToken } = await import('@rivetos/types')
    const env = userRoutingEnv(forUser('guest'))
    expect(env).toMatchObject({ RIVETOS_USER_ID: 'guest' })
    expect(env && 'RIVETOS_PG_URL' in env && env.RIVETOS_PG_URL).toBeUndefined()
    expect(env && 'RIVETOS_ENV_FILE' in env && env.RIVETOS_ENV_FILE).toBeUndefined()
    expect(userForToken(env?.RIVETOS_USER_TOKEN ?? '')).toBe('guest')
  })

  it('still refuses a user who is not in the registry, the owner id as a routed user, and any user when stores are not local', async () => {
    const { userRoutingEnv } = await load()
    expect(() => userRoutingEnv(forUser('guest'))).toThrow(/refusing to spawn/)
    process.env.RIVETOS_USER_STORES = 'local'
    expect(() => userRoutingEnv(forUser('nobody'))).toThrow(/refusing to spawn/)
    expect(() => userRoutingEnv(forUser('alice'))).toThrow(/refusing to spawn/)
    // An untagged turn is the owner's and gets no routing env at all.
    expect(userRoutingEnv(undefined)).toBeUndefined()
  })
})
