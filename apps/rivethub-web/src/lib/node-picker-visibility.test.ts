import { describe, expect, it } from 'vitest'
import { shouldHideNodePickers } from './node-picker-visibility.js'

const A = { name: 'alpha', baseUrl: 'https://alpha.example' }
const empty = { updatedAt: 1, nodes: [] }

describe('shouldHideNodePickers', () => {
  it('keeps an unknown roster visible', () => {
    expect(shouldHideNodePickers(undefined, A.baseUrl, A.baseUrl, empty)).toBe(false)
  })

  it('keeps an unknown connection visible', () => {
    expect(shouldHideNodePickers([A], undefined, A.baseUrl, empty)).toBe(false)
  })

  it('keeps an unknown origin visible with an empty roster', () => {
    expect(shouldHideNodePickers([], A.baseUrl, undefined, empty)).toBe(false)
  })

  it('keeps unknown discovery visible', () => {
    expect(shouldHideNodePickers([A], A.baseUrl, A.baseUrl, undefined)).toBe(false)
  })

  it('normalizes trailing slashes for connection and origin comparisons', () => {
    expect(shouldHideNodePickers([A], `${A.baseUrl}/`, A.baseUrl, empty)).toBe(true)
    expect(shouldHideNodePickers([], A.baseUrl, `${A.baseUrl}/`, empty)).toBe(true)
  })

  it('does not claim there are no peers when another node is offline', () => {
    const mesh = {
      updatedAt: 1,
      nodes: [{ id: 'beta', name: 'beta', denUrl: 'https://beta.example', online: false, sessions: null }],
    }
    expect(shouldHideNodePickers([A], A.baseUrl, A.baseUrl, mesh)).toBe(false)
  })
})
