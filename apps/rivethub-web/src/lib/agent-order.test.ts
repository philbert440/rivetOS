import { describe, expect, it } from 'vitest'
import { applyPendingOrder, moveAgentId, sortOrderWrites, sortRosterAgents } from './agent-order.js'

const a = (id: string, sortOrder?: number) => (sortOrder === undefined ? { id } : { id, sortOrder })

describe('sortRosterAgents', () => {
  it('puts ordered agents first by sortOrder and keeps unordered ones in input order', () => {
    const out = sortRosterAgents([a('u1'), a('x', 2), a('u2'), a('y', 0), a('z', 1)])
    expect(out.map((r) => r.id)).toEqual(['y', 'z', 'x', 'u1', 'u2'])
  })

  it('is stable for equal sortOrder (merged copies from several dens)', () => {
    const out = sortRosterAgents([a('p', 1), a('q', 1), a('r', 0)])
    expect(out.map((r) => r.id)).toEqual(['r', 'p', 'q'])
  })

  it('leaves an all-unordered roster as is', () => {
    expect(sortRosterAgents([a('b'), a('a'), a('c')]).map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('moveAgentId', () => {
  it('moves up, down, to the ends, and clamps', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(moveAgentId(ids, 'c', 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveAgentId(ids, 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveAgentId(ids, 'b', 99)).toEqual(['a', 'c', 'd', 'b'])
    expect(moveAgentId(ids, 'd', -5)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveAgentId(ids, 'missing', 0)).toEqual(ids)
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('sortOrderWrites', () => {
  it('writes each agent its index, skipping ones already stored there', () => {
    const agents = [a('a', 0), a('b'), a('c', 5)]
    expect(sortOrderWrites(agents, ['a', 'c', 'b']).map((w) => [w.agent.id, w.sortOrder])).toEqual([
      ['c', 1],
      ['b', 2],
    ])
  })

  it('skips ids that are not in the roster', () => {
    expect(sortOrderWrites([a('a')], ['gone', 'a'])).toEqual([{ agent: a('a'), sortOrder: 1 }])
  })

  it('a second order computed against the overlay writes what the snapshot alone would skip', () => {
    const agents = [a('a', 0), a('b', 1), a('c', 2)]
    expect(sortOrderWrites(agents, ['a', 'c', 'b']).map((w) => [w.agent.id, w.sortOrder])).toEqual([
      ['c', 1],
      ['b', 2],
    ])
    const known = new Map<string, number | undefined>([
      ['a', 0],
      ['c', 1],
      ['b', 2],
    ])
    expect(sortOrderWrites(agents, ['a', 'b', 'c'])).toEqual([])
    expect(
      sortOrderWrites(agents, ['a', 'b', 'c'], known).map((w) => [w.agent.id, w.sortOrder]),
    ).toEqual([
      ['b', 1],
      ['c', 2],
    ])
  })
})

describe('applyPendingOrder', () => {
  it('orders by the pending ids and keeps newcomers after them', () => {
    const out = applyPendingOrder([a('a'), a('b'), a('new'), a('c')], ['c', 'a', 'b'])
    expect(out.map((r) => r.id)).toEqual(['c', 'a', 'b', 'new'])
  })

  it('is a copy when nothing is pending', () => {
    const agents = [a('a'), a('b')]
    const out = applyPendingOrder(agents, null)
    expect(out).toEqual(agents)
    expect(out).not.toBe(agents)
  })
})
