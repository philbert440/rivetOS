import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProviderConnectivity, checkProviders, redactResolvedSecrets } from './doctor.js'

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
    expect(r.detail).not.toContain('FAKE-REVIEW-SECRET')
    expect(r.detail).toContain('[redacted]')
  })
})

describe('redactResolvedSecrets', () => {
  it('scrubs every env-sourced string, longest first, and leaves literals alone', () => {
    const raw = {
      api_key: '${K}',
      base_url: 'https://${HOST}/v1',
      model: 'm',
      nested: { t: '${T}' },
    }
    const resolved = {
      api_key: 'abc123',
      base_url: 'https://h.example/v1',
      model: 'm',
      nested: { t: 'tok' },
    }
    const out = redactResolvedSecrets(
      'Failed to parse URL from https://h.example/v1/models with abc123 and tok for m',
      raw,
      resolved,
    )
    expect(out).toBe(
      'Failed to parse URL from [redacted]/models with [redacted] and [redacted] for m',
    )
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
