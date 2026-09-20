import type { MeshOverview } from '@rivetos/types'
import { describe, expect, it } from 'vitest'
import { shouldHideNodePickers } from './node-picker-visibility.js'

const A = { name: 'alpha', baseUrl: 'https://alpha.example' }
const empty = { updatedAt: 1, nodes: [] }

describe('shouldHideNodePickers', () => {
  it('keeps an unknown roster visible', () => {
    expect(shouldHideNodePickers(undefined, A.baseUrl, A.baseUrl, empty, 'success')).toBe(false)
  })

  it('keeps an unknown connection visible', () => {
    expect(shouldHideNodePickers([A], undefined, A.baseUrl, empty, 'success')).toBe(false)
  })

  it('keeps an unknown origin visible with an empty roster', () => {
    expect(shouldHideNodePickers([], A.baseUrl, undefined, empty, 'success')).toBe(false)
  })

  const B = { name: 'beta', baseUrl: 'https://beta.example' }
  const node = (saved: typeof A) => ({
    id: saved.name,
    name: saved.name,
    denUrl: saved.baseUrl,
    online: true,
    sessions: 0,
  })
  const states: {
    label: string
    status: 'pending' | 'error' | 'success'
    mesh?: MeshOverview
    peer: boolean
  }[] = [
    { label: 'pending', status: 'pending', peer: false },
    { label: 'error', status: 'error', peer: false },
    { label: 'settled-1', status: 'success', mesh: { ...empty, nodes: [node(A)] }, peer: false },
    {
      label: 'settled-2',
      status: 'success',
      mesh: { ...empty, nodes: [node(A), node(B)] },
      peer: true,
    },
  ]
  it.each([0, 1, 2].flatMap((count) => states.map((state) => ({ ...state, count }))))(
    '$count saved nodes / $label',
    ({ count, status, mesh, peer }) => {
      expect(
        shouldHideNodePickers([A, B].slice(0, count), A.baseUrl, A.baseUrl, mesh, status),
      ).toBe(count < 2 && !peer)
    },
  )

  it('normalizes trailing slashes for connection and origin comparisons', () => {
    expect(shouldHideNodePickers([A], `${A.baseUrl}/`, A.baseUrl, empty, 'success')).toBe(true)
    expect(shouldHideNodePickers([], A.baseUrl, `${A.baseUrl}/`, empty, 'success')).toBe(true)
  })

  it('does not claim there are no peers when another node is offline', () => {
    const mesh = {
      updatedAt: 1,
      nodes: [
        { id: 'beta', name: 'beta', denUrl: 'https://beta.example', online: false, sessions: null },
      ],
    }
    expect(shouldHideNodePickers([A], A.baseUrl, A.baseUrl, mesh, 'success')).toBe(false)
  })
})
