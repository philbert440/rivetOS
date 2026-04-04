/**
 * Boot — the composition root.
 *
 * Thin orchestrator: loads config, calls registrars, starts the runtime.
 * All heavy lifting lives in the registrars.
 */

import { resolve } from 'node:path';
import { Runtime } from '@rivetos/core';
import { logger } from '@rivetos/core';
import type { HeartbeatConfig, ThinkingLevel } from '@rivetos/types';

import { loadConfig } from './config.js';
import { registerHooks } from './registrars/hooks.js';
import { registerProviders } from './registrars/providers.js';
import { registerChannels } from './registrars/channels.js';
import { registerTools } from './registrars/tools.js';
import { registerMemory } from './registrars/memory.js';
import { writePidFile, registerShutdownHandlers } from './lifecycle.js';

// Re-export config types for consumers
export { loadConfig, type RivetConfig, ConfigValidationError } from './config.js';

const log = logger('Boot');

export async function boot(configPath?: string): Promise<void> {
  configPath = configPath ?? resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml');
  log.info(`Loading config from ${configPath}`);

  const config = await loadConfig(configPath);
  const workspaceDir = config.runtime.workspace.replace('~', process.env.HOME ?? '.');

  // 1. Hooks (must come before runtime — runtime receives the pipeline)
  const { pipeline, fallbackConfigs } = await registerHooks(config, workspaceDir);

  // 2. Runtime
  const runtime = new Runtime({
    workspaceDir,
    defaultAgent: config.runtime.default_agent,
    maxToolIterations: config.runtime.max_tool_iterations,
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      name: id,
      provider: agent.provider,
      defaultThinking: (agent.default_thinking as ThinkingLevel) ?? 'medium',
    })),
    heartbeats: config.runtime.heartbeats as HeartbeatConfig[],
    skillDirs: config.runtime.skill_dirs,
    hooks: pipeline,
    fallbacks: fallbackConfigs,
  });

  // 3. Providers, channels, memory, tools (order doesn't matter between these)
  await registerProviders(runtime, config);
  await registerChannels(runtime, config);
  await registerMemory(runtime, config);
  await registerTools(runtime, config, workspaceDir);

  // 4. Lifecycle
  await writePidFile();
  registerShutdownHandlers(runtime);

  // 5. Start
  await runtime.start();
}

// Direct execution support: npx tsx packages/boot/src/index.ts [config]
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  boot(process.argv[2]).catch((err) => {
    console.error('[RivetOS] [ERROR] [Boot] Fatal:', err);
    process.exit(1);
  });
}
