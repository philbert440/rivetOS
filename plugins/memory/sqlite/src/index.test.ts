/**
 * Plugin manifest registration — path required; registers Memory + shutdown.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Memory, PluginManifest, RegistrationContext } from '@rivetos/types'
import { manifest, resolveEmbedConfig } from './index.ts'
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

describe('resolveEmbedConfig', () => {
  const warn = vi.fn()

  it('is off without an endpoint, and reads config before environment', async () => {
    expect(await resolveEmbedConfig({}, {}, warn)).toBeUndefined()
    const fromEnv = await resolveEmbedConfig(
      {},
      { RIVETOS_EMBED_URL: 'https://env.test', RIVETOS_EMBED_MODEL: 'env-model' },
      warn,
    )
    expect(fromEnv).toMatchObject({ endpoint: 'https://env.test', model: 'env-model', wireShape: 'openai' })
    const fromConfig = await resolveEmbedConfig(
      {
        embed_endpoint: 'https://cfg.test',
        embed_model: 'cfg-model',
        embed_wire_shape: 'native',
        embed_expected_dims: 768,
        embed_timeout_ms: '2500',
        embed_query_instruction: 'query: ',
        embed_api_key: 'k',
      },
      { RIVETOS_EMBED_URL: 'https://env.test', RIVETOS_EMBED_MODEL: 'env-model' },
      warn,
    )
    expect(fromConfig).toEqual({
      endpoint: 'https://cfg.test',
      model: 'cfg-model',
      wireShape: 'native',
      apiKey: 'k',
      expectedDims: 768,
      timeoutMs: 2500,
      queryInstruction: 'query: ',
    })
  })

  it('requires a model with an endpoint, never borrows another provider key, and warns on a bad wire shape', async () => {
    await expect(resolveEmbedConfig({ embed_endpoint: 'https://cfg.test' }, {}, warn)).rejects.toThrow(
      /RIVETOS_EMBED_MODEL .* is required/,
    )
    const out = await resolveEmbedConfig(
      { embed_endpoint: 'https://cfg.test', embed_model: 'm', embed_wire_shape: 'soap' },
      { OPENAI_API_KEY: 'do-not-use' },
      warn,
    )
    expect(out?.apiKey).toBeUndefined()
    expect(out?.wireShape).toBe('openai')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('embed_wire_shape'))
  })
})
