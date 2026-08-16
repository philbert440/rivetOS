import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalUser, listLocalUsers, resetLocalUsers, tryCreateLiveUser } from './users.js'

describe('local team users', () => {
  afterEach(() => {
    resetLocalUsers()
  })

  it('isolates two handles', () => {
    const a = createLocalUser('phil', 'Phil')
    const b = createLocalUser('alex', 'Alex')
    expect(a.schemaName).toBe('team_u_phil')
    expect(b.schemaName).toBe('team_u_alex')
    expect(a.roleName).not.toBe(b.roleName)
    expect(listLocalUsers().map((u) => u.handle)).toEqual(['phil', 'alex'])
  })

  it('rejects a colliding handle and reserved names', () => {
    createLocalUser('phil', 'Phil')
    expect(() => createLocalUser('PHIL', 'Other')).toThrow(/taken|invalid/)
    expect(() => createLocalUser('ros_messages', 'Nope')).toThrow(/invalid/)
  })

  it('does not fall back to local when the live API returns 409', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'handle taken' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(tryCreateLiveUser('phil', 'Phil')).rejects.toThrow(/handle taken/)
    expect(listLocalUsers()).toEqual([])
    vi.unstubAllGlobals()
  })
})
