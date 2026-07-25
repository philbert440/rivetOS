import { describe, it, expect } from 'vitest'
import {
  datahubBaseFromMesh,
  isValidWikiBase,
  normalizeWikiBase,
  wikiLinksToMarkdown,
} from './wiki-base.js'

describe('normalizeWikiBase', () => {
  it('accepts bare origins', () => {
    expect(normalizeWikiBase('http://192.168.1.10')).toBe('http://192.168.1.10')
    expect(normalizeWikiBase('http://192.168.1.10:80/')).toBe('http://192.168.1.10')
    expect(normalizeWikiBase('https://datahub.example.com')).toBe('https://datahub.example.com')
  })

  it('migrates legacy /wiki iframe URLs to origin', () => {
    expect(normalizeWikiBase('http://192.168.1.10/wiki')).toBe('http://192.168.1.10')
    expect(normalizeWikiBase('http://192.168.1.10:5174/wiki/')).toBe('http://192.168.1.10:5174')
  })

  it('strips any path/query/hash to origin', () => {
    expect(normalizeWikiBase('http://192.168.1.10/wiki?q=x#frag')).toBe('http://192.168.1.10')
  })

  it('rejects junk', () => {
    expect(normalizeWikiBase('')).toBe('')
    expect(normalizeWikiBase('   ')).toBe('')
    expect(normalizeWikiBase('javascript:alert(1)')).toBe('')
    expect(normalizeWikiBase('http://user:pass@192.168.1.10')).toBe('')
  })
})

describe('isValidWikiBase', () => {
  it('mirrors normalize truthiness', () => {
    expect(isValidWikiBase('http://192.168.1.10/wiki')).toBe(true)
    expect(isValidWikiBase('not a url')).toBe(false)
  })
})

describe('datahubBaseFromMesh', () => {
  it('finds datahub by id/name', () => {
    expect(
      datahubBaseFromMesh([
        {
          id: 'ct1',
          name: 'ct1',
          denUrl: 'http://192.168.1.1:5174',
          online: true,
          sessions: 0,
        },
        {
          id: 'datahub',
          name: 'rivet-datahub',
          denUrl: 'http://192.168.1.110/',
          online: true,
          sessions: null,
        },
      ]),
    ).toBe('http://192.168.1.110')
  })

  it('returns null when absent', () => {
    expect(
      datahubBaseFromMesh([
        {
          id: 'ct1',
          name: 'ct1',
          denUrl: 'http://192.168.1.1:5174',
          online: true,
          sessions: 0,
        },
      ]),
    ).toBeNull()
  })
})

describe('wikiLinksToMarkdown', () => {
  it('rewrites [[slug]] to /memory/slug links', () => {
    expect(wikiLinksToMarkdown('See [[task-engine]] and [[hub]].')).toBe(
      'See [task-engine](/memory/task-engine) and [hub](/memory/hub).',
    )
  })

  it('leaves non-wiki text alone', () => {
    expect(wikiLinksToMarkdown('no links here')).toBe('no links here')
  })
})
