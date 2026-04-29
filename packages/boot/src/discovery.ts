/**
 * Plugin Discovery — finds plugins by reading their `package.json#rivetos`
 * manifest. Two modes:
 *
 *   workspace mode  — running from a source checkout. Scans
 *     `<root>/plugins/<category>/*` and `<root>/node_modules/**` for any
 *     package whose `package.json` declares a `rivetos` block. Honors an
 *     explicit `config.plugins` list additively (union, deduped by package
 *     name). Drop a plugin in, it works.
 *
 *   production mode — flat npm install, no workspace. `config.plugins` is
 *     authoritative: each entry is resolved via npm resolution from rootDir,
 *     its `package.json#rivetos` manifest is read, and missing/invalid
 *     entries fail-fast with a clear error.
 *
 * Each plugin declares itself in package.json:
 *   {
 *     "name": "@rivetos/provider-anthropic",
 *     "rivetos": { "type": "provider", "name": "anthropic" }
 *   }
 *
 * No package-name scope is hardcoded — `acme-rivetos-thing` works the same
 * as `@rivetos/provider-anthropic` so long as the manifest is present.
 */

import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import type { PluginType, PluginDescriptor } from '@rivetos/types'
import { logger } from '@rivetos/core'

const log = logger('Boot:Discovery')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPlugin {
  /** npm package name (e.g. @rivetos/provider-anthropic) */
  packageName: string
  /** Static descriptor read from `package.json#rivetos` */
  descriptor: PluginDescriptor
  /** Absolute path to the plugin directory */
  path: string
}

export interface PluginRegistry {
  /** All discovered plugins */
  plugins: DiscoveredPlugin[]
  /** Get a plugin by type and name */
  get(type: PluginType, name: string): DiscoveredPlugin | undefined
  /** Get all plugins of a given type */
  getByType(type: PluginType): DiscoveredPlugin[]
  /** Check if a plugin exists */
  has(type: PluginType, name: string): boolean
}

export type DiscoveryMode = 'workspace' | 'production'

