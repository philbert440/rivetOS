import { describe, expect, it } from 'vitest'
import { mergeRoster } from './roster-merge.js'

const legacy = JSON.stringify([
  { name: 'Claude', baseUrl: 'https://192.0.2.15:5174' },
  { name: 'Grok', baseUrl: 'https://192.0.2.12:5174' },
])

describe('mergeRoster', () => {
  it('adopts the legacy roster wholesale when none exists yet', () => {
    expect(mergeRoster(null, legacy)).toBe(legacy)
  })

  it('merges behind hand-rebuilt entries, current names winning on collision', () => {
    const current = JSON.stringify([{ name: 'Claude (new)', baseUrl: 'https://192.0.2.15:5174' }])
    expect(JSON.parse(mergeRoster(current, legacy)!)).toEqual([
      { name: 'Claude (new)', baseUrl: 'https://192.0.2.15:5174' },
      { name: 'Grok', baseUrl: 'https://192.0.2.12:5174' },
    ])
  })

  it('returns null (no write) when nothing new would be added', () => {
    expect(mergeRoster(legacy, legacy)).toBeNull()
  })

  it('never touches storage on unparseable input, either side', () => {
    expect(mergeRoster('not json', legacy)).toBeNull()
    expect(mergeRoster(legacy, 'not json')).toBeNull()
    expect(mergeRoster(null, '{"not":"an array"}')).toBeNull()
  })

  it('drops malformed legacy entries but keeps the valid ones', () => {
    const dirty = JSON.stringify([
      { name: 'Good', baseUrl: 'https://192.0.2.20:5174' },
      { nope: true },
      'garbage',
    ])
    expect(JSON.parse(mergeRoster(null, dirty)!)).toEqual([
      { name: 'Good', baseUrl: 'https://192.0.2.20:5174' },
    ])
  })
})
