import { describe, it, expect } from 'vitest'
import {
  isSlugVariant,
  preferCanonicalSlug,
  findStemMatch,
  clusterSlugsByStem,
  entitiesOverlap,
  slugTokenPrefix,
} from './identity.js'

describe('isSlugVariant / preferCanonicalSlug', () => {
  it('detects hyphen-boundary parent/child', () => {
    expect(isSlugVariant('deckard-40b', 'deckard-40b-awq-grid-search')).toBe(true)
    expect(isSlugVariant('deckard-40b-awq', 'deckard-40b')).toBe(true)
    expect(isSlugVariant('deckard-40b', 'gerty-vllm')).toBe(false)
    expect(isSlugVariant('rivetos-memory', 'rivetos-memory-wiki')).toBe(true)
  })

  it('prefers shorter parent as canonical', () => {
    expect(preferCanonicalSlug('deckard-40b-awq', 'deckard-40b')).toBe('deckard-40b')
    expect(preferCanonicalSlug('deckard-40b', 'deckard-40b-awq')).toBe('deckard-40b')
  })
})

describe('findStemMatch', () => {
  it('returns shortest matching parent from inventory', () => {
    const existing = [
      'deckard-40b-benchmarking',
      'deckard-40b-awq-grid-search',
      'gerty-vllm',
      'deckard-40b',
    ]
    expect(findStemMatch('deckard-40b-awq-grid-search', existing)).toBe('deckard-40b')
    expect(findStemMatch('deckard-40b', existing)).toBe('deckard-40b')
    expect(findStemMatch('totally-unrelated', existing)).toBeUndefined()
  })
})

describe('clusterSlugsByStem', () => {
  it('groups 3+ token slugs by first two tokens', () => {
    const groups = clusterSlugsByStem([
      'deckard-40b-awq',
      'deckard-40b-bench',
      'gerty-vllm',
      'rivetos-memory-wiki',
      'rivetos-memory-plugin',
    ])
    expect(groups.get('deckard-40b')?.sort()).toEqual(['deckard-40b-awq', 'deckard-40b-bench'])
    expect(groups.get('rivetos-memory')?.sort()).toEqual([
      'rivetos-memory-plugin',
      'rivetos-memory-wiki',
    ])
    expect(groups.get('gerty-vllm')).toEqual(['gerty-vllm'])
  })
})

describe('entitiesOverlap / slugTokenPrefix', () => {
  it('entity set intersection', () => {
    expect(entitiesOverlap(['model:deckard-40b'], ['host:pve3', 'model:deckard-40b'])).toBe(true)
    expect(entitiesOverlap(['a'], ['b'])).toBe(false)
    expect(entitiesOverlap([], ['a'])).toBe(false)
  })

  it('token prefix', () => {
    expect(slugTokenPrefix('deckard-40b-awq-grid', 2)).toBe('deckard-40b')
    expect(slugTokenPrefix('wiki', 2)).toBe('wiki')
  })
})
