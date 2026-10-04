/**
 * Plugin manifest registration — path required; registers Memory + shutdown.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Memory,
  PluginManifest,
  RegistrationContext,
  Tool,
  ToolContext,
} from '@rivetos/types'
import { hasMemoryBackend } from '@rivetos/types'
import type { SqliteRoutingMemory } from './routing.ts'
import {
  manifest,
  resolveCompactionSettings,
  resolveCompactorConfig,
  resolveEmbedConfig,
  resolveTaggingConfig,
  resolveWikiConfig,
} from './index.ts'
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

  it('with per-user files off, warns that other registry users get no memory', async () => {
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
      { path: join(dir, 'm.sqlite'), per_user_files: false },
      { ...process.env, RIVETOS_USERS_FILE: usersFile },
    )
    await (manifest as PluginManifest).register(ctx)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('get no memory from this store'))
  })

  it('with per-user files off, registers the read tools and refuses them to another user\'s turn', async () => {
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
    const tools: Tool[] = []
    const { ctx } = makeCtx(
      { path: join(dir, 'm.sqlite'), per_user_files: false },
      { ...process.env, RIVETOS_USERS_FILE: usersFile },
    )
    ctx.registerTool = (tool) => {
      tools.push(tool)
    }
    await (manifest as PluginManifest).register(ctx)
    expect(tools.map((t) => t.name)).toEqual([
      'memory_search',
      'memory_browse',
      'memory_stats',
      'memory_get_full',
      'memory_tags',
    ])
    const session = (userId: string | undefined): ToolContext =>
      ({ session: { userId } }) as unknown as ToolContext
    for (const tool of tools) {
      await expect(tool.execute({ query: 'x', id: 'x' }, undefined, session('guest'))).rejects.toThrow(
        /memory for user "guest" is unavailable/,
      )
    }
    // Only the registry's other users are refused. The owner's turns arrive
    // under several ids (the registry's owner id, the runtime's default
    // owner id, a platform id) and are all served.
    const stats = tools[2]
    for (const id of ['owner', 'alice', 'gateway-user', '12345', undefined]) {
      expect(String(await stats.execute({}, undefined, session(id)))).toMatch(/Backend: sqlite/)
    }
    expect(String(await stats.execute({}))).toMatch(/Backend: sqlite/)
  })

  it('with per-user files off, gives another registry user nothing and stores nothing of theirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-mem-plugin-'))
    dirs.push(dir)
    const usersFile = join(dir, 'users.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      usersFile,
      JSON.stringify({
        ownerUserId: 'alice',
        unmappedIsOwner: false,
        users: { alice: { id: 'alice', devices: [] }, guest: { id: 'guest', devices: ['dev1'] } },
      }),
    )
    const { ctx, getRegistered } = makeCtx(
      { path: join(dir, 'm.sqlite'), per_user_files: false },
      { ...process.env, RIVETOS_USERS_FILE: usersFile },
    )
    await (manifest as PluginManifest).register(ctx)
    const memory = getRegistered()
    if (!memory) throw new Error('not registered')
    await memory.append({
      sessionId: 's1',
      agent: 'rivet',
      channel: 'cli',
      role: 'user',
      content: 'the owner wrote a private note about the quarterly budget review',
    })
    // The owner, under any of the ids their turns carry, sees their memory.
    for (const userId of [undefined, 'alice', 'owner']) {
      expect(await memory.search('budget', { userId })).toHaveLength(1)
      expect(await memory.getContextForTurn('budget', 'rivet', { userId })).toMatch(/quarterly budget/)
    }
    // The other registry user sees nothing of it.
    expect(await memory.search('budget', { userId: 'guest' })).toEqual([])
    expect(await memory.getContextForTurn('budget', 'rivet', { userId: 'guest' })).toBe('')

    // A guest's own session (`<channel>:<user>`) is neither stored nor read.
    await memory.append({
      sessionId: 'gateway:guest',
      agent: 'rivet',
      channel: 'gateway',
      role: 'user',
      content: 'the guest asks about the budget review too',
    })
    expect(await memory.getSessionHistory('gateway:guest')).toEqual([])
    await memory.saveSessionSettings?.('gateway:guest', { thinking: 'high' })
    expect(await memory.loadSessionSettings?.('gateway:guest')).toBeNull()
    expect(await memory.search('guest asks')).toEqual([])
    // The owner's sessions under the same channel are unaffected, and task
    // sessions are never a user's.
    await memory.append({
      sessionId: 'gateway:alice',
      agent: 'rivet',
      channel: 'gateway',
      role: 'user',
      content: 'the owner continues the budget thread from the web hub',
    })
    expect(await memory.getSessionHistory('gateway:alice')).toHaveLength(1)
    await memory.append({ sessionId: 'task:guest', agent: 'rivet', channel: 'task', role: 'user', content: 'task work' })
    expect(await memory.getSessionHistory('task:guest')).toHaveLength(1)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('user "guest" has no memory on this node'))
  })

  it('gives every other registry user a file of their own, and keeps the stores apart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-mem-plugin-'))
    dirs.push(dir)
    const usersFile = join(dir, 'users.json')
    const { writeFileSync, existsSync } = await import('node:fs')
    writeFileSync(
      usersFile,
      JSON.stringify({
        ownerUserId: 'alice',
        unmappedIsOwner: false,
        users: {
          alice: { id: 'alice', devices: [] },
          guest: { id: 'guest', devices: ['dev1'] },
          visitor: { id: 'visitor', devices: ['dev2'] },
        },
      }),
    )
    const tools: Tool[] = []
    const { ctx, getRegistered } = makeCtx(
      { path: join(dir, 'm.sqlite') },
      { ...process.env, RIVETOS_USERS_FILE: usersFile },
    )
    ctx.registerTool = (tool) => {
      tools.push(tool)
    }
    await (manifest as PluginManifest).register(ctx)
    const memory = getRegistered()
    if (!memory) throw new Error('not registered')
    expect(existsSync(join(dir, 'users', 'guest', 'memory.sqlite'))).toBe(true)
    expect(existsSync(join(dir, 'users', 'visitor', 'memory.sqlite'))).toBe(true)
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('2 other user(s) each have their own file'))

    const note = (sessionId: string, content: string): Promise<string> =>
      memory.append({ sessionId, agent: 'rivet', channel: 'gateway', role: 'user', content })
    await note('gateway:alice', 'the owner wrote a private note about the quarterly budget review')
    await note('gateway:guest', 'the guest planned a holiday itinerary with budget hotels')
    await note('cli-session', 'an unrouted session also mentions the budget spreadsheet')

    // Each user reads their own store only.
    const texts = async (userId: string | undefined): Promise<string[]> =>
      (await memory.search('budget', { userId })).map((h) => h.content.slice(0, 9)).sort()
    expect(await texts(undefined)).toEqual(['an unrout', 'the owner'])
    expect(await texts('alice')).toEqual(['an unrout', 'the owner'])
    expect(await texts('guest')).toEqual(['the guest'])
    expect(await texts('visitor')).toEqual([])
    expect(await memory.getSessionHistory('gateway:guest')).toHaveLength(1)
    expect(await memory.getContextForTurn('budget', 'rivet', { userId: 'guest' })).toMatch(/holiday itinerary/)
    expect(await memory.getContextForTurn('budget', 'rivet', { userId: 'guest' })).not.toMatch(/quarterly/)

    // The backends follow the same split, and rows say whose they are.
    if (!hasMemoryBackend(memory)) throw new Error('no backend')
    const ownerBackend = memory.backend()
    const guestBackend = memory.backendForUser?.('guest')
    expect((await ownerBackend.stats()).messages).toBe(2)
    expect((await guestBackend?.stats())?.messages).toBe(1)
    expect(memory.backendForUser?.('nobody')).toBeNull()
    expect(memory.backendForUser?.('alice')).toBeNull()
    const routing = memory as unknown as SqliteRoutingMemory
    expect(routing.storeFor('guest').ownerUserId()).toBe('guest')
    expect(routing.storeFor(undefined).ownerUserId()).toBe('alice')
    expect(routing.storeFor('guest').ownerColumnForTest()).toEqual(['guest'])
    expect(routing.storeFor(undefined).ownerColumnForTest()).toEqual(['alice'])

    // The agent's tools go to the store of the turn's user.
    const session = (userId: string | undefined): ToolContext =>
      ({ session: { userId } }) as unknown as ToolContext
    const search = tools[0]
    expect(String(await search.execute({ query: 'budget' }, undefined, session('guest')))).toMatch(/holiday itinerary/)
    expect(String(await search.execute({ query: 'budget' }, undefined, session('guest')))).not.toMatch(/quarterly/)
    expect(String(await search.execute({ query: 'budget' }, undefined, session('owner')))).toMatch(/quarterly/)
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

  it('an empty query instruction is passed through (it disables the prefix); unset leaves the default', async () => {
    const base = { embed_endpoint: 'https://cfg.test', embed_model: 'm' }
    expect((await resolveEmbedConfig({ ...base, embed_query_instruction: '' }, {}, warn))?.queryInstruction).toBe('')
    expect((await resolveEmbedConfig(base, { RIVETOS_EMBED_QUERY_INSTRUCTION: '' }, warn))?.queryInstruction).toBe('')
    expect(await resolveEmbedConfig(base, {}, warn)).not.toHaveProperty('queryInstruction')
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

describe('resolveCompactorConfig', () => {
  const warn = (): void => {}

  it('is undefined without an endpoint; config wins over the environment', async () => {
    expect(await resolveCompactorConfig({}, {}, warn)).toBeUndefined()
    const env = {
      RIVETOS_COMPACTOR_URL: 'https://env.test/v1',
      RIVETOS_COMPACTOR_MODEL: 'env-model',
      RIVETOS_COMPACTOR_API_KEY: 'env-key',
    }
    expect(await resolveCompactorConfig({}, env, warn)).toEqual({
      endpoint: 'https://env.test/v1',
      model: 'env-model',
      apiKey: 'env-key',
    })
    expect(
      await resolveCompactorConfig(
        { compactor_endpoint: 'https://cfg.test/v1', compactor_model: 'cfg-model', compactor_timeout_ms: 1 },
        env,
        warn,
      ),
    ).toEqual({ endpoint: 'https://cfg.test/v1', model: 'cfg-model', apiKey: 'env-key', timeoutMs: 5000 })
  })

  it('requires a model with an endpoint', async () => {
    await expect(resolveCompactorConfig({ compactor_endpoint: 'https://cfg.test/v1' }, {}, warn)).rejects.toThrow(
      /RIVETOS_COMPACTOR_MODEL/,
    )
  })

  it('reads the batch thresholds from the worker variables, ignoring junk', () => {
    expect(
      resolveCompactionSettings({ COMPACT_LEAF_BATCH: '20', COMPACT_IDLE_MINUTES: 'soon', COMPACT_MIN_LEAFS: '0' }),
    ).toEqual({ leafBatch: 20 })
    // A leaf window below the floor of 5 could never be written.
    expect(resolveCompactionSettings({ COMPACT_LEAF_BATCH: '3' })).toEqual({})
    // A parent batch smaller than the children it needs could never be written either.
    expect(resolveCompactionSettings({ COMPACT_BRANCH_BATCH: '2', COMPACT_ROOT_BATCH: '1' })).toEqual({})
    expect(resolveCompactionSettings({ COMPACT_BRANCH_BATCH: '2', COMPACT_MIN_LEAFS: '2' })).toEqual({
      branchBatch: 2,
      minLeavesForBranch: 2,
    })
  })
})

describe('resolveWikiConfig', () => {
  it('reads the directory and the switch from config, then the environment; extraction is off by default', () => {
    expect(resolveWikiConfig({}, {}).extraction).toBe(false)
    expect(resolveWikiConfig({}, {}).dir).toMatch(/wiki$/)
    expect(resolveWikiConfig({}, { WIKI_DIR: '/data/wiki', WIKI_EXTRACTION: '1' })).toEqual({
      dir: '/data/wiki',
      extraction: true,
    })
    expect(
      resolveWikiConfig({ wiki_dir: '/cfg/wiki', wiki_extraction: false }, { WIKI_DIR: '/data/wiki', WIKI_EXTRACTION: '1' }),
    ).toEqual({ dir: '/cfg/wiki', extraction: false })
    expect(resolveWikiConfig({}, { WIKI_EXTRACTION: 'true' }).extraction).toBe(false)
  })
})

describe('resolveTaggingConfig', () => {
  it('is on by default, off by config or SESSION_TAGGING=0, and takes its own endpoint when given one', () => {
    expect(resolveTaggingConfig({}, {})).toEqual({ enabled: true })
    expect(resolveTaggingConfig({}, { SESSION_TAGGING: '0' })).toEqual({ enabled: false })
    expect(resolveTaggingConfig({ tagging: false }, {})).toEqual({ enabled: false })
    expect(resolveTaggingConfig({ tagging: true }, { SESSION_TAGGING: 'off' })).toEqual({ enabled: true })
    expect(
      resolveTaggingConfig({}, { RIVETOS_TAGGER_URL: 'https://tagger.test/v1', RIVETOS_TAGGER_MODEL: 'tagger-v1' }),
    ).toEqual({ enabled: true, llm: { endpoint: 'https://tagger.test/v1', model: 'tagger-v1' } })
    expect(
      resolveTaggingConfig(
        { tagger_endpoint: 'https://cfg.test/v1', tagger_model: 'cfg', tagger_api_key: 'k' },
        { RIVETOS_TAGGER_URL: 'https://tagger.test/v1', RIVETOS_TAGGER_MODEL: 'tagger-v1' },
      ),
    ).toEqual({ enabled: true, llm: { endpoint: 'https://cfg.test/v1', model: 'cfg', apiKey: 'k' } })
    // An endpoint without a model falls back to the compactor's.
    expect(resolveTaggingConfig({}, { RIVETOS_TAGGER_URL: 'https://tagger.test/v1' })).toEqual({ enabled: true })
  })
})
