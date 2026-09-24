import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentPreset } from '@rivetos/types'
import { createFallbackPresetStore } from './fallback-store.js'
import { FileAgentPresetStore } from './file-store.js'
import { importLegacyAgentsJson } from './import-legacy.js'
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

    clock += 30_000
    await store.list()
    expect(primary.checks).toBe(2)
    expect(store.backend).toBe('file')
  })

  it('logs a throwing onPrimaryReady callback and still announces the next one', async () => {
    let ready = false
    const logs: string[] = []
    const primary = fake({
      backend: 'postgres',
      marker: 'primary',
      isReady: () => ready,
    })
    const fallback = fake({
      backend: 'file',
      marker: 'fallback',
      isReady: () => true,
    })
    const store = createFallbackPresetStore({
      primary,
      fallback,
      now: () => 0,
      log: (msg) => {
        logs.push(msg)
      },
    })
    store.onPrimaryReady(() => {
      throw new Error('callback blew up')
    })
    let second = false
    store.onPrimaryReady(() => {
      second = true
    })
    ready = true
    expect((await store.list())[0]?.id).toBe('primary')
    expect(second).toBe(true)
    expect(logs.join('\n')).toMatch(/callback blew up/)
    expect(store.backend).toBe('postgres')
  })

  it('treats a timed-out primary check as not ready and probes again after recheckMs', async () => {
    let clock = 0
    const logs: string[] = []
    const primary = fake({
      backend: 'postgres',
      marker: 'primary',
      isReady: () => new Promise<boolean>(() => undefined),
    })
    const fallback = fake({
      backend: 'file',
      marker: 'fallback',
      isReady: () => true,
    })
    const store = createFallbackPresetStore({
      primary,
      fallback,
      recheckMs: 500,
      probeTimeoutMs: 30,
      now: () => clock,
      log: (msg) => {
        logs.push(msg)
      },
    })
    expect((await store.list())[0]?.id).toBe('fallback')
    expect(primary.checks).toBe(1)
    expect(logs.join('\n')).toMatch(/timed out/)
    expect(store.backend).toBe('file')

    clock += 499
    await store.get('fallback')
    expect(primary.checks).toBe(1)

    clock += 1
    expect((await store.list())[0]?.id).toBe('fallback')
    expect(primary.checks).toBe(2)
  })

  it('logs once when a fallback op is still in flight after 30s', async () => {
    vi.useFakeTimers()
    try {
      let clock = 0
      let ready = false
      const logs: string[] = []
      let releaseCreate: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let markEntered: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
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
        recheckMs: 1_000,
        now: () => clock,
        log: (msg) => {
          logs.push(msg)
        },
      })
      expect((await store.list())[0]?.id).toBe('fallback')
      const originalCreate = fallback.create.bind(fallback)
      fallback.create = (input) => {
        markEntered()
        return gate.then(() => originalCreate(input))
      }
      clock += 500
      const hung = store.create({ name: 'Late', node: 'n', directory: '/d' })
      await entered

      ready = true
      clock += 1_000
      let announced = false
      store.onPrimaryReady(() => {
        announced = true
      })
      const flipping = store.list()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logs.filter((line) => line.includes('still in flight after 30s'))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(logs.filter((line) => line.includes('still in flight after 30s'))).toHaveLength(1)
      expect(announced).toBe(false)
      releaseCreate()
      await hung
      await flipping
      expect(announced).toBe(true)
      expect(store.backend).toBe('postgres')
    } finally {
      vi.useRealTimers()
    }
  })

  it('imports a fallback create that was still in flight when the primary flipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-registry-drain-'))
    try {
      const file = join(dir, 'agents.json')
      const fileStore = new FileAgentPresetStore(file)
      let releaseCreate: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let markEntered: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
      const slowFallback: AgentPresetStore = {
        backend: 'file',
        file,
        isReady: () => fileStore.isReady(),
        list: (filter) => fileStore.list(filter),
        get: (id) => fileStore.get(id),
        findByHandle: (handle) => fileStore.findByHandle(handle),
        update: (id, patch) => fileStore.update(id, patch),
        delete: (id) => fileStore.delete(id),
        async create(input) {
          markEntered()
          await gate
          return fileStore.create(input)
        },
      }
      let ready = false
      let clock = 0
      const imported: AgentPreset[] = []
      const primary: AgentPresetStore = {
        backend: 'postgres',
        isReady: () => Promise.resolve(ready),
        list: () => Promise.resolve(imported.slice()),
        get: (id) => Promise.resolve(imported.find((row) => row.id === id)),
        findByHandle: () => Promise.resolve(undefined),
        create: (input) => {
          const preset = {
            id: input.id ?? 'generated',
            name: input.name,
            color: '',
            model: '',
            effort: 'medium',
            systemPrompt: '',
            node: input.node,
            directory: input.directory,
            sharedLink: true,
            nodeBaseUrl: '',
            createdAt: 1,
            updatedAt: 2,
          } as AgentPreset
          imported.push(preset)
          return Promise.resolve(preset)
        },
        update: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(false),
      }
      const store = createFallbackPresetStore({
        primary,
        fallback: slowFallback,
        recheckMs: 1_000,
        now: () => clock,
      })
      let announced = false
      let importDone = Promise.resolve()
      store.onPrimaryReady(() => {
        announced = true
        importDone = importLegacyAgentsJson({
          file,
          store: primary,
          node: 'ct115',
          directoryRoot: '/home/agents',
        }).then(() => undefined)
      })

      expect((await store.list())[0]).toBeUndefined()
      expect(announced).toBe(false)

      const creating = store.create({
        name: 'Late',
        node: 'ct115',
        directory: '/tmp/late-agent',
      })
      await entered
      expect(announced).toBe(false)

      ready = true
      clock = 1_000
      const flipping = store.list()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(announced).toBe(false)
      expect(imported).toEqual([])

      releaseCreate()
      await creating
      await flipping
      await importDone
      expect(announced).toBe(true)
      expect(imported.map((row) => row.name)).toEqual(['Late'])
      expect(await store.drainFallback()).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
