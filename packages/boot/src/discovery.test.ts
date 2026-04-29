/**
 * Discovery tests — covers production (explicit, fail-fast) and workspace
 * (scan + union) modes, scope-agnostic node_modules scan, and manifest
 * validation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPlugins } from './discovery.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rivetos-discovery-'))
  // Minimal package.json so createRequire(rootDir/package.json) works.
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'tmp-root', version: '0.0.0' }))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePkg(
  dir: string,
  name: string,
  rivetos: { type: string; name: string } | undefined,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: '0.0.0' }
  if (rivetos) pkg.rivetos = rivetos
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg))
}

describe('discoverPlugins — production mode', () => {
  it('loads exactly the explicit list when all resolvable', async () => {
    await writePkg(join(root, 'node_modules', '@rivetos', 'provider-anthropic'), '@rivetos/provider-anthropic', { type: 'provider', name: 'anthropic' })
    await writePkg(join(root, 'node_modules', '@rivetos', 'tool-shell'), '@rivetos/tool-shell', { type: 'tool', name: 'shell' })
    // An installed plugin not in the explicit list — must NOT be picked up.
    await writePkg(join(root, 'node_modules', '@rivetos', 'tool-file'), '@rivetos/tool-file', { type: 'tool', name: 'file' })

    const reg = await discoverPlugins(root, {
      mode: 'production',
      explicitPlugins: ['@rivetos/provider-anthropic', '@rivetos/tool-shell'],
    })

    expect(reg.plugins.map((p) => p.packageName).sort()).toEqual([
      '@rivetos/provider-anthropic',
      '@rivetos/tool-shell',
    ])
  })

  it('fails fast naming a missing package', async () => {
    await writePkg(join(root, 'node_modules', '@rivetos', 'tool-shell'), '@rivetos/tool-shell', { type: 'tool', name: 'shell' })

    await expect(
      discoverPlugins(root, {
        mode: 'production',
        explicitPlugins: ['@rivetos/tool-shell', '@rivetos/provider-openai-compat'],
      }),
    ).rejects.toThrow(/@rivetos\/provider-openai-compat/)
  })

  it('fails fast when a resolved package lacks a rivetos manifest', async () => {
    await writePkg(join(root, 'node_modules', 'plain-pkg'), 'plain-pkg', undefined)

    await expect(
      discoverPlugins(root, { mode: 'production', explicitPlugins: ['plain-pkg'] }),
    ).rejects.toThrow(/missing rivetos manifest/)
  })

  it('errors when explicit list is empty', async () => {
    await expect(discoverPlugins(root, { mode: 'production' })).rejects.toThrow(
      /No plugins configured/,
    )
  })

  it('accepts non-@rivetos scopes (no scope handcuff)', async () => {
    await writePkg(join(root, 'node_modules', 'acme-rivetos-thing'), 'acme-rivetos-thing', { type: 'tool', name: 'thing' })

    const reg = await discoverPlugins(root, {
      mode: 'production',
      explicitPlugins: ['acme-rivetos-thing'],
    })

    expect(reg.has('tool', 'thing')).toBe(true)
  })
})

describe('discoverPlugins — workspace mode', () => {
  it('scans plugins/<category>/* with no explicit list', async () => {
    await writePkg(join(root, 'plugins', 'providers', 'anthropic'), '@rivetos/provider-anthropic', { type: 'provider', name: 'anthropic' })
    await writePkg(join(root, 'plugins', 'tools', 'shell'), '@rivetos/tool-shell', { type: 'tool', name: 'shell' })

    const reg = await discoverPlugins(root, { mode: 'workspace' })

    expect(reg.has('provider', 'anthropic')).toBe(true)
    expect(reg.has('tool', 'shell')).toBe(true)
  })

  it('scans node_modules/* across any scope', async () => {
    await writePkg(join(root, 'node_modules', '@rivetos', 'provider-anthropic'), '@rivetos/provider-anthropic', { type: 'provider', name: 'anthropic' })
    await writePkg(join(root, 'node_modules', 'acme-rivetos-thing'), 'acme-rivetos-thing', { type: 'tool', name: 'thing' })
    // No marker — must not be discovered.
    await writePkg(join(root, 'node_modules', 'random-dep'), 'random-dep', undefined)

    const reg = await discoverPlugins(root, { mode: 'workspace' })

    expect(reg.has('provider', 'anthropic')).toBe(true)
    expect(reg.has('tool', 'thing')).toBe(true)
    expect(reg.plugins.find((p) => p.packageName === 'random-dep')).toBeUndefined()
  })

  it('unions explicit list with scans, deduped by package name', async () => {
    await writePkg(join(root, 'plugins', 'providers', 'anthropic'), '@rivetos/provider-anthropic', { type: 'provider', name: 'anthropic' })
    await writePkg(join(root, 'node_modules', '@rivetos', 'tool-shell'), '@rivetos/tool-shell', { type: 'tool', name: 'shell' })

    const reg = await discoverPlugins(root, {
      mode: 'workspace',
      // Explicit list overlaps with scans — must not duplicate.
      explicitPlugins: ['@rivetos/provider-anthropic', '@rivetos/tool-shell'],
    })

    expect(reg.plugins.map((p) => p.packageName).sort()).toEqual([
      '@rivetos/provider-anthropic',
      '@rivetos/tool-shell',
    ])
  })

  it('does not throw on missing explicit-list entries (warns instead)', async () => {
    await writePkg(join(root, 'plugins', 'tools', 'shell'), '@rivetos/tool-shell', { type: 'tool', name: 'shell' })

    const reg = await discoverPlugins(root, {
      mode: 'workspace',
      explicitPlugins: ['@rivetos/tool-shell', '@rivetos/never-installed'],
    })

    expect(reg.has('tool', 'shell')).toBe(true)
  })

  it('skips packages with invalid plugin types', async () => {
    await writePkg(join(root, 'node_modules', 'bogus'), 'bogus', { type: 'something-bogus', name: 'x' })

    const reg = await discoverPlugins(root, { mode: 'workspace' })

    expect(reg.plugins.length).toBe(0)
  })
})
