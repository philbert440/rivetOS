import { describe, it, expect, vi } from 'vitest'
import { createModelCatalog } from './model-catalog.js'

describe('createModelCatalog', () => {
  it('always serves the static floor', () => {
    const cat = createModelCatalog({
      floor: ['floor-a', 'floor-b'],
      fetchIds: async () => [],
      now: () => 0,
    })
    expect(cat.list()).toEqual(['floor-a', 'floor-b'])
  })

  it('merges discovered ids after the floor and dedupes', async () => {
    let now = 0
    const cat = createModelCatalog({
      floor: ['floor-a'],
      fetchIds: async () => ['floor-a', 'disc-1'],
      ttlMs: 10,
      now: () => now,
    })
    cat.refresh()
    await vi.waitFor(() => {
      expect(cat.list()).toEqual(['floor-a', 'disc-1'])
    })
    now = 20
    cat.refresh()
    expect(cat.list()).toEqual(['floor-a', 'disc-1'])
  })

  it('keeps last-known on failure and logs once per outage', async () => {
    let now = 0
    let fail = false
    const logs: string[] = []
    const cat = createModelCatalog({
      floor: ['floor'],
      fetchIds: async () => {
        if (fail) throw new Error('down')
        return ['disc']
      },
      ttlMs: 10,
      now: () => now,
      log: (m) => logs.push(m),
      label: 'vllm',
    })
    cat.refresh()
    await vi.waitFor(() => expect(cat.list()).toContain('disc'))

    fail = true
    now = 20
    cat.refresh()
    await vi.waitFor(() => expect(cat.lastError()).toMatch(/down/))
    expect(cat.list()).toEqual(['floor', 'disc'])
    expect(logs.length).toBe(1)

    now = 40
    cat.refresh()
    await vi.waitFor(() => expect(logs.length).toBe(1))
  })
})
