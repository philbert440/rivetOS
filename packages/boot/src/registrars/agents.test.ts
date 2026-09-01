import { describe, it, expect, afterEach, vi } from 'vitest'
import { makeWikiFor, memoryApiEmbedFromEnv, resolveAdvertiseHost } from './agents.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveAdvertiseHost', () => {
  it('prefers an explicit advertise_host', () => {
    expect(resolveAdvertiseHost({ advertise_host: '192.0.2.4' })).toBe('192.0.2.4')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveAdvertiseHost({ advertise_host: '  host.example  ' })).toBe('host.example')
  })

  it('falls back to RIVETOS_HOST when advertise_host is unset', () => {
    vi.stubEnv('RIVETOS_HOST', '192.0.2.50')
    expect(resolveAdvertiseHost({})).toBe('192.0.2.50')
    expect(resolveAdvertiseHost(undefined)).toBe('192.0.2.50')
  })

  it('ignores a blank advertise_host and falls back', () => {
    vi.stubEnv('RIVETOS_HOST', '192.0.2.51')
    expect(resolveAdvertiseHost({ advertise_host: '   ' })).toBe('192.0.2.51')
  })
})

describe('createMemoryApiRoute env pass-through', () => {
  it('receives embedQueryInstruction, embedTimeoutMs, hnswEfSearch from env', () => {
    vi.stubEnv('RIVETOS_EMBED_QUERY_INSTRUCTION', 'Instruct: test\nQuery: ')
    vi.stubEnv('RIVETOS_EMBED_TIMEOUT_MS', '8000')
    vi.stubEnv('RIVETOS_HNSW_EF_SEARCH', '80')
    expect(memoryApiEmbedFromEnv()).toEqual({
      embedQueryInstruction: 'Instruct: test\nQuery: ',
      embedTimeoutMs: '8000',
      hnswEfSearch: '80',
    })
  })
})

describe('makeWikiFor (#584 audit: refusal order is the pin)', () => {
  const fakePool = {} as never
  const UNSAFE = [
    '..',
    '../..',
    'a/b',
    'a\\b',
    '/etc/passwd',
    '.hidden',
    'coco/../../..',
    '%2e%2e',
    'a\0b',
  ]

  it('refuses unsafe ids before the pool lookup or any path join', () => {
    const gets: string[] = []
    class SpyMap extends Map<string, never> {
      override get(k: string): never | undefined {
        gets.push(k)
        return super.get(k)
      }
    }
    const pools = new SpyMap([['..', fakePool]]) // even a poisoned pool entry must be unreachable
    const buildIndex = vi.fn(() => ({}))
    const wikiFor = makeWikiFor(pools, '/root', buildIndex)
    for (const evil of UNSAFE) {
      expect(wikiFor(evil)).toBeNull()
    }
    expect(gets).toHaveLength(0)
    expect(buildIndex).not.toHaveBeenCalled()
  })

  it('safe unknown ids consult the pool map and refuse; known ids get a joined dir once', () => {
    const gets: string[] = []
    class SpyMap extends Map<string, never> {
      override get(k: string): never | undefined {
        gets.push(k)
        return super.get(k)
      }
    }
    const pools = new SpyMap([['coco', fakePool]])
    const buildIndex = vi.fn(() => ({ tag: 'idx' }))
    const wikiFor = makeWikiFor(pools, '/root', buildIndex)

    expect(wikiFor('stranger')).toBeNull()
    expect(gets).toContain('stranger')

    const first = wikiFor('coco')
    expect(first?.wikiDir).toBe('/root/users/coco')
    expect(wikiFor('coco')).toBe(first) // cached
    expect(buildIndex).toHaveBeenCalledTimes(1)
  })
})
