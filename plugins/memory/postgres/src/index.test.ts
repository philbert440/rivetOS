import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./adapter.js', () => {
  class PostgresMemory {
    static configs: unknown[] = []
    constructor(config: unknown) {
      PostgresMemory.configs.push(config)
    }
    getSearchEngine() {
      return {}
    }
    getExpander() {
      return {}
    }
    getPool() {
      return {}
    }
  }
  return { PostgresMemory }
})
vi.mock('./embedder.js', () => ({ ensureEmbedderSchema: vi.fn(async () => undefined) }))
vi.mock('./tools/index.js', () => ({ createMemoryTools: () => [] }))

import { PostgresMemory } from './adapter.js'
import { manifest } from './index.js'
import { SearchEngine } from './search.js'

type CtorMemory = typeof PostgresMemory & { configs: unknown[] }

function fakeCtx(pluginConfig: Record<string, unknown>, env: Record<string, string> = {}) {
  return {
    pluginConfig,
    // Isolate from a live fleet users.json: explicit missing file fail-closes
    // (owner only) unless the test supplies its own RIVETOS_USERS_FILE.
    env: {
      RIVETOS_PG_URL: 'postgres://test',
      RIVETOS_USERS_FILE: '/nonexistent/rivetos-test-no-users.json',
      ...env,
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    registerMemory: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
  }
}

const tmpDirs: string[] = []
afterEach(() => {
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  ;(PostgresMemory as CtorMemory).configs.length = 0
})

describe('memory-postgres manifest', () => {
  it('does NOT register the delegation tracker by default', async () => {
    const ctx = fakeCtx({})
    await manifest.register(ctx as never)
    expect(ctx.registerHook).not.toHaveBeenCalled()
  })

  it('registers the delegation tracker when delegation_tracking: true', async () => {
    const ctx = fakeCtx({ delegation_tracking: true })
    await manifest.register(ctx as never)
    expect(ctx.registerHook).toHaveBeenCalledTimes(1)
    expect(ctx.registerHook.mock.calls[0][0]).toMatchObject({
      id: 'memory:delegation-tracker',
      event: 'delegation:after',
    })
  })

  it('throws when an embed URL is set without a model', async () => {
    const ctx = fakeCtx({ embed_endpoint: 'http://127.0.0.1:9401' })
    await expect(manifest.register(ctx as never)).rejects.toThrow(/RIVETOS_EMBED_MODEL/)
  })

  it('registers when embed URL and model are both set', async () => {
    const ctx = fakeCtx({
      embed_endpoint: 'http://127.0.0.1:9401',
      embed_model: 'text-embedding-3-small',
    })
    await expect(manifest.register(ctx as never)).resolves.toBeUndefined()
    expect(ctx.registerMemory).toHaveBeenCalled()
  })

  it('accepts RIVETOS_EMBED_MODEL when embed URL comes from env', async () => {
    const ctx = fakeCtx(
      {},
      { RIVETOS_EMBED_URL: 'http://127.0.0.1:9401', RIVETOS_EMBED_MODEL: 'text-embedding-3-small' },
    )
    await expect(manifest.register(ctx as never)).resolves.toBeUndefined()
    expect(ctx.registerMemory).toHaveBeenCalled()
  })

  it('env-var-only configuration does not enable per-user routing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-noroute-'))
    tmpDirs.push(dir)
    const ctx = fakeCtx(
      {},
      {
        RIVETOS_USER_DBS: '{"coco":{"pgUrl":"postgres://coco@db/coco_memory"}}',
        RIVETOS_USERS_FILE: join(dir, 'missing.json'),
        RIVETOS_SHARED_DIR: dir,
      },
    )
    await manifest.register(ctx as never)
    expect(ctx.registerMemory).toHaveBeenCalledTimes(1)
    expect(ctx.registerMemory.mock.calls[0][0].constructor.name).not.toBe('RoutingMemory')
  })

  it('users.json registry enables per-user routing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-route-'))
    tmpDirs.push(dir)
    const file = join(dir, 'users.json')
    writeFileSync(
      file,
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [], pgUrl: 'postgres://phil@db/phil' },
          coco: { devices: ['win-coco'], pgUrl: 'postgres://coco@db/coco_memory' },
        },
      }),
    )
    const ctx = fakeCtx({}, { RIVETOS_USERS_FILE: file, RIVETOS_SHARED_DIR: dir })
    await manifest.register(ctx as never)
    expect(ctx.registerMemory.mock.calls[0][0].constructor.name).toBe('RoutingMemory')
  })
})

