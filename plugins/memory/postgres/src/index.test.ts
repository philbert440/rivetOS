import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./adapter.js', () => ({
  PostgresMemory: class {
    getSearchEngine() {
      return {}
    }
    getExpander() {
      return {}
    }
    getPool() {
      return {}
    }
  },
}))
vi.mock('./embedder.js', () => ({ ensureEmbedderSchema: vi.fn(async () => undefined) }))
vi.mock('./tools/index.js', () => ({ createMemoryTools: () => [] }))

import { manifest } from './index.js'
import { SearchEngine } from './search.js'

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
})

