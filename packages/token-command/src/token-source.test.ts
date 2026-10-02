import { describe, it, expect, vi } from 'vitest'
import {
  createTokenSource,
  createAuthorizedFetch,
  parseTokenCommandArgv,
  DEFAULT_TOKEN_TTL_MS,
} from './token-source.js'

describe('parseTokenCommandArgv', () => {
  it('returns null when unset', () => {
    expect(parseTokenCommandArgv(undefined)).toBeNull()
    expect(parseTokenCommandArgv(null)).toBeNull()
  })

  it('rejects a shell string', () => {
    expect(parseTokenCommandArgv('op read …')).toMatch(/argv array/)
  })

  it('rejects empty or non-string entries', () => {
    expect(parseTokenCommandArgv([])).toMatch(/non-empty/)
    expect(parseTokenCommandArgv(['ok', ''])).toMatch(/non-empty strings/)
    expect(parseTokenCommandArgv(['ok', 1])).toMatch(/non-empty strings/)
  })

  it('accepts a valid argv array', () => {
    expect(parseTokenCommandArgv(['/bin/helper', '--out'])).toEqual(['/bin/helper', '--out'])
  })
})

describe('createTokenSource', () => {
  it('mints, caches within TTL, and remints after expiry', async () => {
    let now = 1_000
    let n = 0
    const runCommand = vi.fn(async () => {
      n += 1
      return `token-${n}\n`
    })
    const src = createTokenSource({
      argv: ['helper'],
      ttlMs: 100,
      runCommand,
      now: () => now,
    })

    expect(await src.getToken()).toBe('token-1')
    expect(await src.getToken()).toBe('token-1')
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(src.getCachedToken()).toBe('token-1')

    now = 1_000 + 100
    expect(src.getCachedToken()).toBeUndefined()
    expect(await src.getToken()).toBe('token-2')
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it('invalidate forces a remint', async () => {
    let n = 0
    const src = createTokenSource({
      argv: ['helper'],
      runCommand: async () => `t-${++n}`,
    })
    expect(await src.getToken()).toBe('t-1')
    src.invalidate()
    expect(await src.getToken()).toBe('t-2')
  })

  it('coalesces concurrent mint calls', async () => {
    let resolveMint!: (v: string) => void
    const runCommand = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveMint = r
        }),
    )
    const src = createTokenSource({ argv: ['helper'], runCommand })
    const a = src.getToken()
    const b = src.getToken()
    resolveMint('shared')
    expect(await a).toBe('shared')
    expect(await b).toBe('shared')
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('rejects empty stdout without echoing output', async () => {
    const src = createTokenSource({
      argv: ['helper'],
      runCommand: async () => '   \n',
    })
    await expect(src.getToken()).rejects.toThrow(/empty stdout/)
  })

  it('rejects multi-line stdout', async () => {
    const src = createTokenSource({
      argv: ['helper'],
      runCommand: async () => 'abc\nleak',
    })
    await expect(src.getToken()).rejects.toThrow(/single line/)
  })

  it('authHeaders sets Bearer without logging the token', async () => {
    const src = createTokenSource({
      argv: ['helper'],
      runCommand: async () => 'sekrit',
    })
    await expect(src.authHeaders({ Accept: 'application/json' })).resolves.toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer sekrit',
    })
  })

  it('uses default TTL when unset', () => {
    expect(DEFAULT_TOKEN_TTL_MS).toBe(300_000)
  })
})

describe('createAuthorizedFetch', () => {
  it('injects Bearer and remints once on 401', async () => {
    let n = 0
    const src = createTokenSource({
      argv: ['helper'],
      runCommand: async () => `tok-${++n}`,
    })
    const calls: Array<{ auth: string | null }> = []
    const baseFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const auth = headers.get('Authorization')
      calls.push({ auth })
      if (auth === 'Bearer tok-1') {
        return new Response('nope', { status: 401 })
      }
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const f = createAuthorizedFetch({ tokenSource: src, baseFetch })
    const res = await f('https://example.test/v1/models')
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ auth: 'Bearer tok-1' }, { auth: 'Bearer tok-2' }])
  })

  it('sets x-api-key when configured', async () => {
    const src = createTokenSource({
      argv: ['helper'],
      runCommand: async () => 'anth-key',
    })
    const baseFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('x-api-key')).toBe('anth-key')
      expect(headers.get('Authorization')).toBeNull()
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const f = createAuthorizedFetch({
      tokenSource: src,
      headerName: 'x-api-key',
      baseFetch,
    })
    await f('https://example.test/v1/messages', { method: 'POST' })
  })
})
