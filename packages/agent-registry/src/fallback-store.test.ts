import { describe, expect, it } from 'vitest'
import type { AgentPreset } from '@rivetos/types'
import { createFallbackPresetStore } from './fallback-store.js'
import type { AgentPresetInput, AgentPresetPatch, AgentPresetStore } from './store.js'

interface Fake extends AgentPresetStore {
  checks: number
  calls: string[]
}

function fake(opts: {
  backend: 'postgres' | 'file'
  file?: string
  isReady: () => Promise<boolean> | boolean
  marker: string
}): Fake {
  const calls: string[] = []
  let checks = 0
  const store: Fake = {
    backend: opts.backend,
    ...(opts.file !== undefined ? { file: opts.file } : {}),
    calls,
    get checks() {
      return checks
    },
    isReady() {
      checks += 1
      return Promise.resolve(opts.isReady())
    },
    list() {
      calls.push(`${opts.marker}:list`)
      return Promise.resolve([{ id: opts.marker } as AgentPreset])
    },
    get(id: string) {
      calls.push(`${opts.marker}:get`)
      return Promise.resolve(id === opts.marker ? ({ id } as AgentPreset) : undefined)
    },
    findByHandle() {
      calls.push(`${opts.marker}:find`)
      return Promise.resolve(undefined)
    },
    create(input: AgentPresetInput) {
      calls.push(`${opts.marker}:create:${input.name}`)
      return Promise.resolve({ id: opts.marker, name: input.name } as AgentPreset)
    },
    update(_id: string, _patch: AgentPresetPatch) {
      calls.push(`${opts.marker}:update`)
      return Promise.resolve(undefined)
    },
    delete() {
      calls.push(`${opts.marker}:delete`)
      return Promise.resolve(true)
    },
  }
  return store
}

describe('createFallbackPresetStore', () => {
  it('serves the fallback until the primary answers true, then stays there', async () => {
    let ready = false
    let clock = 1_000
    const logs: string[] = []
    const primary = fake({
      backend: 'postgres',
      marker: 'primary',
      isReady: () => ready,
    })
    const fallback = fake({
      backend: 'file',
      file: '/var/agents.json',
      marker: 'fallback',
      isReady: () => true,
    })
    const store = createFallbackPresetStore({
      primary,
      fallback,
      recheckMs: 500,
      now: () => clock,
      log: (msg) => {
        logs.push(msg)
      },
    })
    const seen: string[] = []
    store.onPrimaryReady(() => {
      seen.push('ready')
    })

    expect(store.backend).toBe('file')
    expect(store.file).toBe('/var/agents.json')
    expect(await store.isReady()).toBe(true)
    expect((await store.list())[0]?.id).toBe('fallback')
    expect(primary.checks).toBe(1)
    expect(fallback.calls).toEqual(['fallback:list'])

    clock += 499
    expect((await store.get('fallback'))?.id).toBe('fallback')
    expect(primary.checks).toBe(1)

    ready = true
    clock += 1
    expect((await store.create({ name: 'Alpha', node: 'n', directory: '/d' })).id).toBe('primary')
    expect(store.backend).toBe('postgres')
    expect(store.file).toBeUndefined()
    expect(seen).toEqual(['ready'])
    expect(primary.checks).toBe(2)
    expect(primary.calls).toEqual(['primary:create:Alpha'])

    let late = false
    store.onPrimaryReady(() => {
      late = true
    })
    expect(late).toBe(true)

    ready = false
    clock += 10_000
    expect(await store.delete('x')).toBe(true)
    expect(primary.calls).toContain('primary:delete')
    expect(primary.checks).toBe(2)
    expect(logs).toEqual([])
  })

  it('treats a throwing primary check as not ready and does not ask again inside the window', async () => {
    let clock = 0
    const logs: string[] = []
    const primary = fake({
      backend: 'postgres',
      marker: 'primary',
      isReady: () => {
        throw new Error('relation "ros_agent_presets" does not exist')
      },
    })
    const fallback = fake({
      backend: 'file',
      file: '/var/agents.json',
      marker: 'fallback',
      isReady: () => true,
    })
    const store = createFallbackPresetStore({
      primary,
      fallback,
      recheckMs: 30_000,
      now: () => clock,
      log: (msg) => {
        logs.push(msg)
      },
    })
    expect(await store.findByHandle('x')).toBeUndefined()
    expect(fallback.calls).toEqual(['fallback:find'])
    expect(store.backend).toBe('file')
    expect(logs.join('\n')).toMatch(/ros_agent_presets/)
    expect(primary.checks).toBe(1)

    clock += 1_000
    await store.list()
    expect(primary.checks).toBe(1)
    expect(fallback.calls).toContain('fallback:list')
  })

  it('shares one in-flight primary check', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const primary = fake({
      backend: 'postgres',
      marker: 'primary',
      isReady: async () => {
        await gate
        return false
      },
    })
    const fallback = fake({
      backend: 'file',
      marker: 'fallback',
      isReady: () => true,
    })
    const store = createFallbackPresetStore({ primary, fallback, now: () => 0 })
    const both = Promise.all([store.list(), store.list()])
    release?.()
    await both
    expect(primary.checks).toBe(1)
    expect(fallback.calls).toEqual(['fallback:list', 'fallback:list'])
  })
})
