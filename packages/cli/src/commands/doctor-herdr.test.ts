import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkHerdr } from './doctor.js'
import { HERDR_VERSION, herdrManifestCacheDir } from '../lib/herdr.js'

const MANIFEST = 'id = "grok"\nversion = "2099.01.01.1"\n'

describe('checkHerdr', () => {
  let home: string
  let repoManifestsDir: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'herdr-doctor-home-'))
    repoManifestsDir = join(mkdtempSync(join(tmpdir(), 'herdr-doctor-repo-')), 'manifests')
    mkdirSync(repoManifestsDir, { recursive: true })
    writeFileSync(join(repoManifestsDir, 'grok.toml'), MANIFEST)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(join(repoManifestsDir, '..'), { recursive: true, force: true })
  })

  function probe(version: string | null, env: NodeJS.ProcessEnv = {}) {
    return {
      home,
      repoManifestsDir,
      versionOf: () => version,
      env,
    }
  }

  function makeBinary(): void {
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'herdr'), '#!/bin/sh\n')
  }

  function installManifest(content: string): void {
    const cache = herdrManifestCacheDir(home)
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'grok.toml'), content)
  }

  it('passes quietly when herdr is absent and the node has not opted in', () => {
    const results = checkHerdr(null, probe(null))
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/not installed/)
  })

  it('warns (not fails) when term.mux=herdr but the binary is missing', () => {
    const results = checkHerdr(null, probe(null, { RIVETOS_DEN_TERM_MUX: 'herdr' }))
    const binary = results.find((r) => r.name === 'herdr')!
    expect(binary.status).toBe('warn')
    expect(binary.message).toMatch(/term\.mux=herdr/)
    expect(results.every((r) => r.status !== 'fail')).toBe(true)
  })

  it('reports binary, current manifests, and the mux value when provisioned', () => {
    makeBinary()
    installManifest(MANIFEST)
    const results = checkHerdr(null, probe(HERDR_VERSION, { RIVETOS_DEN_TERM_MUX: 'herdr' }))
    expect(results.find((r) => r.name === 'herdr')?.status).toBe('pass')
    expect(results.find((r) => r.name === 'herdr')?.message).toContain(HERDR_VERSION)
    expect(results.find((r) => r.name === 'herdr-manifests')?.status).toBe('pass')
    expect(results.find((r) => r.name === 'herdr-mux')?.message).toContain('herdr')
  })

  it('warns on the wrong version and on a stale manifest override', () => {
    makeBinary()
    installManifest('id = "grok"\nversion = "1.0.0"\n')
    const results = checkHerdr(null, probe('0.8.1'))
    expect(results.find((r) => r.name === 'herdr')?.status).toBe('warn')
    expect(results.find((r) => r.name === 'herdr')?.message).toMatch(/0\.8\.1/)
    const manifests = results.find((r) => r.name === 'herdr-manifests')!
    expect(manifests.status).toBe('warn')
    expect(manifests.message).toMatch(/grok\.toml/)
  })

  it('reads term.mux from YAML when the env var is unset', () => {
    makeBinary()
    installManifest(MANIFEST)
    const yaml = 'den:\n  terminal:\n    mux: herdr\n'
    const results = checkHerdr(yaml, probe(HERDR_VERSION, {}))
    expect(results.find((r) => r.name === 'herdr-mux')?.message).toContain('herdr')
  })
})