describe('M1 env / config plumbing', () => {
  it('passes plugin config first, then env, matching embed_endpoint', async () => {
    const ctx = fakeCtx(
      {
        embed_endpoint: 'http://127.0.0.1:9401',
        embed_model: 'Qwen3-Embedding-0.6B',
        embed_query_instruction: 'Instruct: from-config\nQuery: ',
        embed_timeout_ms: '900',
        hnsw_ef_search: '40.7',
      },
      {
        RIVETOS_EMBED_QUERY_INSTRUCTION: 'Instruct: from-env\nQuery: ',
        RIVETOS_EMBED_TIMEOUT_MS: '800000',
        RIVETOS_HNSW_EF_SEARCH: '9999',
      },
    )
    await manifest.register(ctx as never)
    const cfg = (PostgresMemory as CtorMemory).configs[0] as {
      embedQueryInstruction: string
      embedTimeoutMs: string
      hnswEfSearch: string
    }
    expect(cfg.embedQueryInstruction).toBe('Instruct: from-config\nQuery: ')
    expect(cfg.embedTimeoutMs).toBe('900')
    expect(cfg.hnswEfSearch).toBe('40.7')
  })

  it('falls back to env when plugin config omits the new keys', async () => {
    const ctx = fakeCtx(
      {
        embed_endpoint: 'http://127.0.0.1:9401',
        embed_model: 'Qwen3-Embedding-0.6B',
      },
      {
        RIVETOS_EMBED_QUERY_INSTRUCTION: '',
        RIVETOS_EMBED_TIMEOUT_MS: '100',
        RIVETOS_HNSW_EF_SEARCH: '40.7',
      },
    )
    await manifest.register(ctx as never)
    const cfg = (PostgresMemory as CtorMemory).configs[0] as {
      embedQueryInstruction: string
      embedTimeoutMs: string
      hnswEfSearch: string
    }
    expect(cfg.embedQueryInstruction).toBe('')
    expect(cfg.embedTimeoutMs).toBe('100')
    expect(cfg.hnswEfSearch).toBe('40.7')
  })
})

describe('SearchEngine embed config', () => {
  const pool = {} as never

  it('throws when embedEndpoint is set without embedModel', () => {
    expect(() => new SearchEngine(pool, { embedEndpoint: 'http://127.0.0.1:9401' })).toThrow(
      /embedModel is required when embedEndpoint is set \(env: RIVETOS_EMBED_MODEL\)/,
    )
  })

  it('constructs when both endpoint and model are set', () => {
    expect(
      () =>
        new SearchEngine(pool, {
          embedEndpoint: 'http://127.0.0.1:9401',
          embedModel: 'text-embedding-3-small',
        }),
    ).not.toThrow()
  })

  it('constructs with neither endpoint nor model (FTS-only)', () => {
    expect(() => new SearchEngine(pool)).not.toThrow()
  })

  it('clamps string env-like values on the engine', () => {
    const eng = new SearchEngine(pool, {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
      embedQueryInstruction: '',
      embedTimeoutMs: '100',
      hnswEfSearch: '40.7',
    })
    // Public surface: runtime stats exist; clamps are covered in search.test.ts.
    // Instruction '' disables prefix (engine constructs).
    expect(eng.getRuntimeStats().queryEmbedCacheHits).toBe(0)
    expect(eng.getRuntimeStats().queryEmbedCacheMisses).toBe(0)
  })
})

