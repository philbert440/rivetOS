import { describe, expect, it, vi } from 'vitest'
import { createCachedPresetResolver } from './cached-resolver.js'
import type { AgentPresetStore } from './store.js'
import type { AgentPreset } from '@rivetos/types'

function preset(partial: Pick<AgentPreset, 'id' | 'name'> & Partial<AgentPreset>): AgentPreset {
  return {
    color: '',
    model: '',
    effort: 'medium',
    systemPrompt: '',
    nodeBaseUrl: '',
    createdAt: 1,
    updatedAt: 1,
    sharedLink: true,
    node: 'n',
    directory: '/d',
    ...partial,
  }
}

function fake(list: () => Promise<AgentPreset[]>): AgentPresetStore & { findCalls: number } {
  return {
    backend: 'file',
    findCalls: 0,
    isReady: () => Promise.resolve(true),
    list,
    get: () => Promise.resolve(undefined),
    findByHandle: () => {
      throw new Error('findByHandle must not be called')
    },
    create: () => Promise.reject(new Error('no create')),
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(false),
  }
}

describe('createCachedPresetResolver', () => {
  it('awaits the store on the first call', async () => {
    let release: (rows: AgentPreset[]) => void = () => undefined
    const gate = new Promise<AgentPreset[]>((resolve) => {
      release = resolve
    })
    let listed = false
    const store = fake(() => {
      listed = true
      return gate
    })
    const resolver = createCachedPresetResolver(store, { now: () => 0 })
    let settled = false
    const pending = resolver.list().then((rows) => {
      settled = true
      return rows
    })
    await Promise.resolve()
    expect(listed).toBe(true)
    expect(settled).toBe(false)
    release([preset({ id: 'a', name: 'A' })])
    await expect(pending).resolves.toMatchObject([{ id: 'a' }])
  })

  it('returns the last-known list when stale and refreshes once', async () => {
    let now = 0
    let calls = 0
    let releaseSecond: (rows: AgentPreset[]) => void = () => undefined
    const second = new Promise<AgentPreset[]>((resolve) => {
      releaseSecond = resolve
    })
    const store = fake(() => {
      calls += 1
      if (calls === 1) return Promise.resolve([preset({ id: 'a', name: 'first' })])
      return second
    })
    const resolver = createCachedPresetResolver(store, { now: () => now, ttlMs: 1_000 })
    expect((await resolver.list())[0]?.name).toBe('first')
    now = 1_000
    expect((await resolver.list())[0]?.name).toBe('first')
    expect(calls).toBe(2)
    expect((await resolver.list())[0]?.name).toBe('first')
    expect(calls).toBe(2)
    releaseSecond([preset({ id: 'a', name: 'second' })])
    await vi.waitFor(() => {
      expect(resolver.lastKnown()[0]?.name).toBe('second')
    })
  })

  it('keeps the last-known list when a refresh throws', async () => {
    let now = 0
    let calls = 0
    const logs: string[] = []
    const store = fake(() => {
      calls += 1
      if (calls === 1) return Promise.resolve([preset({ id: 'a', name: 'Ok' })])
      return Promise.reject(new Error('db down'))
    })
    const resolver = createCachedPresetResolver(store, {
      now: () => now,
      ttlMs: 1_000,
      log: (message) => {
        logs.push(message)
      },
    })
    expect(await resolver.list()).toMatchObject([{ name: 'Ok' }])
    now = 1_000
    expect(await resolver.list()).toMatchObject([{ name: 'Ok' }])
    await vi.waitFor(() => {
      expect(logs.join('\n')).toMatch(/db down/)
    })
    expect(resolver.lastKnown()).toMatchObject([{ name: 'Ok' }])
  })

  it('finds by handle priority on the cached list without a store round-trip', async () => {
    let calls = 0
    const store = fake(() => {
      calls += 1
      return Promise.resolve([
        preset({ id: 'beta', name: 'Alpha' }),
        preset({ id: 'id-b', name: 'beta' }),
        preset({ id: 'id-c', name: 'Gamma' }),
      ])
    })
    const resolver = createCachedPresetResolver(store, { now: () => 0, ttlMs: 30_000 })
    expect((await resolver.find('beta'))?.id).toBe('beta')
    expect((await resolver.find('Alpha'))?.id).toBe('beta')
    expect((await resolver.find('gamma'))?.id).toBe('id-c')
    expect(await resolver.find('missing')).toBeUndefined()
    expect(calls).toBe(1)
    expect(store.findCalls).toBe(0)
  })

  it('invalidate makes the next list await a fresh read', async () => {
    let calls = 0
    const store = fake(() => {
      calls += 1
      return Promise.resolve([preset({ id: 'a', name: `n${calls}` })])
    })
    const resolver = createCachedPresetResolver(store, { now: () => 0, ttlMs: 30_000 })
    expect((await resolver.list())[0]?.name).toBe('n1')
    expect((await resolver.list())[0]?.name).toBe('n1')
    expect(calls).toBe(1)
    resolver.invalidate()
    expect((await resolver.list())[0]?.name).toBe('n2')
    expect(calls).toBe(2)
    expect(resolver.lastKnown()).toMatchObject([{ name: 'n2' }])
  })
})
