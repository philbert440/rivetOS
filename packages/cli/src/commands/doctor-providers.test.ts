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
  it('scrubs substituted env values, credential-looking fields and probe fallbacks', () => {
    const env = { K: 'abc123', HOST: 'h.example', T: 'tok', VLLM_API_KEY: 'fallback-key' }
    const raw = {
      api_key: '${K}',
      base_url: 'https://${HOST}/v1',
      model: 'm',
      nested: { token: '${T}' },
    }
    const resolved = {
      api_key: 'abc123',
      base_url: 'https://h.example/v1',
      model: 'm',
      nested: { token: 'tok' },
    }
    const out = redactResolvedSecrets(
      'URL https://h.example/models with abc123, tok, fallback-key for m',
      raw,
      resolved,
      env,
    )
    // the host was substituted (so it is scrubbed) even though the probe
    // normalised the URL and the whole resolved field never appears
    expect(out).toBe('URL https://[redacted]/models with [redacted], [redacted], [redacted] for m')
  })

  it('scrubs a literal api_key and the escaped-newline form of a value', () => {
    const raw = { api_key: 'LIT-SECRET\ntrailing' }
    const out = redactResolvedSecrets(
      'bad: "Bearer LIT-SECRET\ntrailing" and escaped LIT-SECRET\\ntrailing',
      raw,
      raw,
      {},
    )
    expect(out).toBe('bad: "Bearer [redacted]" and escaped [redacted]')
  })
})

describe('checkProviders error details (native fetch, no network)', () => {
  it('does not echo a key with trailing whitespace that native header validation trims', async () => {
    vi.stubEnv('K', 'FAKE-REVIEW-SECRET\ntrailing\n')
    const [r] = await checkProviders(['providers:', '  xai:', '    api_key: ${K}', ''].join('\n'))
    // native fetch: 'Headers.append: "Bearer FAKE-REVIEW-SECRET\ntrailing" is an invalid header value.'
    expect(r.message).toBe('Provider xai: error')
    expect(r.detail).toBeDefined()
    expect(r.detail).not.toContain('FAKE-REVIEW-SECRET')
    expect(r.detail).toContain('[redacted]')
  })

  it('does not echo a secret substituted into a base_url the probe normalised', async () => {
    vi.stubEnv('K', 'FAKE-URL-SECRET')
    const [r] = await checkProviders(
      ['providers:', '  vllm:', '    base_url: not-a-url/${K}/v1', '    api_prefix: ""', ''].join(
        '\n',
      ),
    )
    // native fetch rejects the relative URL: "Failed to parse URL from not-a-url/…/models"
    expect(r.message).toBe('Provider vllm: error')
    expect(r.detail).toBeDefined()
    expect(r.detail).not.toContain('FAKE-URL-SECRET')
    expect(r.detail).toContain('[redacted]')
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
