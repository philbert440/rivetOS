import { describe, it, expect } from 'vitest'
import {
  datahubBaseFromMesh,
  headingId,
  isLanDenHost,
  isValidWikiBase,
  normalizeWikiBase,
  preferHttpsOrigin,
  tocFromMarkdown,
  wikiLinksToMarkdown,
} from './wiki-base.js'

describe('normalizeWikiBase', () => {
  it('accepts bare origins and upgrades LAN http to https:5174', () => {
    expect(normalizeWikiBase('http://192.168.1.10')).toBe('https://192.168.1.10:5174')
    expect(normalizeWikiBase('http://192.168.1.10:80/')).toBe('https://192.168.1.10:5174')
    expect(normalizeWikiBase('https://datahub.example.com')).toBe('https://datahub.example.com')
    expect(normalizeWikiBase('http://127.0.0.1:5174')).toBe('http://127.0.0.1:5174')
  })

  it('migrates legacy /wiki iframe URLs to origin', () => {
    expect(normalizeWikiBase('http://192.168.1.10/wiki')).toBe('https://192.168.1.10:5174')
    expect(normalizeWikiBase('http://192.168.1.10:5174/wiki/')).toBe('https://192.168.1.10:5174')
  })

  it('strips any path/query/hash to origin', () => {
    expect(normalizeWikiBase('http://192.168.1.10/wiki?q=x#frag')).toBe('https://192.168.1.10:5174')
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
    ).toBe('https://192.168.1.110:5174')
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

describe('isLanDenHost', () => {
  it('accepts RFC1918, CGNAT, and .mesh — not public names', () => {
    expect(isLanDenHost('10.0.0.5')).toBe(true)
    expect(isLanDenHost('192.168.1.10')).toBe(true)
    expect(isLanDenHost('172.16.0.1')).toBe(true) // generic RFC1918 example, secret-scan-allow
    expect(isLanDenHost('100.64.0.7')).toBe(true) // CGNAT (WG overlay), secret-scan-allow
    expect(isLanDenHost('ct110.mesh')).toBe(true)
    expect(isLanDenHost('datahub.example.com')).toBe(false)
    expect(isLanDenHost('8.8.8.8')).toBe(false)
  })
})

describe('preferHttpsOrigin', () => {
  it('leaves loopback on http', () => {
    expect(preferHttpsOrigin('http://127.0.0.1:5174')).toBe('http://127.0.0.1:5174')
  })

  it('pins implicit LAN ports to 5174 (http upgrade and bare https)', () => {
    expect(preferHttpsOrigin('http://192.168.1.10')).toBe('https://192.168.1.10:5174')
    expect(preferHttpsOrigin('https://10.0.0.5')).toBe('https://10.0.0.5:5174')
    expect(preferHttpsOrigin('https://ct110.mesh')).toBe('https://ct110.mesh:5174')
  })

  it('keeps an explicit den port and does not rewrite public hosts', () => {
    expect(preferHttpsOrigin('https://192.168.1.10:5174')).toBe('https://192.168.1.10:5174')
    expect(preferHttpsOrigin('https://datahub.example.com')).toBe('https://datahub.example.com')
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

describe('tocFromMarkdown / headingId', () => {
  it('collects ## and ### headings with ids', () => {
    const md = '# Title\n\n## Current state\n\ntext\n\n### Nested bit\n\n## History\n'
    expect(tocFromMarkdown(md)).toEqual([
      { level: 2, text: 'Current state', id: 'current-state' },
      { level: 3, text: 'Nested bit', id: 'nested-bit' },
      { level: 2, text: 'History', id: 'history' },
    ])
    expect(headingId('Hello World!')).toBe('hello-world')
  })
})
