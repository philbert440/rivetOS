import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
  type?: string
  exports?: { '.'?: { require?: string; import?: string } }
  main?: string
}

describe('@rivetos/token-command package contract', () => {
  it('is not ESM-only so CJS workspaces (memory-postgres, llama-server, …) can import it', () => {
    // Leaf packages consumed by both ESM and CJS-compiled workspaces omit
    // "type":"module" (same shape as @rivetos/types / @rivetos/aisdk). With
    // module:Node16, "type":"module" makes dist ESM-only and breaks those
    // consumers with TS1479/TS1542.
    expect(pkg.type).not.toBe('module')
    expect(pkg.exports?.['.']?.require).toBe('./dist/index.js')
    expect(pkg.exports?.['.']?.import).toBe('./dist/index.js')
  })

  it('is listed in pipeline PACKAGES before its published dependents', () => {
    // check-publish-closure.mjs fails CI when a PACKAGES entry depends on a
    // leaf that is missing from the publish list.
    const yml = readFileSync(join(pkgRoot, '../../.github/workflows/pipeline.yml'), 'utf8')
    const start = yml.indexOf('PACKAGES=(')
    const end = yml.indexOf('\n          )', start)
    expect(start).toBeGreaterThan(-1)
    const block = yml.slice(start, end)
    expect(block).toContain('packages/token-command')
    const leaf = block.indexOf('packages/token-command')
    for (const dep of [
      'plugins/memory/postgres',
      'plugins/providers/anthropic',
      'plugins/providers/llama-server',
      'plugins/providers/vllm',
      'plugins/providers/xai',
    ]) {
      expect(block.indexOf(dep)).toBeGreaterThan(leaf)
    }
  })

  it('loads via require() when dist is built (CJS dual-consume smoke)', () => {
    const require = createRequire(join(pkgRoot, 'package.json'))
    let loaded: { createTokenSource?: unknown; normalizeEmbedVector?: unknown }
    try {
      loaded = require('@rivetos/token-command') as typeof loaded
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/Cannot find module|ENOENT/i.test(msg)) {
        // Fresh checkout before `npm run build` — package.json contract above
        // still pins the dual-consume shape.
        return
      }
      throw err
    }
    expect(typeof loaded.createTokenSource).toBe('function')
    expect(typeof loaded.normalizeEmbedVector).toBe('function')
  })
})
