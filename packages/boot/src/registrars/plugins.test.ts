import { describe, expect, it, vi } from 'vitest'
import type { HookPipeline, PluginManifest, RegistrationContext } from '@rivetos/types'
import type { Runtime } from '@rivetos/core'
import type { PluginRegistry } from '../discovery.js'
import type { RivetConfig } from '../config.js'
import { registerPlugins } from './plugins.js'

const hooks = {
  register: () => undefined,
} as unknown as HookPipeline

const config = {
  runtime: { workspace: '/tmp', default_agent: 'test' },
  agents: { test: { provider: 'p', model: 'm' } },
} as RivetConfig

function registry(): PluginRegistry {
  return {
    plugins: [
      {
        packageName: 'test-capture-plugin',
        descriptor: { type: 'tool', name: 'capture' },
        path: '/tmp',
      },
    ],
    get: () => undefined,
    getByType: () => [],
    has: () => false,
  }
}

function stubRuntime(opts: { pool?: unknown; url?: string }): Runtime {
  return {
    getPgPool: () => opts.pool,
    getPgUrl: () => opts.url,
    registerProvider: () => undefined,
    registerChannel: () => undefined,
    registerTool: () => undefined,
    registerMemory: () => undefined,
    getTools: () => [],
    stop: async () => undefined,
  } as unknown as Runtime
}

describe('registerPlugins sharedPg wiring', () => {
  it('sets ctx.sharedPg to { connectionString, pool } when the runtime has a pool', async () => {
    const pool = { query: vi.fn() }
    const captured: RegistrationContext[] = []
    const manifest: PluginManifest = {
      type: 'tool',
      name: 'capture',
      register: (ctx) => {
        captured.push(ctx)
      },
    }
    await registerPlugins(
      stubRuntime({ pool, url: 'postgres://user:pass@localhost:5432/db' }),
      config,
      registry(),
      hooks,
      '/tmp',
      async () => ({ manifest }),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]?.sharedPg).toEqual({
      connectionString: 'postgres://user:pass@localhost:5432/db',
      pool,
    })
  })

  it('sets ctx.sharedPg to undefined when the runtime has no pool', async () => {
    const captured: RegistrationContext[] = []
    const manifest: PluginManifest = {
      type: 'tool',
      name: 'capture',
      register: (ctx) => {
        captured.push(ctx)
      },
    }
    await registerPlugins(
      stubRuntime({ url: 'postgres://user:pass@localhost:5432/db' }),
      config,
      registry(),
      hooks,
      '/tmp',
      async () => ({ manifest }),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]?.sharedPg).toBeUndefined()
  })
})
