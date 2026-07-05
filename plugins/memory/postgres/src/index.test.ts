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

function fakeCtx(pluginConfig: Record<string, unknown>) {
  return {
    pluginConfig,
    env: { RIVETOS_PG_URL: 'postgres://test' },
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
})
