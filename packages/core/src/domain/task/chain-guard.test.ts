import { describe, expect, it, vi } from 'vitest'
import { guardTaskChain, readChainFields } from './chain-guard.js'

describe('guardTaskChain', () => {
  it('stamps parent depth + 1 when the parent exists', async () => {
    const result = await guardTaskChain({
      parentTaskId: 'parent-1',
      lookup: async () => ({ chainDepth: 2 }),
    })
    expect(result).toEqual({
      ok: true,
      stamp: { chainDepth: 3, parentTaskId: 'parent-1' },
    })
  })

  it('treats a missing parent as depth 0 and does not stamp the id', async () => {
    const log = vi.fn()
    const result = await guardTaskChain({
      parentTaskId: 'missing',
      lookup: async () => undefined,
      log,
    })
    expect(result).toEqual({ ok: true, stamp: { chainDepth: 1 } })
    expect(log).toHaveBeenCalledWith(
      'RIVETOS_TASK_ID missing not in ros_tasks — treating chain depth as 0',
    )
  })

  it('lets an explicit chainDepth win over the lookup', async () => {
    const result = await guardTaskChain({
      parentTaskId: 'parent-1',
      chainDepth: 2,
      lookup: async () => ({ chainDepth: 0 }),
    })
    expect(result).toEqual({
      ok: true,
      stamp: { chainDepth: 2, parentTaskId: 'parent-1' },
    })
  })

  it('refuses depth 4', async () => {
    const explicit = await guardTaskChain({
      chainDepth: 4,
      lookup: async () => undefined,
    })
    expect(explicit).toEqual({ ok: false, error: 'delegation chain too deep (4 > 3)' })

    const fromParent = await guardTaskChain({
      parentTaskId: 'parent-1',
      lookup: async () => ({ chainDepth: 3 }),
    })
    expect(fromParent).toEqual({ ok: false, error: 'delegation chain too deep (4 > 3)' })
  })

  it('rejects a negative or non-integer chainDepth', () => {
    expect(readChainFields({ chainDepth: -1 })).toBe('chainDepth must be a non-negative integer')
    expect(readChainFields({ chainDepth: 'x' })).toBe('chainDepth must be a non-negative integer')
    expect(readChainFields({ chainDepth: 1.5 })).toBe('chainDepth must be a non-negative integer')
  })

  it('leaves a create with no chain fields unstamped', async () => {
    const lookup = vi.fn(async () => ({ chainDepth: 0 }))
    const result = await guardTaskChain({ lookup })
    expect(result).toEqual({ ok: true })
    expect(lookup).not.toHaveBeenCalled()
  })
})