export interface DiscoverOptions {
  /**
   * 'workspace' = source checkout (scan-based, additive with explicit list).
   * 'production' = flat install (explicit list authoritative, fail-fast on missing).
   */
  mode: DiscoveryMode
  /**
   * Explicit plugin package names from `config.plugins`. In production this
   * is authoritative. In workspace mode it's additive on top of scans.
   */
  explicitPlugins?: string[]
  /**
   * Extra directories to scan in workspace mode (legacy `runtime.plugin_dirs`).
   * Resolved relative to `rootDir`. Ignored in production.
   */
  additionalPaths?: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PLUGIN_TYPES: ReadonlySet<PluginType> = new Set([
  'provider',
  'channel',
  'tool',
  'memory',
  'transport',
])

/**
 * Read a package.json and extract its rivetos manifest if present.
 * Returns null when the file is missing, unparseable, or has no manifest.
 */
async function readManifest(
  pkgDir: string,
): Promise<{ packageName: string; descriptor: PluginDescriptor; path: string } | null> {
  try {
    const raw = await readFile(join(pkgDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as {
      name?: string
      rivetos?: Partial<PluginDescriptor>
    }

    if (!pkg.rivetos || !pkg.name) return null

    const descriptor = pkg.rivetos
    if (!descriptor.type || !descriptor.name) {
      log.warn(`Invalid rivetos descriptor in ${pkgDir}/package.json — missing type or name`)
      return null
    }
    if (!VALID_PLUGIN_TYPES.has(descriptor.type)) {
      log.warn(`Invalid plugin type "${descriptor.type}" in ${pkgDir}/package.json`)
      return null
    }

    return {
      packageName: pkg.name,
      descriptor: descriptor as PluginDescriptor,
      path: pkgDir,
    }
  } catch {
    return null
  }
}

/**
 * Enumerate plugin directories under `<rootDir>/plugins/<category>/*`.
 * Used in workspace mode only.
 */
async function listWorkspacePluginDirs(rootDir: string): Promise<string[]> {
  const categories = ['providers', 'channels', 'tools', 'memory', 'transports']
  const out: string[] = []
  for (const category of categories) {
    const categoryDir = resolve(rootDir, 'plugins', category)
    try {
      const entries = await readdir(categoryDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          out.push(join(categoryDir, entry.name))
        }
      }
    } catch {
      // category absent — fine
    }
  }
  return out
}

/**
 * Enumerate every package directory inside `<rootDir>/node_modules/`,
 * including scoped packages (`@scope/pkg`). No scope is hardcoded.
 */
async function listNodeModulesPkgDirs(rootDir: string): Promise<string[]> {
  const nm = resolve(rootDir, 'node_modules')
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(nm, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      try {
        const scoped = await readdir(join(nm, entry.name), { withFileTypes: true })
        for (const inner of scoped) {
          if (inner.isDirectory() && !inner.name.startsWith('.')) {
            out.push(join(nm, entry.name, inner.name))
          }
        }
      } catch {
        // unreadable scope — skip
      }
    } else {
      out.push(join(nm, entry.name))
    }
  }
  return out
}

/**
 * Resolve an installed package's directory by name, anchored at rootDir.
 * Uses node module resolution, so symlinked workspace packages work too.
 */
function resolvePackageDir(packageName: string, rootDir: string): string | null {
  try {
    const req = createRequire(join(rootDir, 'package.json'))
    const pkgJsonPath = req.resolve(`${packageName}/package.json`)
    return dirname(pkgJsonPath)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover plugins. See module doc for mode semantics.
 *
 * In production mode, throws if any explicit plugin can't be resolved or
 * lacks a valid rivetos manifest — boot must not silently miss what config
 * says it needs.
 */
export async function discoverPlugins(
  rootDir: string,
  options: DiscoverOptions,
): Promise<PluginRegistry> {
  const { mode, explicitPlugins = [], additionalPaths = [] } = options

  const seen = new Set<string>()
  const discovered: DiscoveredPlugin[] = []

  const recordDir = async (dir: string): Promise<DiscoveredPlugin | null> => {
    const m = await readManifest(dir)
    if (!m) return null
    if (seen.has(m.packageName)) return null
    seen.add(m.packageName)
    discovered.push(m)
    log.debug(`Discovered: ${m.descriptor.type}/${m.descriptor.name} → ${m.packageName}`)
    return m
  }

  if (mode === 'production') {
    if (explicitPlugins.length === 0) {
      throw new Error(
        'No plugins configured. Production deployments require an explicit ' +
          '`plugins:` list in config (no workspace scan available).',
      )
    }
    const missing: string[] = []
    const invalid: string[] = []
    for (const name of explicitPlugins) {
      const pkgDir = resolvePackageDir(name, rootDir)
      if (!pkgDir) {
        missing.push(name)
        continue
      }
      const got = await recordDir(pkgDir)
      if (!got) invalid.push(name)
    }
    if (missing.length > 0 || invalid.length > 0) {
      const parts: string[] = []
      if (missing.length > 0) {
        parts.push(
          `cannot resolve: ${missing.map((m) => `"${m}"`).join(', ')} ` +
            `(not installed under ${resolve(rootDir, 'node_modules')})`,
        )
      }
      if (invalid.length > 0) {
        parts.push(
          `missing rivetos manifest: ${invalid.map((m) => `"${m}"`).join(', ')} ` +
            `(package.json must declare a "rivetos" block with type and name)`,
        )
      }
      throw new Error(`Plugin resolution failed — ${parts.join('; ')}`)
    }
  } else {
    // Workspace mode: union of monorepo, node_modules (any scope), additional
    // paths, and the explicit list.
    for (const dir of await listWorkspacePluginDirs(rootDir)) {
      await recordDir(dir)
    }
    for (const dir of await listNodeModulesPkgDirs(rootDir)) {
      await recordDir(dir)
    }
    for (const p of additionalPaths) {
      await recordDir(resolve(rootDir, p))
    }
    for (const name of explicitPlugins) {
      if (seen.has(name)) continue
      const pkgDir = resolvePackageDir(name, rootDir)
      if (!pkgDir) {
        log.warn(
          `config.plugins entry "${name}" not resolvable from ${rootDir} ` +
            `— skipping in workspace mode`,
        )
        continue
      }
      const got = await recordDir(pkgDir)
      if (!got) {
        log.warn(
          `config.plugins entry "${name}" resolved to ${pkgDir} but has no ` +
            `rivetos manifest — skipping`,
        )
      }
    }
  }

  log.info(
    `Discovered ${discovered.length} plugin(s) [${mode} mode]: ` +
      `${discovered.filter((p) => p.descriptor.type === 'provider').length} providers, ` +
      `${discovered.filter((p) => p.descriptor.type === 'channel').length} channels, ` +
      `${discovered.filter((p) => p.descriptor.type === 'tool').length} tools, ` +
      `${discovered.filter((p) => p.descriptor.type === 'memory').length} memory, ` +
      `${discovered.filter((p) => p.descriptor.type === 'transport').length} transport`,
  )

  return createRegistry(discovered)
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function createRegistry(plugins: DiscoveredPlugin[]): PluginRegistry {
  const byTypeAndName = new Map<string, DiscoveredPlugin>()

  for (const plugin of plugins) {
    const key = `${plugin.descriptor.type}:${plugin.descriptor.name}`
    if (byTypeAndName.has(key)) {
      log.warn(
        `Duplicate plugin ${key}: ${plugin.packageName} conflicts with ${byTypeAndName.get(key)!.packageName}`,
      )
    }
    byTypeAndName.set(key, plugin)
  }

  return {
    plugins,

    get(type: PluginType, name: string): DiscoveredPlugin | undefined {
      return byTypeAndName.get(`${type}:${name}`)
    },

    getByType(type: PluginType): DiscoveredPlugin[] {
      return plugins.filter((p) => p.descriptor.type === type)
    },

    has(type: PluginType, name: string): boolean {
      return byTypeAndName.has(`${type}:${name}`)
    },
  }
}
