import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProviderConnectivity, resolveProviderEnv } from './doctor.js'

describe('resolveProviderEnv', () => {
  it('resolves ${VAR} from the process env first, then ~/.rivetos/.env', () => {
    const cfg = {
      api_key: '${ZAI_API_KEY}',
      base_url: 'https://api.example.test/${REGION}/v4',
      model: 'glm-5.3-flash',
      probe_models: true,
      nested: { token: '${ONLY_IN_FILE}' },
      list: ['${REGION}', 'literal'],
    }
    const out = resolveProviderEnv(
      cfg,
      { ZAI_API_KEY: 'from-env', REGION: 'us' },
      'ZAI_API_KEY=from-file\nONLY_IN_FILE="file-value" # comment\n',
    )
    expect(out.api_key).toBe('from-env')
    expect(out.base_url).toBe('https://api.example.test/us/v4')
    expect(out.nested).toEqual({ token: 'file-value' })
    expect(out.list).toEqual(['us', 'literal'])
    expect(out.model).toBe('glm-5.3-flash')
    expect(out.probe_models).toBe(true)
    // pure — the parsed YAML block is not mutated
    expect(cfg.api_key).toBe('${ZAI_API_KEY}')
  })

  it('resolves unknown names to an empty string like the runtime loader', () => {
    const out = resolveProviderEnv({ api_key: '${NOPE}' }, {}, null)
    expect(out.api_key).toBe('')
  })
})

describe('checkProviderConnectivity (vllm)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('sends the RESOLVED key as the bearer token to <base><api_prefix>/models', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(input), auth: headers.Authorization })
      // The upstream behaviour that produced the false negative: a literal
      // `${VAR}` bearer is a 401; the real key is a 200.
      return new Response('{}', { status: headers.Authorization === 'Bearer real-key' ? 200 : 401 })
    }) as typeof fetch

    const raw = {
      base_url: 'https://api.z.example/api/coding/paas/v4',
      api_prefix: '',
      api_key: '${ZAI_API_KEY}',
    }
    // unresolved (what doctor used to do) → unreachable
    expect(await checkProviderConnectivity('vllm', raw)).toBe(false)
    expect(seen[0].auth).toBe('Bearer ${ZAI_API_KEY}')

    // resolved from the EnvironmentFile → reachable, same URL
    const resolved = resolveProviderEnv(raw, {}, 'ZAI_API_KEY=real-key\n')
    expect(await checkProviderConnectivity('vllm', resolved)).toBe(true)
    expect(seen[1]).toEqual({
      url: 'https://api.z.example/api/coding/paas/v4/models',
      auth: 'Bearer real-key',
    })
  })

  it('keeps the /v1 default and honours models_url', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await checkProviderConnectivity('vllm', { base_url: 'https://api.deepseek.example/v1', api_key: 'k' })
    await checkProviderConnectivity('vllm', {
      base_url: 'https://api.z.example/api/coding/paas/v4',
      api_prefix: '',
      models_url: 'https://api.z.example/api/paas/v4/models',
    })
    expect(urls).toEqual([
      'https://api.deepseek.example/v1/models',
      'https://api.z.example/api/paas/v4/models',
    ])
    vi.restoreAllMocks()
  })
})
