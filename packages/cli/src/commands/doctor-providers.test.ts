import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProviderConnectivity, checkProviders, probeErrorDetail } from './doctor.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllEnvs()
})

describe('checkProviders (vllm with a ${VAR} api_key)', () => {
  const yaml = [
    'providers:',
    '  vllm:',
    '    base_url: https://api.z.example/api/coding/paas/v4',
    '    api_prefix: ""',
    '    api_key: ${ZAI_API_KEY}',
    '    model: glm-5.3-flash',
    '',
  ].join('\n')

  it('sends the RESOLVED key as the bearer token to <base><api_prefix>/models', async () => {
    vi.stubEnv('ZAI_API_KEY', 'real-key')
    const seen: Array<{ url: string; auth: string | undefined }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(input), auth: headers.Authorization })
      // The upstream behaviour behind the false negative: a literal `${VAR}`
      // bearer is a 401; the real key is a 200.
      return new Response('{}', { status: headers.Authorization === 'Bearer real-key' ? 200 : 401 })
    }) as typeof fetch

    const results = await checkProviders(yaml)
    expect(results.map((r) => `${r.status} ${r.message}`)).toEqual([
      'pass Provider vllm: reachable',
    ])
    expect(seen).toEqual([
      { url: 'https://api.z.example/api/coding/paas/v4/models', auth: 'Bearer real-key' },
    ])
  })

  it('reports unreachable when the placeholder is not set (empty key, like the runtime)', async () => {
    vi.stubEnv('ZAI_API_KEY', '')
    const seen: Array<string | undefined> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(((init?.headers ?? {}) as Record<string, string>).Authorization)
      return new Response('{}', { status: 401 })
    }) as typeof fetch
    const results = await checkProviders(yaml)
    expect(results.map((r) => r.message)).toEqual(['Provider vllm: unreachable'])
    expect(seen).toEqual([undefined])
  })

  it('never echoes the resolved key in an error detail', async () => {
    vi.stubEnv('ZAI_API_KEY', 'FAKE-REVIEW-SECRET\ntrailing')
    globalThis.fetch = (async () => {
      // what native fetch says about a header value containing a newline
      throw new TypeError(
        'Headers.append: "Bearer FAKE-REVIEW-SECRET\ntrailing" is an invalid header value.',
      )
    }) as typeof fetch
    const [r] = await checkProviders(yaml)
    expect(r.message).toBe('Provider vllm: error')
    expect(r.detail).toBe('TypeError')
  })
})

describe('probeErrorDetail', () => {
  it('reports only the error class and code, never the message', () => {
    const fetchFailed = new TypeError('fetch failed https://h.example/secret-in-url')
    ;(fetchFailed as { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
    expect(probeErrorDetail(fetchFailed)).toBe('TypeError (ECONNREFUSED)')
    const badUrl = new TypeError('Failed to parse URL from not-a-url/FAKE-URL-SECRET/models')
    ;(badUrl as { cause?: unknown }).cause = { code: 'ERR_INVALID_URL' }
    expect(probeErrorDetail(badUrl)).toBe('TypeError (ERR_INVALID_URL)')
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    expect(probeErrorDetail(timeout)).toBe('TimeoutError (timeout)')
    expect(probeErrorDetail('boom')).toBe('unknown error')
  })
})

describe('checkProviders error details (native fetch, no network)', () => {
  it('does not echo a key with trailing whitespace that native header validation trims', async () => {
    vi.stubEnv('K', 'FAKE-REVIEW-SECRET\ntrailing\n')
    const [r] = await checkProviders(['providers:', '  xai:', '    api_key: ${K}', ''].join('\n'))
    // native fetch: 'Headers.append: "Bearer FAKE-REVIEW-SECRET\ntrailing" is an invalid header value.'
    expect(r.message).toBe('Provider xai: error')
    expect(r.detail).toBe('TypeError')
  })

  it('does not echo a secret substituted into a base_url, even one the probe normalised', async () => {
    vi.stubEnv('K', 'FAKE-URL-SECRET/v1')
    const [r] = await checkProviders(
      ['providers:', '  vllm:', '    base_url: not-a-url/${K}', '    api_prefix: ""', ''].join(
        '\n',
      ),
    )
    // native fetch rejects the relative URL: "Failed to parse URL from not-a-url/FAKE-URL-SECRET/models"
    expect(r.message).toBe('Provider vllm: error')
    expect(r.detail).toBe('TypeError (ERR_INVALID_URL)')
  })
})

describe('checkProviderConnectivity (vllm URL shapes)', () => {
  it('keeps the /v1 default and honours models_url', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await checkProviderConnectivity('vllm', {
      base_url: 'https://api.deepseek.example/v1',
      api_key: 'k',
    })
    await checkProviderConnectivity('vllm', {
      base_url: 'https://api.z.example/api/coding/paas/v4',
      api_prefix: '',
      models_url: 'https://api.z.example/api/paas/v4/models',
    })
    expect(urls).toEqual([
      'https://api.deepseek.example/v1/models',
      'https://api.z.example/api/paas/v4/models',
    ])
  })
})
