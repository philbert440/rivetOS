/**
 * Fail-loudly config: RIVETOS_EMBED_MODEL is required alongside the URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REQUIRED = {
  RIVETOS_PG_URL: 'postgres://rivet@localhost/test',
  RIVETOS_EMBED_URL: 'http://127.0.0.1:9401',
  RIVETOS_EMBED_MODEL: 'text-embedding-3-small',
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

describe('embedding-worker config', () => {
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
    expect(config.embedModel).toBe('text-embedding-3-small')
    expect(config.embedUrl).toBe('http://127.0.0.1:9401')
  })

  it('exits when RIVETOS_EMBED_MODEL is missing with URL set', async () => {
    stubRequired({ RIVETOS_EMBED_MODEL: '' })
    const { exit, error } = trapExit()

    await expect(import('./config.js')).rejects.toThrow(/process\.exit:1/)
    expect(exit).toHaveBeenCalledWith(1)
    const msg = logged(error)
    expect(msg).toContain('RIVETOS_EMBED_MODEL')
    expect(msg).toMatch(/text-embedding-3-small/)
  })
})
