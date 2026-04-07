/**
 * nx g @rivetos/nx:plugin --type=channel --name=slack
 *
 * Scaffolds a new plugin package under plugins/<type>s/<name>/
 * with package.json, tsconfig.json, src/index.ts, and optional tests.
 * Automatically wires into the npm workspace.
 */

import { Tree, formatFiles, generateFiles, joinPathFragments, logger } from '@nx/devkit'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface PluginGeneratorSchema {
  name: string
  type: 'channel' | 'provider' | 'tool'
  description?: string
  skipTests?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map plugin type to filesystem directory under plugins/ */
function pluginDir(type: string): string {
  const dirs: Record<string, string> = {
    channel: 'plugins/channels',
    provider: 'plugins/providers',
    tool: 'plugins/tools',
  }
  return dirs[type] ?? `plugins/${type}s`
}

/** Map plugin type to npm package name prefix */
function packagePrefix(type: string): string {
  const prefixes: Record<string, string> = {
    channel: 'channel',
    provider: 'provider',
    tool: 'tool',
  }
  return prefixes[type] ?? type
}

/** PascalCase from kebab-case */
function toPascalCase(str: string): string {
  return str
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
}

/** Compute the relative path from plugin to workspace root (for tsconfig extends) */
function relativeToRoot(projectRoot: string): string {
  const depth = projectRoot.split('/').length
  return Array(depth).fill('..').join('/')
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export async function pluginGenerator(tree: Tree, schema: PluginGeneratorSchema): Promise<void> {
  const { name, type, description, skipTests } = schema
  const projectRoot = joinPathFragments(pluginDir(type), name)
  const packageName = `@rivetos/${packagePrefix(type)}-${name}`
  const className = `${toPascalCase(name)}${toPascalCase(type)}`
  const relRoot = relativeToRoot(projectRoot)

  logger.info(`\n🔧 Scaffolding ${packageName} at ${projectRoot}/\n`)

  // Check it doesn't already exist
  if (tree.exists(joinPathFragments(projectRoot, 'package.json'))) {
    throw new Error(`Plugin already exists at ${projectRoot}/`)
  }

  // Generate files from templates
  generateFiles(tree, path.join(__dirname, 'files', type), projectRoot, {
    name,
    packageName,
    className,
    description: description ?? `${toPascalCase(name)} ${type} plugin for RivetOS`,
    relRoot,
    skipTests: skipTests ?? false,
    tmpl: '', // used to strip .template extension
  })

  // Remove test files if --skipTests
  if (skipTests) {
    const testPath = joinPathFragments(projectRoot, 'src', 'index.test.ts')
    if (tree.exists(testPath)) {
      tree.delete(testPath)
    }
  }

  // Update root package.json workspaces if the plugin dir isn't already covered
  // (our workspace globs already cover plugins/channels/*, plugins/providers/*, plugins/tools/*)
  // So we just need to make sure it matches — no update needed for standard types.

  await formatFiles(tree)

  logger.info(`✅ Created ${packageName}`)
  logger.info(``)
  logger.info(`   ${projectRoot}/`)
  logger.info(`   ├── package.json`)
  logger.info(`   ├── tsconfig.json`)
  logger.info(`   ├── src/index.ts         ${type} implementation`)
  if (!skipTests) {
    logger.info(`   └── src/index.test.ts    tests`)
  }
  logger.info(``)
  logger.info(`Next steps:`)
  logger.info(`   1. npm install`)
  logger.info(`   2. Implement the ${type} in src/index.ts`)
  logger.info(`   3. Wire into boot (packages/boot/src/registrars/${type}s.ts)`)
  logger.info(`   4. nx run ${packagePrefix(type)}-${name}:build`)
  logger.info(`   5. nx run ${packagePrefix(type)}-${name}:test`)
  logger.info(``)
}

export default pluginGenerator
