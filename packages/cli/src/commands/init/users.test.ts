import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOwnerRegistry, seedUsersJson, usersJsonPath } from './users.js'

const ORIGINAL = process.env.RIVETOS_SHARED_DIR
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'init-users-'))
  process.env.RIVETOS_SHARED_DIR = tmp
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL
  rmSync(tmp, { recursive: true, force: true })
})

describe('buildOwnerRegistry', () => {
  it('emits a fail-closed single-owner file-registry shape', () => {
    expect(buildOwnerRegistry('owner')).toEqual({
      ownerUserId: 'owner',
      unmappedIsOwner: false,
      users: { owner: { devices: [] } },
    })
  })
})

describe('seedUsersJson', () => {
  it('writes users.json under the resolved shared dir', async () => {
    const result = await seedUsersJson('alice')
    expect(result.written).toBe(true)
    expect(result.path).toBe(join(tmp, 'rivetos', 'users.json'))
    expect(result.path).toBe(usersJsonPath())
    const parsed = JSON.parse(readFileSync(result.path, 'utf-8')) as {
      ownerUserId: string
      unmappedIsOwner: boolean
    }
    expect(parsed.ownerUserId).toBe('alice')
    expect(parsed.unmappedIsOwner).toBe(false)
  })

  it('is idempotent — does not overwrite an existing file', async () => {
    const first = await seedUsersJson('alice')
    expect(first.written).toBe(true)
    mkdirSync(join(tmp, 'rivetos'), { recursive: true })
    writeFileSync(first.path, '{"ownerUserId":"kept","unmappedIsOwner":false,"users":{}}\n')
    const second = await seedUsersJson('bob')
    expect(second.written).toBe(false)
    expect(second.path).toBe(first.path)
    const raw = readFileSync(first.path, 'utf-8')
    expect(raw).toContain('"ownerUserId":"kept"')
    expect(raw).not.toContain('bob')
  })
})
