import { describe, expect, it, vi } from 'vitest'
import { createCachedPresetResolver, type CachedPresetResolver } from './cached-resolver.js'
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
    expect(await resolver.list()).toMatchObject([{ name: 'Ok' }])
    expect(calls).toBe(2)
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
    const { find } = resolver
    expect((await find('beta'))?.id).toBe('beta')
    expect((await find('Alpha'))?.id).toBe('beta')
    expect((await find('gamma'))?.id).toBe('id-c')
    expect(await find('missing')).toBeUndefined()
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

  it('does not let a refresh started before invalidate satisfy the next list', async () => {
    let now = 0
    let calls = 0
    let releaseOld: (rows: AgentPreset[]) => void = () => undefined
    const oldRefresh = new Promise<AgentPreset[]>((resolve) => {
      releaseOld = resolve
    })
    let releaseNew: (rows: AgentPreset[]) => void = () => undefined
    const newRefresh = new Promise<AgentPreset[]>((resolve) => {
      releaseNew = resolve
    })
    const store = fake(() => {
      calls += 1
      if (calls === 1) return Promise.resolve([preset({ id: 'old1', name: 'old1' })])
      if (calls === 2) return oldRefresh
      return newRefresh
    })
    const resolver = createCachedPresetResolver(store, { now: () => now, ttlMs: 1_000 })
    expect((await resolver.list())[0]?.id).toBe('old1')
    now = 1_000
    expect((await resolver.list())[0]?.id).toBe('old1')
    expect(calls).toBe(2)

    resolver.invalidate()
    const pending = resolver.list()
    await Promise.resolve()
    expect(calls).toBe(3)

    releaseOld([preset({ id: 'old2', name: 'old2' })])
    await oldRefresh
    await Promise.resolve()
    await Promise.resolve()
    expect(resolver.lastKnown()[0]?.id).toBe('old1')

    releaseNew([preset({ id: 'new', name: 'new' })])
    await expect(pending).resolves.toMatchObject([{ id: 'new' }])
    expect(calls).toBe(3)
    expect(resolver.lastKnown()).toMatchObject([{ id: 'new' }])
  })

  it('a failed cold load does not mark the cache fresh', async () => {
    let calls = 0
    const logs: string[] = []
    const store = fake(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('down'))
      return Promise.resolve([preset({ id: 'a', name: 'Later' })])
    })
    const resolver = createCachedPresetResolver(store, {
      now: () => 0,
      ttlMs: 30_000,
      log: (message) => {
        logs.push(message)
      },
    })
    expect(await resolver.list()).toEqual([])
    expect(logs.join('\n')).toMatch(/down/)
    expect(resolver.lastKnown()).toEqual([])
    expect(await resolver.list()).toMatchObject([{ id: 'a', name: 'Later' }])
    expect(calls).toBe(2)
  })

  it('a throwing logger does not reject the refresh', async () => {
    let calls = 0
    let now = 0
    const store = fake(() => {
      calls += 1
      if (calls === 1) return Promise.resolve([preset({ id: 'a', name: 'Ok' })])
      return Promise.reject(new Error('db down'))
    })
    const resolver = createCachedPresetResolver(store, {
      now: () => now,
      ttlMs: 1_000,
      log: () => {
        throw new Error('log broke')
      },
    })
    await expect(resolver.list()).resolves.toMatchObject([{ name: 'Ok' }])
    now = 1_000
    await expect(resolver.list()).resolves.toMatchObject([{ name: 'Ok' }])
    await vi.waitFor(() => {
      expect(calls).toBe(2)
    })
    expect(resolver.lastKnown()).toMatchObject([{ name: 'Ok' }])
    expect(await resolver.list()).toMatchObject([{ name: 'Ok' }])
    expect(calls).toBe(2)
  })

  it('one list returns after at most two store reads when each of 20 refreshes is invalidated', async () => {
    let calls = 0
    let invalidate = (): void => undefined
    const store = fake(() => {
      calls += 1
      if (calls > 20) return Promise.reject(new Error('refresh was not bounded'))
      invalidate()
      return Promise.resolve([preset({ id: 'a', name: `n${calls}` })])
    })
    const resolver = createCachedPresetResolver(store, { now: () => 0, ttlMs: 30_000 })
    invalidate = () => {
      resolver.invalidate()
    }
    const rows = await resolver.list()
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThanOrEqual(2)
    expect(rows).toMatchObject([{ id: 'a' }])
    expect(resolver.lastKnown()).toEqual([])
    expect(resolver.status()).toEqual({ hasValue: false, fetchedAt: 0 })
  })

  it('serves a warm cache for the TTL after a failed post-invalidation refresh', async () => {
    let now = 0
    let calls = 0
    let releaseRetry: (rows: AgentPreset[]) => void = () => undefined
    const retry = new Promise<AgentPreset[]>((resolve) => {
      releaseRetry = resolve
    })
    const store = fake(() => {
      calls += 1
      if (calls === 1) return Promise.resolve([preset({ id: 'a', name: 'Ok' })])
      if (calls === 2) return Promise.reject(new Error('db down'))
      return retry
    })
    const resolver = createCachedPresetResolver(store, { now: () => now, ttlMs: 30_000 })
    await expect(resolver.list()).resolves.toMatchObject([{ name: 'Ok' }])
    expect(resolver.status()).toEqual({ hasValue: true, fetchedAt: 0 })
    resolver.invalidate()
    await expect(resolver.list()).resolves.toMatchObject([{ name: 'Ok' }])
    await expect(resolver.list()).resolves.toMatchObject([{ name: 'Ok' }])
    await expect(resolver.list()).resolves.toMatchObject([{ name: 'Ok' }])
    expect(calls).toBe(2)
    expect(resolver.status()).toEqual({ hasValue: true, lastError: 'db down', fetchedAt: 0 })
    expect(resolver.lastKnown()).toMatchObject([{ name: 'Ok' }])
    now = 29_999
    await expect(resolver.list()).resolves.toMatchObject([{ name: 'Ok' }])
    expect(calls).toBe(2)
    now = 30_000
    let settled = false
    const pending = resolver.list().then((rows) => {
      settled = true
      return rows
    })
    await vi.waitFor(() => {
      expect(calls).toBe(3)
    })
    expect(settled).toBe(false)
    releaseRetry([preset({ id: 'a', name: 'Later' })])
    await expect(pending).resolves.toMatchObject([{ name: 'Later' }])
    expect(resolver.status()).toEqual({ hasValue: true, fetchedAt: 30_000 })
    expect(resolver.lastKnown()).toMatchObject([{ name: 'Later' }])
  })

  it('status distinguishes a down store from an empty registry', async () => {
    let calls = 0
    const store = fake(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('db down'))
      return Promise.resolve([])
    })
    const resolver: CachedPresetResolver = createCachedPresetResolver(store, {
      now: () => 50,
      ttlMs: 30_000,
    })
    expect(resolver.status()).toEqual({ hasValue: false, fetchedAt: 0 })
    await expect(resolver.list()).resolves.toEqual([])
    expect(resolver.status()).toEqual({ hasValue: false, lastError: 'db down', fetchedAt: 0 })
    await expect(resolver.list()).resolves.toEqual([])
    expect(calls).toBe(2)
    expect(resolver.status()).toEqual({ hasValue: true, fetchedAt: 50 })
  })
})
