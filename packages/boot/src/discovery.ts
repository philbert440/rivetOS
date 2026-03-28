/**
 * Plugin Discovery — scans plugin directories for package.json files
 * with a `rivetos` manifest field. Builds a registry of available plugins
 * that boot can use instead of hardcoded switch statements.
 *
 * Each plugin declares itself in package.json:
 *   {
 *     "name": "@rivetos/provider-anthropic",
 *     "rivetos": {
 *       "type": "provider",
 *       "name": "anthropic"
 *     }
 *   }
 *
 * Discovery finds these, validates the manifest, and provides a registry
 * that maps (type, name) → package name for dynamic import.
 */

import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { PluginType, PluginManifest } from '@rivetos/types'
import { logger } from '@rivetos/core'

const log = logger('Boot:Discovery')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPlugin {
  /** npm package name (e.g. @rivetos/provider-anthropic) */
  packageName: string
  /** Plugin manifest from package.json */
  manifest: PluginManifest
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan plugin directories and build a registry.
 *
 * Default scan paths (relative to monorepo root):
 *   - plugins/providers/*
 *   - plugins/channels/*
 *   - plugins/tools/*
 *   - plugins/memory/*
 *
 * Also supports additional paths for user plugins.
 */
export async function discoverPlugins(
  rootDir: string,
  additionalPaths?: string[],
): Promise<PluginRegistry> {
  const discovered: DiscoveredPlugin[] = []

  // Default plugin directories
  const pluginCategories = ['providers', 'channels', 'tools', 'memory']
  const scanDirs: string[] = []

  for (const category of pluginCategories) {
    const categoryDir = resolve(rootDir, 'plugins', category)
    try {
      const entries = await readdir(categoryDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          scanDirs.push(join(categoryDir, entry.name))
        }
      }
    } catch {
      // Category directory doesn't exist — skip
    }
  }

  // Additional paths (user plugins, etc.)
  if (additionalPaths) {
    for (const p of additionalPaths) {
      scanDirs.push(resolve(rootDir, p))
    }
  }

  // Scan each directory for package.json with rivetos manifest
  for (const dir of scanDirs) {
    try {
      const pkgPath = join(dir, 'package.json')
      const raw = await readFile(pkgPath, 'utf-8')
      const pkg = JSON.parse(raw) as {
        name?: string
        rivetos?: Partial<PluginManifest>
      }

      if (!pkg.rivetos || !pkg.name) continue

      const manifest = pkg.rivetos

      // Validate manifest
      if (!manifest.type || !manifest.name) {
        log.warn(`Invalid rivetos manifest in ${pkgPath} — missing type or name`)
        continue
      }

      const validTypes: PluginType[] = ['provider', 'channel', 'tool', 'memory']
      if (!validTypes.includes(manifest.type)) {
        log.warn(`Invalid plugin type "${manifest.type}" in ${pkgPath}`)
        continue
      }

      discovered.push({
        packageName: pkg.name,
        manifest: manifest as PluginManifest,
        path: dir,
      })

      log.debug(`Discovered: ${manifest.type}/${manifest.name} → ${pkg.name}`)
    } catch {
      // No package.json or invalid JSON — skip
    }
  }

  log.info(
    `Discovered ${discovered.length} plugin(s): ` +
      `${discovered.filter((p) => p.manifest.type === 'provider').length} providers, ` +
      `${discovered.filter((p) => p.manifest.type === 'channel').length} channels, ` +
      `${discovered.filter((p) => p.manifest.type === 'tool').length} tools, ` +
      `${discovered.filter((p) => p.manifest.type === 'memory').length} memory`,
  )

  return createRegistry(discovered)
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function createRegistry(plugins: DiscoveredPlugin[]): PluginRegistry {
  const byTypeAndName = new Map<string, DiscoveredPlugin>()

  for (const plugin of plugins) {
    const key = `${plugin.manifest.type}:${plugin.manifest.name}`
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
      return plugins.filter((p) => p.manifest.type === type)
    },

    has(type: PluginType, name: string): boolean {
      return byTypeAndName.has(`${type}:${name}`)
    },
  }
}
