import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('a valid file registry is the source of truth (leftover env maps ignored)', () => {
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
      // leftover #561 env maps disagree with the file — they must be ignored
      RIVETOS_DEN_DEVICE_USERS: '{"win-coco":"mallory"}',
      RIVETOS_USER_DBS: '{"mallory":{"pgUrl":"postgres://mallory@db/mallory"}}',
      RIVETOS_PG_URL: 'postgres://phil@db/phil_memory',
    } as NodeJS.ProcessEnv)
    expect(config.usersRegistry).toBeDefined()
    expect(config.usersRegistry!.unmappedIsOwner).toBe(false)
    const r = resolveUser(config.usersRegistry!, 'win-coco')
    expect(r.ok && r.ctx.userId).toBe('coco')
    expect(config.usersRegistry!.users.mallory).toBeUndefined()
    // and an unmapped device fails closed
    expect(resolveUser(config.usersRegistry!, 'stranger').ok).toBe(false)
  })

  it('env-var-only configuration yields NO routing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-config-noroute-'))
    dirs.push(dir)
    const config = loadConfig({
      RIVETOS_SHARED_DIR: dir,
      RIVETOS_USERS_FILE: join(dir, 'missing.json'),
      RIVETOS_USER_DBS: '{"coco":{"pgUrl":"postgres://coco@db/coco_memory"}}',
      RIVETOS_DEN_DEVICE_USERS: '{"win-coco":"coco"}',
      RIVETOS_PG_URL: 'postgres://phil@db/phil_memory',
    } as NodeJS.ProcessEnv)
    expect(config.usersRegistry).toBeDefined()
    expect(config.usersRegistry!.users.coco).toBeUndefined()
    expect(resolveUser(config.usersRegistry!, 'win-coco').ok).toBe(false)
    const owner = resolveUser(config.usersRegistry!, null)
    expect(owner.ok).toBe(true)
  })
})

describe('term.mux default (fleet default = herdr when the pinned binary is present)', () => {
  const base = { RIVETOS_DEN_TERM: '1' }
  it('unset + herdr reachable → herdr', () => {
    expect(loadConfig(base, { herdr: () => true }).term.mux).toBe('herdr')
  })
  it('unset + no herdr → undefined (manager auto-detects tmux)', () => {
    expect(loadConfig(base, { herdr: () => false }).term.mux).toBeUndefined()
  })
  it('explicit tmux opts out even when herdr is reachable', () => {
    expect(loadConfig({ ...base, RIVETOS_DEN_TERM_MUX: 'tmux' }, { herdr: () => true }).term.mux).toBe('tmux')
    expect(loadConfig({ ...base, RIVETOS_DEN_TERM_MUX: 'none' }, { herdr: () => true }).term.mux).toBe('none')
  })
  it('a garbage value still fails safe to none, never to the herdr default', () => {
    expect(loadConfig({ ...base, RIVETOS_DEN_TERM_MUX: 'zellij' }, { herdr: () => true }).term.mux).toBe('none')
  })
})

describe('term.mux default — the REAL probe is wired (no injected probe)', () => {
  it('a fake pinned herdr under HOME/.local/bin flips unset → herdr; without it → undefined', () => {
    const home = mkdtempSync(join(tmpdir(), 'den-home-'))
    const env = { RIVETOS_DEN_TERM: '1', PATH: '/nonexistent-dir', HOME: home }
    expect(loadConfig(env).term.mux).toBeUndefined()
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(home, '.local', 'bin', 'herdr'), '#!/bin/sh\necho herdr 0.8.2\n', { mode: 0o755 })
    expect(loadConfig(env).term.mux).toBe('herdr')
    writeFileSync(join(home, '.local', 'bin', 'herdr'), '#!/bin/sh\necho herdr 0.9.0\n', { mode: 0o755 })
    expect(loadConfig(env).term.mux).toBeUndefined() // wrong pin never auto-selects
    rmSync(home, { recursive: true, force: true })
  })
  it('terminals disabled → no probe, mux stays unset', () => {
    let probed = false
    expect(loadConfig({ PATH: '/nonexistent-dir' }, { herdr: () => ((probed = true), true) }).term.mux).toBeUndefined()
    expect(probed).toBe(false)
  })
})
