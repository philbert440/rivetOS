import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const boot = vi.hoisted(() => {
  function expandEnvVars<T>(obj: T): T {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{(\w+)\}/g, (_: string, name: string) => process.env[name] ?? '') as T
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => expandEnvVars(item)) as T
    }
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(obj)) {
        result[key] = expandEnvVars(value)
      }
      return result as T
    }
    return obj
  }
  return {
    loadConfig: vi.fn(),
    resolveEmbeddedPg: vi.fn(),
    acquireEmbeddedPg: vi.fn(),
    applyEmbeddedPgUrl: vi.fn(),
    resolveEnvVars: expandEnvVars,
  }
})

vi.mock('@rivetos/boot', () => boot)

import { readEmbeddedConfig } from './embedded.js'

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rivet-embedded-test-'))
const ORIG_HOME = process.env.RIVET_TEST_HOME

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.RIVET_TEST_HOME
  else process.env.RIVET_TEST_HOME = ORIG_HOME
  boot.resolveEmbeddedPg.mockReset()
})

describe('readEmbeddedConfig', () => {
  it("expands data_dir: '${RIVET_TEST_HOME}/pglite' before resolveEmbeddedPg", () => {
    process.env.RIVET_TEST_HOME = '/tmp/rivet-test-home'
    const path = join(CONFIG_DIR, 'config.yaml')
    writeFileSync(
      path,
      "memory:\n  postgres:\n    embedded:\n      data_dir: '${RIVET_TEST_HOME}/pglite'\n",
    )
    const resolved = {
      dataDir: '/tmp/rivet-test-home/pglite',
      port: 5433,
      autoMigrate: true,
      maxConnections: 96,
      pgUrl: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
      liteMode: true,
    }
    boot.resolveEmbeddedPg.mockReturnValue(resolved)

    const result = readEmbeddedConfig(path)

    expect(result?.config).toEqual({
      memory: { postgres: { embedded: { data_dir: '/tmp/rivet-test-home/pglite' } } },
    })
    expect(boot.resolveEmbeddedPg).toHaveBeenCalledWith({
      memory: { postgres: { embedded: { data_dir: '/tmp/rivet-test-home/pglite' } } },
    })
    expect(result?.resolved).toBe(resolved)
  })

  it('throws a clear error when embedded.port is not an integer', () => {
    const path = join(CONFIG_DIR, 'bad-port.yaml')
    writeFileSync(path, 'memory:\n  postgres:\n    embedded: { port: "abc" }\n')

    expect(() => readEmbeddedConfig(path)).toThrow(
      /memory\.postgres\.embedded\.port must be an integer between 1 and 65535/,
    )
    expect(boot.resolveEmbeddedPg).not.toHaveBeenCalled()
  })
})
