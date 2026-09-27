import { describe, expect, it, vi } from 'vitest'
import { guardTaskChain, readChainFields } from './chain-guard.js'

describe('guardTaskChain', () => {
  it('stamps parent depth + 1 when the parent exists', async () => {
    const result = await guardTaskChain({
      parentTaskId: '00000000-0000-4000-8000-000000000001',
      lookup: async () => ({ chainDepth: 2 }),
    })
    expect(result).toEqual({
      ok: true,
      stamp: { chainDepth: 3, parentTaskId: '00000000-0000-4000-8000-000000000001' },
    })
  })

  it('treats a missing parent as depth 0 and does not stamp the id', async () => {
    const log = vi.fn()
    const result = await guardTaskChain({
      parentTaskId: '00000000-0000-4000-8000-000000000099',
      lookup: async () => undefined,
      log,
    })
    expect(result).toEqual({ ok: true, stamp: { chainDepth: 1 } })
    expect(log).toHaveBeenCalledWith(
      'RIVETOS_TASK_ID 00000000-0000-4000-8000-000000000099 not in ros_tasks — treating chain depth as 0',
    )
  })

  it('lets an explicit chainDepth win over the lookup', async () => {
    const result = await guardTaskChain({
      parentTaskId: '00000000-0000-4000-8000-000000000001',
      chainDepth: 2,
      lookup: async () => ({ chainDepth: 0 }),
    })
    expect(result).toEqual({
      ok: true,
      stamp: { chainDepth: 2, parentTaskId: '00000000-0000-4000-8000-000000000001' },
    })
  })

  it.each([
    [undefined, { ok: true, stamp: { chainDepth: 3 } }],
    [1, { ok: true, stamp: { chainDepth: 1 } }],
    [4, { ok: false, error: 'delegation chain too deep (4 > 3)' }],
  ])('fails closed for a malformed parent with explicit depth %s', async (chainDepth, expected) => {
    const lookup = vi.fn(async () => ({ chainDepth: 0 }))
    const log = vi.fn()
    expect(await guardTaskChain({ parentTaskId: 'not-a-uuid', chainDepth, lookup, log })).toEqual(
      expected,
    )
    expect(lookup).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      'parentTaskId "not-a-uuid" is not a UUID — delegate tools registered at chain depth 2 (fail closed)',
    )
  })

  it('refuses depth 4', async () => {
    const explicit = await guardTaskChain({
      chainDepth: 4,
      lookup: async () => undefined,
    })
    expect(explicit).toEqual({ ok: false, error: 'delegation chain too deep (4 > 3)' })

    const fromParent = await guardTaskChain({
      parentTaskId: '00000000-0000-4000-8000-000000000001',
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
