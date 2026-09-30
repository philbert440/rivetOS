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
    const { config } = await import('./config.js')
    expect(config.llmFallbacks).toEqual([
      { url: 'https://nv.test/v1', model: 'google/gemma-4-31b-it', apiKey: '' },
      { url: 'https://or.test/api/v1', model: 'openai/gpt-oss-120b', apiKey: 'or-secret' },
    ])
    expect(config.llmFallbackCooldownMs).toBe(300_000)
  })

  it('exits when a fallback names a key variable that is unset', async () => {
    stubRequired()
    vi.stubEnv('RIVETOS_COMPACTOR_FALLBACKS', 'https://or.test/v1|some-model|MISSING_KEY')
    delete process.env.MISSING_KEY
    const { error } = trapExit()
    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(logged(error)).toContain('MISSING_KEY')
  })
})
