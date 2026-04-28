/**
 * Boot — the composition root.
 *
 * Thin orchestrator: discovers plugins, loads config, calls registrars,
 * starts the runtime. All heavy lifting lives in the registrars.
 */

import { resolve, dirname } from 'node:path'
import { realpathSync } from 'node:fs'
import { Runtime } from '@rivetos/core'
import { logger } from '@rivetos/core'
import type { ThinkingLevel } from '@rivetos/types'

import { loadConfig } from './config.js'
import { discoverPlugins } from './discovery.js'
import { registerHooks } from './registrars/hooks.js'
import { registerPlugins } from './registrars/plugins.js'
import { registerAgentTools } from './registrars/agents.js'
import { writePidFile, registerShutdownHandlers } from './lifecycle.js'

// Re-export config types for consumers
export { loadConfig, type RivetConfig, ConfigValidationError } from './config.js'
export {
  validateConfig,
  formatValidationResult,
  type ValidationResult,
  type ValidationIssue,
  type Severity,
} from './validate/index.js'
export { discoverPlugins, type PluginRegistry, type DiscoveredPlugin } from './discovery.js'

const log = logger('Boot')

/**
 * Locate the directory plugin discovery should scan from.
 *
 * Two layouts to support:
 *
 *   1. Source checkout (dev):
 *      ROOT/nx.json
 *      ROOT/plugins/CATEGORY/PKG/package.json   - discovery target
 *      ROOT/packages/boot/dist/index.js         - this file at runtime
 *
 *   2. Global npm install:
 *      PREFIX/lib/node_modules/
 *        @rivetos/PKG/package.json              - discovery target (flat)
 *        @rivetos/boot/dist/index.js            - this file at runtime
 *
 * Strategy:
 *   1. Honor RIVETOS_ROOT if set
 *   2. Walk up from cwd looking for nx.json (dev)
 *   3. Walk up from this file's location looking for an @rivetos/
 *      directory under node_modules/ (npm install)
 *   4. Fall back to cwd
 *
 * The discovered path is opaque — the discovery layer probes both layouts
 * regardless. This function just gives discovery a sensible starting point.
 */
async function findPluginRoot(): Promise<string> {
  const { existsSync } = await import('node:fs')
  const fsRoot = resolve('/')

  // (1) Dev: walk up from cwd for nx.json
  let dir = process.cwd()
  while (dir !== fsRoot) {
    if (existsSync(resolve(dir, 'nx.json'))) {
      return dir
    }
    dir = dirname(dir)
  }

  // (2) Install: resolve from process.argv[1] (the entry script that started
  // us). For a global install via `npm install -g @rivetos/cli`, that path
  // is something like /usr/local/bin/rivetos → realpath →
  // /usr/lib/node_modules/@rivetos/cli/dist/index.js. The directory above
  // node_modules/ is the install root we want to scan.
  try {
    const entry = process.argv[1]
    if (entry) {
      let probe = dirname(realpathSync(entry))
      while (probe !== fsRoot) {
        if (probe.endsWith('/node_modules') && existsSync(resolve(probe, '@rivetos'))) {
          return dirname(probe)
        }
        probe = dirname(probe)
      }
    }
  } catch {
    // ignore — argv[1] missing or unreadable
  }

  log.warn('Could not find plugin root (no nx.json, no node_modules/@rivetos) — using cwd')
  return process.cwd()
}

export async function boot(configPath?: string): Promise<void> {
  configPath = configPath ?? resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  log.info(`Loading config from ${configPath}`)

  const config = await loadConfig(configPath)
  const workspaceDir = config.runtime.workspace.replace('~', process.env.HOME ?? '.')

  // 0. Discover plugins
  // Resolve plugin root: RIVETOS_ROOT env var → nx.json (dev) → node_modules/@rivetos (install) → cwd
  const pluginRoot = process.env.RIVETOS_ROOT ?? (await findPluginRoot())
  const registry = await discoverPlugins(pluginRoot, config.runtime.plugin_dirs)

  // 1. Hooks (must come before runtime — runtime receives the pipeline)
  const { pipeline, fallbackConfigs } = await registerHooks(config, workspaceDir)

  // 2. Runtime
  const runtime = new Runtime({
    workspaceDir,
    defaultAgent: config.runtime.default_agent,
    turnTimeout: config.runtime.turn_timeout,
    contextConfig: config.runtime.context
      ? {
          softNudgePct: config.runtime.context.soft_nudge_pct,
          hardNudgePct: config.runtime.context.hard_nudge_pct,
        }
      : undefined,
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      name: id,
      provider: agent.provider,
      model: agent.model,
      defaultThinking: (agent.default_thinking as ThinkingLevel | undefined) ?? 'medium',
      local: agent.local ?? false,
      tools: agent.tools,
    })),
    heartbeats: config.runtime.heartbeats,
    skillDirs: config.runtime.skill_dirs,
    hooks: pipeline,
    fallbacks: fallbackConfigs,
    configPath,
  })

  // 3. All discovered plugins (providers, channels, memory, tools) — each
  //    plugin owns its config resolution and lifecycle via its `manifest`.
  await registerPlugins(runtime, config, registry, pipeline, workspaceDir)

  // 4. Agent tools (delegation, sub-agents, skills) — after plugins so they can reference them
  await registerAgentTools(runtime, config, workspaceDir)

  // 5. Lifecycle
  await writePidFile()
  registerShutdownHandlers(runtime)

  // 6. Start
  await runtime.start()
}
