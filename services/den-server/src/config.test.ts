import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveUser } from '@rivetos/types'
import { loadConfig } from './config.js'

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

describe('loadUsersRegistry — explicit RIVETOS_USERS_FILE', () => {
  it('fails CLOSED when the configured file is missing: every device 403s, owner survives', () => {
    const config = loadConfig({
      RIVETOS_USERS_FILE: '/nonexistent/definitely-not-here/users.json',
      RIVETOS_PG_URL: 'postgres://phil@db/phil_memory',
    } as NodeJS.ProcessEnv)
    // a registry exists (tenancy ON) — but one that refuses all devices
    expect(config.usersRegistry).toBeDefined()
    expect(config.usersRegistry!.unmappedIsOwner).toBe(false)
    const device = resolveUser(config.usersRegistry!, 'win-coco')
    expect(device.ok).toBe(false)
    // the owner keeps working via loopback + the env PG URL
    const owner = resolveUser(config.usersRegistry!, null)
    expect(owner.ok).toBe(true)
  })

  it('an invalid JSON file fails closed the same way', () => {
    const config = loadConfig({
      RIVETOS_USERS_FILE: '/dev/null',
      RIVETOS_PG_URL: 'postgres://phil@db/phil_memory',
    } as NodeJS.ProcessEnv)
    expect(config.usersRegistry).toBeDefined()
    expect(config.usersRegistry!.unmappedIsOwner).toBe(false)
  })

  it('a valid file registry wins over the env maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-config-'))
    dirs.push(dir)
    const file = join(dir, 'users.json')
    writeFileSync(
      file,
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [], pgUrl: 'postgres://phil@db/phil_memory' },
          coco: { devices: ['win-coco'], pgUrl: 'postgres://coco@db/coco_memory' },
        },
      }),
    )
    const config = loadConfig({
      RIVETOS_USERS_FILE: file,
      // env maps disagree with the file — the file must win
      RIVETOS_DEN_DEVICE_USERS: '{"win-coco":"mallory"}',
      RIVETOS_PG_URL: 'postgres://phil@db/phil_memory',
    } as NodeJS.ProcessEnv)
    expect(config.usersRegistry).toBeDefined()
    expect(config.usersRegistry!.unmappedIsOwner).toBe(false)
    const r = resolveUser(config.usersRegistry!, 'win-coco')
    expect(r.ok && r.ctx.userId).toBe('coco')
    // and an unmapped device fails closed
    expect(resolveUser(config.usersRegistry!, 'stranger').ok).toBe(false)
  })
})
