/**
 * Plugin manifest registration — path required; registers Memory + shutdown.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Memory, PluginManifest, RegistrationContext } from '@rivetos/types'
import { manifest } from './index.ts'
import type { SqliteMemory } from './adapter.ts'

describe('memory-sqlite manifest', () => {
  const dirs: string[] = []
  const memories: SqliteMemory[] = []

  afterEach(() => {
    for (const m of memories) m.close()
    memories.length = 0
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function makeCtx(
    pluginConfig: Record<string, unknown> | undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): {
    ctx: RegistrationContext
    getRegistered: () => Memory | undefined
    getShutdowns: () => Array<() => Promise<void> | void>
  } {
    let registered: Memory | undefined
    const shutdowns: Array<() => Promise<void> | void> = []
    const ctx: RegistrationContext = {
      config: { runtime: { workspace: '/tmp' }, agents: {} },
      pluginConfig,
      env,
      workspaceDir: '/tmp',
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      registerProvider: () => undefined,
      registerChannel: () => undefined,
      registerTool: () => undefined,
      registerMemory: (m) => {
        registered = m
        memories.push(m as SqliteMemory)
      },
      registerHook: () => undefined,
      registerShutdown: (fn) => {
        shutdowns.push(fn)
      },
      lateBindTool: () => async () => '',
      onRegistrationComplete: () => undefined,
    }
    return {
      ctx,
      getRegistered: () => registered,
      getShutdowns: () => shutdowns,
    }
  }

  it('exposes type/name sqlite', () => {
    expect(manifest.type).toBe('memory')
    expect(manifest.name).toBe('sqlite')
  })

  it('skips registration when path is missing', async () => {
    const { ctx, getRegistered } = makeCtx({})
    await (manifest as PluginManifest).register(ctx)
    expect(getRegistered()).toBeUndefined()
  })

  it('registers SqliteMemory when path is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-mem-plugin-'))
    dirs.push(dir)
    const { ctx, getRegistered, getShutdowns } = makeCtx({ path: join(dir, 'm.sqlite') })
    await (manifest as PluginManifest).register(ctx)
    expect(getRegistered()).toBeDefined()
    expect(getShutdowns().length).toBe(1)
    const id = await getRegistered()!.append({
      sessionId: 'p1',
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'from plugin',
    })
    expect(id).toBeTruthy()
  })

  it('warns when a users registry defines routed users (single-user phase 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-mem-plugin-'))
    dirs.push(dir)
    const usersFile = join(dir, 'users.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      usersFile,
      JSON.stringify({
        ownerUserId: 'owner',
        unmappedIsOwner: false,
        users: {
          owner: { id: 'owner', devices: [] },
          guest: { id: 'guest', devices: ['dev1'] },
        },
      }),
    )
    const { ctx } = makeCtx(
      { path: join(dir, 'm.sqlite') },
      { ...process.env, RIVETOS_USERS_FILE: usersFile },
    )
    await (manifest as PluginManifest).register(ctx)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('single-user in phase 1'))
  })
})
