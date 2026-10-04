/**
 * Fail-loudly config: RIVETOS_COMPACTOR_MODEL is required alongside the URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REQUIRED = {
  RIVETOS_PG_URL: 'postgres://rivet@localhost/test',
  RIVETOS_COMPACTOR_URL: 'http://127.0.0.1:8000/v1',
  RIVETOS_COMPACTOR_MODEL: 'gpt-4o-mini',
} as const

function stubRequired(overrides: Record<string, string | undefined> = {}): void {
  const merged: Record<string, string | undefined> = { ...REQUIRED, ...overrides }
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === '') {
      vi.stubEnv(key, '')
      delete process.env[key]
    } else {
      vi.stubEnv(key, value)
    }
  }
}

function trapExit(): { exit: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code ?? '')}`)
  }) as never)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  return { exit, error }
}

function logged(error: ReturnType<typeof vi.spyOn>): string {
  return error.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
}

describe('compaction-worker config', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('loads the provided model when URL and model are set', async () => {
    stubRequired()
    const { config } = await import('./config.js')
    expect(config.llmModel).toBe('gpt-4o-mini')
    expect(config.llmUrl).toBe('http://127.0.0.1:8000/v1')
    expect(config.toolSynthModel).toBe('gpt-4o-mini')
  })

  it('exits when RIVETOS_COMPACTOR_MODEL is missing with URL set', async () => {
    stubRequired({ RIVETOS_COMPACTOR_MODEL: '' })
    const { exit, error } = trapExit()

    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(exit).toHaveBeenCalledWith(1)
    const msg = logged(error)
    expect(msg).toContain('RIVETOS_COMPACTOR_MODEL')
    expect(msg).toMatch(/gpt-4o-mini/)
  })

  it('lets TOOL_SYNTH_MODEL override the required compactor model', async () => {
    stubRequired()
    vi.stubEnv('TOOL_SYNTH_MODEL', 'gpt-4o')
    const { config } = await import('./config.js')
    expect(config.llmModel).toBe('gpt-4o-mini')
    expect(config.toolSynthModel).toBe('gpt-4o')
  })

  it('tags with the compactor model when no RIVETOS_TAGGER_URL is set', async () => {
    stubRequired({ RIVETOS_COMPACTOR_API_KEY: 'compactor-key' })
    const { config } = await import('./config.js')
    expect(config.taggingEnabled).toBe(true)
    expect(config.taggerUsesCompactor).toBe(true)
    expect(config.tagger).toEqual({
      url: 'http://127.0.0.1:8000/v1',
      model: 'gpt-4o-mini',
      apiKey: 'compactor-key',
      transientStatuses: [],
    })
    expect(config.taggerWireShape).toBe('openai')
  })

  it('does not send the compactor key to a different tagger host', async () => {
    stubRequired({ RIVETOS_COMPACTOR_API_KEY: 'compactor-key' })
    vi.stubEnv('RIVETOS_TAGGER_URL', 'https://classifier.internal/classify')
    vi.stubEnv('RIVETOS_TAGGER_MODEL', 'tagger-v1')
    vi.stubEnv('RIVETOS_TAGGER_WIRE_SHAPE', 'native')
    const { config } = await import('./config.js')
    expect(config.taggerUsesCompactor).toBe(false)
    expect(config.tagger).toEqual({
      url: 'https://classifier.internal/classify',
      model: 'tagger-v1',
      apiKey: '',
      transientStatuses: [],
    })
    expect(config.taggerWireShape).toBe('native')
  })

  it('mints a tagger token from RIVETOS_TAGGER_TOKEN_COMMAND (JSON argv only)', async () => {
    stubRequired()
    vi.stubEnv('RIVETOS_TAGGER_URL', 'https://classifier.internal/classify')
    vi.stubEnv('RIVETOS_TAGGER_TOKEN_COMMAND', JSON.stringify(['/usr/local/bin/mint-token']))
    const { config } = await import('./config.js')
    expect(config.tagger.tokenSource).toBeDefined()
    expect(typeof config.tagger.tokenSource?.getToken).toBe('function')
  })

  it('exits on a shell-string RIVETOS_TAGGER_TOKEN_COMMAND', async () => {
    stubRequired()
    vi.stubEnv('RIVETOS_TAGGER_TOKEN_COMMAND', 'mint --token')
    const { exit, error } = trapExit()
    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(exit).toHaveBeenCalledWith(1)
    expect(logged(error)).toContain('RIVETOS_TAGGER_TOKEN_COMMAND')
  })

  it('exits when wire shape is native without a tagger URL, or unknown', async () => {
    stubRequired()
    vi.stubEnv('RIVETOS_TAGGER_WIRE_SHAPE', 'native')
    const first = trapExit()
    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(logged(first.error)).toContain('requires RIVETOS_TAGGER_URL')
    vi.restoreAllMocks()
    vi.resetModules()
    stubRequired()
    vi.stubEnv('RIVETOS_TAGGER_WIRE_SHAPE', 'grpc')
    const second = trapExit()
    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(logged(second.error)).toContain('RIVETOS_TAGGER_WIRE_SHAPE')
  })

  it.each([
    ['RIVETOS_TAGGER_API_KEY', 'classifier-key'],
    ['RIVETOS_TAGGER_TOKEN_COMMAND', JSON.stringify(['/usr/local/bin/mint-token'])],
  ])('refuses %s without RIVETOS_TAGGER_URL (it would go to the compactor endpoint)', async (name, value) => {
    stubRequired({ RIVETOS_COMPACTOR_API_KEY: 'compactor-key' })
    vi.stubEnv(name, value)
    const { exit, error } = trapExit()
    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(exit).toHaveBeenCalledWith(1)
    expect(logged(error)).toContain('require RIVETOS_TAGGER_URL')
  })

  it('treats an empty RIVETOS_TAGGER_API_KEY as unset: the compactor fallback still authenticates', async () => {
    stubRequired({ RIVETOS_COMPACTOR_API_KEY: 'compactor-key' })
    process.env.RIVETOS_TAGGER_API_KEY = '  '
    try {
      const { config } = await import('./config.js')
      expect(config.tagger.apiKey).toBe('compactor-key')
    } finally {
      delete process.env.RIVETOS_TAGGER_API_KEY
    }
  })

  it('does not apply the credential guard when tagging is disabled', async () => {
    stubRequired()
    vi.stubEnv('SESSION_TAGGING', '0')
    vi.stubEnv('RIVETOS_TAGGER_API_KEY', 'left-in-a-template')
    const { config } = await import('./config.js')
    expect(config.taggingEnabled).toBe(false)
  })

  it('a disabled tagger ignores leftover tagger settings instead of refusing to start', async () => {
    stubRequired({ RIVETOS_COMPACTOR_API_KEY: 'compactor-key' })
    vi.stubEnv('SESSION_TAGGING', 'off')
    vi.stubEnv('RIVETOS_TAGGER_TOKEN_COMMAND', 'not json')
    vi.stubEnv('RIVETOS_TAGGER_WIRE_SHAPE', 'native')
    vi.stubEnv('RIVETOS_TAGGER_URL', 'not a url')
    vi.stubEnv('RIVETOS_TAGGER_TIMEOUT_SECONDS', '0')
    vi.stubEnv('RIVETOS_TAGGER_TRANSIENT_STATUSES', '500')
    vi.stubEnv('RIVETOS_TAGGER_API_KEY', 'left-in-a-template')
    vi.stubEnv('RIVETOS_TAGGER_MODEL', 'tagger-v1')
    const { config } = await import('./config.js')
    expect(config.taggingEnabled).toBe(false)
    expect(config.taggerTimeoutMs).toBe(60_000)
    expect(config.tagger.transientStatuses).toEqual([])
    expect(config.tagger.apiKey).toBe('compactor-key')
    expect(config.tagger.model).toBe(config.llmModel)
    expect(config.taggerWireShape).toBe('openai')
    expect(config.tagger.tokenSource).toBeUndefined()
  })

  it('keeps a tagger key with its own URL, and bounds the tagger timeout', async () => {
    stubRequired({ RIVETOS_COMPACTOR_API_KEY: 'compactor-key' })
    vi.stubEnv('RIVETOS_TAGGER_URL', 'https://classifier.internal/v1')
    vi.stubEnv('RIVETOS_TAGGER_API_KEY', 'classifier-key')
    const { config } = await import('./config.js')
    expect(config.tagger.apiKey).toBe('classifier-key')
    expect(config.taggerTimeoutMs).toBe(60_000)
    vi.resetModules()
    vi.stubEnv('RIVETOS_TAGGER_TIMEOUT_SECONDS', '15')
    expect((await import('./config.js')).config.taggerTimeoutMs).toBe(15_000)
  })

  it.each(['0', 'false', 'No', 'OFF'])('SESSION_TAGGING=%s disables tagging', async (value) => {
    stubRequired()
    vi.stubEnv('SESSION_TAGGING', value)
    const { config } = await import('./config.js')
    expect(config.taggingEnabled).toBe(false)
  })

  it('leaves workerRoleEnv unset when WORKER_ROLE is unset (parsed in main)', async () => {
    stubRequired()
    vi.stubEnv('WORKER_ROLE', '')
    delete process.env.WORKER_ROLE
    const { config } = await import('./config.js')
    expect(config.workerRoleEnv).toBeUndefined()
  })

  it('reads WORKER_ROLE=wiki as workerRoleEnv (parsed in main)', async () => {
    stubRequired()
    vi.stubEnv('WORKER_ROLE', 'wiki')
    const { config } = await import('./config.js')
    expect(config.workerRoleEnv).toBe('wiki')
  })

  it('does not throw at import when WORKER_ROLE is invalid (parse is deferred to main)', async () => {
    stubRequired()
    vi.stubEnv('WORKER_ROLE', 'embedder')
    const { config } = await import('./config.js')
    expect(config.workerRoleEnv).toBe('embedder')
  })

  it('parses RIVETOS_COMPACTOR_FALLBACKS with keys from the named env vars', async () => {
    stubRequired()
    vi.stubEnv('OPENROUTER_API_KEY', 'or-secret')
    vi.stubEnv(
      'RIVETOS_COMPACTOR_FALLBACKS',
      'https://nv.test/v1|google/gemma-4-31b-it, https://or.test/api/v1/|openai/gpt-oss-120b|OPENROUTER_API_KEY',
    )
    vi.stubEnv('RIVETOS_COMPACTOR_FALLBACK_COOLDOWN_MINUTES', '5')
    vi.stubEnv('RIVETOS_COMPACTOR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS', '120')
    const { config } = await import('./config.js')
    expect(config.llmFallbacks).toEqual([
      {
        url: 'https://nv.test/v1',
        model: 'google/gemma-4-31b-it',
        apiKey: '',
        transientStatuses: [],
      },
      {
        url: 'https://or.test/api/v1',
        model: 'openai/gpt-oss-120b',
        apiKey: 'or-secret',
        transientStatuses: [],
      },
    ])
    expect(config.llmFallbackCooldownMs).toBe(300_000)
    expect(config.llmFallbackAttemptTimeoutMs).toBe(120_000)
  })

  it('defaults cooldown to 15 minutes and attempt timeout to 300 seconds', async () => {
    stubRequired()
    const { config } = await import('./config.js')
    expect(config.llmFallbackCooldownMs).toBe(15 * 60_000)
    expect(config.llmFallbackAttemptTimeoutMs).toBe(300_000)
  })

  it('warns when transient statuses include request-scoped or auth codes', async () => {
    stubRequired()
    vi.stubEnv('RIVETOS_COMPACTOR_TRANSIENT_STATUSES', '400,403')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = await import('./config.js')
    expect(config.llmTransientStatuses).toEqual([400, 403])
    expect(
      warn.mock.calls.some(
        (c) => String(c[0]).includes('400') && String(c[0]).includes('transient'),
      ),
    ).toBe(true)
    warn.mockRestore()
  })

  it('exits when a fallback names a key variable that is unset', async () => {
    stubRequired()
    vi.stubEnv('RIVETOS_COMPACTOR_FALLBACKS', 'https://or.test/v1|some-model|MISSING_KEY')
    delete process.env.MISSING_KEY
    const { error } = trapExit()
    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(logged(error)).toContain('MISSING_KEY')
  })

  it("reads each fallback's own transient codes from the fourth field", async () => {
    stubRequired()
    vi.stubEnv('RIVETOS_COMPACTOR_TRANSIENT_STATUSES', '403, 404')
    vi.stubEnv(
      'RIVETOS_COMPACTOR_FALLBACKS',
      'https://nv.test/v1|gemma||403;404,https://or.test/v1|oss',
    )
    const { config } = await import('./config.js')
    expect(config.llmTransientStatuses).toEqual([403, 404])
    expect(config.llmFallbacks.map((f) => f.transientStatuses)).toEqual([[403, 404], []])
  })

  it.each([
    ['RIVETOS_COMPACTOR_TRANSIENT_STATUSES', '403,503'],
    ['RIVETOS_COMPACTOR_TRANSIENT_STATUSES', '40x'],
    ['RIVETOS_COMPACTOR_FALLBACKS', 'https://nv.test/v1|gemma||403;500'],
    ['RIVETOS_COMPACTOR_FALLBACKS', 'https://nv.test/v1|gemma||403|extra'],
    ['RIVETOS_COMPACTOR_FALLBACKS', 'nv.test/v1|gemma'],
    ['RIVETOS_COMPACTOR_URL', 'ftp://llm.test/v1'],
    ['RIVETOS_COMPACTOR_FALLBACK_COOLDOWN_MINUTES', '0'],
    ['RIVETOS_COMPACTOR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS', '-5'],
  ])('exits on an invalid %s (%s)', async (name, value) => {
    stubRequired()
    vi.stubEnv(name, value)
    const { error } = trapExit()
    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(logged(error)).toContain(name)
  })
})
