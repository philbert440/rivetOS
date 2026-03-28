/**
 * Boot — the composition root.
 *
 * Thin orchestrator: discovers plugins, loads config, calls registrars,
 * starts the runtime. All heavy lifting lives in the registrars.
 */

import { resolve, dirname } from 'node:path'
import { Runtime } from '@rivetos/core'
import { logger } from '@rivetos/core'
import type { HeartbeatConfig, ThinkingLevel } from '@rivetos/types'

import { loadConfig } from './config.js'
import { discoverPlugins } from './discovery.js'
import { registerHooks } from './registrars/hooks.js'
import { registerProviders } from './registrars/providers.js'
import { registerChannels } from './registrars/channels.js'
import { registerTools } from './registrars/tools.js'
import { registerAgentTools } from './registrars/agents.js'
import { registerMemory } from './registrars/memory.js'
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
 * Walk up from cwd to find the monorepo root (contains nx.json).
 */
async function findMonorepoRoot(): Promise<string> {
  const { existsSync } = await import('node:fs')

  let dir = process.cwd()
  const root = resolve('/')

  while (dir !== root) {
    if (existsSync(resolve(dir, 'nx.json'))) {
      return dir
    }
    dir = dirname(dir)
  }

  // Fallback to cwd
  log.warn('Could not find monorepo root (nx.json) — using cwd')
  return process.cwd()
}

export async function boot(configPath?: string): Promise<void> {
  configPath = configPath ?? resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  log.info(`Loading config from ${configPath}`)

  const config = await loadConfig(configPath)
  const workspaceDir = config.runtime.workspace.replace('~', process.env.HOME ?? '.')

  // 0. Discover plugins
  // Resolve monorepo root: RIVETOS_ROOT env var → walk up from this file to find nx.json
  const monorepoRoot = process.env.RIVETOS_ROOT ?? (await findMonorepoRoot())
  const registry = await discoverPlugins(monorepoRoot, config.runtime.plugin_dirs)

  // 1. Hooks (must come before runtime — runtime receives the pipeline)
  const { pipeline, fallbackConfigs } = await registerHooks(config, workspaceDir)

  // 2. Runtime
  const runtime = new Runtime({
    workspaceDir,
    defaultAgent: config.runtime.default_agent,
    maxToolIterations: config.runtime.max_tool_iterations,
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      name: id,
      provider: agent.provider,
      defaultThinking: (agent.default_thinking as ThinkingLevel | undefined) ?? 'medium',
      local: agent.local ?? false,
      tools: agent.tools,
    })),
    heartbeats: config.runtime.heartbeats as HeartbeatConfig[],
    skillDirs: config.runtime.skill_dirs,
    hooks: pipeline,
    fallbacks: fallbackConfigs,
    configPath,
  })

  // 3. Providers, channels, memory, tools (order doesn't matter between these)
  await registerProviders(runtime, config, registry)
  await registerChannels(runtime, config, registry)
  await registerMemory(runtime, config, pipeline)
  await registerTools(runtime, config, workspaceDir, registry)

  // 4. Agent tools (delegation, sub-agents, skills) — after tools so they can reference them
  await registerAgentTools(runtime, config, workspaceDir)

  // 5. Lifecycle
  await writePidFile()
  registerShutdownHandlers(runtime)

  // 6. Start
  await runtime.start()
}
