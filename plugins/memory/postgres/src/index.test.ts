import { describe, expect, it, vi } from 'vitest'

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
    env: { RIVETOS_PG_URL: 'postgres://test', ...env },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    registerMemory: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
  }
}

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
})

describe('SearchEngine embed config', () => {
  const pool = {} as never

  it('throws when embedEndpoint is set without embedModel', () => {
    expect(() => new SearchEngine(pool, { embedEndpoint: 'http://127.0.0.1:9401' })).toThrow(
      /RIVETOS_EMBED_MODEL/,
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

