/**
 * Plugin Registrar — generic, manifest-driven plugin loader.
 *
 * Walks the discovered plugin registry, dynamic-imports each package, reads
 * its `manifest` export, and calls `manifest.register(ctx)`. The plugin owns
 * its config resolution, env-var lookup, constructor args, and shutdown
 * wiring. Boot has no per-plugin knowledge.
 *
 * Replaces the old per-kind registrars (providers/channels/tools/memory).
 */

import type { Runtime } from '@rivetos/core'
import type {
  PluginManifest,
  RegistrationContext,
  HookPipeline,
  HookContext,
  HookRegistration,
  Tool,
} from '@rivetos/types'
import type { RivetConfig } from '../config.js'
import type { PluginRegistry, DiscoveredPlugin } from '../discovery.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Plugins')

/**
 * Pick the per-plugin config slice based on the plugin's kind. Returns
 * undefined when the plugin should not be registered (e.g. a provider
 * package is installed but the user hasn't configured it).
 *
 * Tools are always registered (they decide internally whether their config
 * is sufficient — see mcp-client skipping when no servers, etc.).
 */
function pluginConfigFor(
  plugin: DiscoveredPlugin,
  config: RivetConfig,
): { register: boolean; slice: Record<string, unknown> | undefined } {
  const { type, name } = plugin.descriptor

  switch (type) {
    case 'provider': {
      const slice = config.providers[name] as Record<string, unknown> | undefined
      return { register: slice !== undefined, slice }
    }
    case 'channel': {
      // Legacy alias: voice-discord plugin matches a config key of either
      // `voice-discord` or `voice`.
      const slice = (config.channels[name] ??
        (name === 'voice-discord' ? config.channels.voice : undefined)) as
        | Record<string, unknown>
        | undefined
      return { register: slice !== undefined, slice }
    }
    case 'memory': {
      const slice = config.memory?.[name]
      return { register: slice !== undefined, slice }
    }
    case 'tool':
      return { register: true, slice: undefined }
    case 'transport':
      return { register: false, slice: undefined }
    default:
      return { register: false, slice: undefined }
  }
}

export async function registerPlugins(
  runtime: Runtime,
  config: RivetConfig,
  registry: PluginRegistry,
  hooks: HookPipeline,
  workspaceDir: string,
): Promise<void> {
  const shutdowns: Array<() => Promise<void> | void> = []

  for (const plugin of registry.plugins) {
    const { register, slice } = pluginConfigFor(plugin, config)
    if (!register) continue

    try {
      const mod = (await import(plugin.packageName)) as { manifest?: PluginManifest }
      const manifest = mod.manifest

      if (!manifest) {
        log.warn(`Plugin ${plugin.packageName} has no \`manifest\` export — skipped`)
        continue
      }

      if (manifest.type !== plugin.descriptor.type || manifest.name !== plugin.descriptor.name) {
        log.warn(
          `Plugin ${plugin.packageName} manifest (${manifest.type}/${manifest.name}) ` +
            `does not match descriptor (${plugin.descriptor.type}/${plugin.descriptor.name})`,
        )
      }

      const pluginLog = logger(`Plugin:${manifest.name}`)
      const ctx: RegistrationContext = {
        config,
        pluginConfig: slice,
        env: process.env,
        workspaceDir,
        logger: pluginLog,
        registerProvider: (p) => runtime.registerProvider(p),
        registerChannel: (c) => runtime.registerChannel(c),
        registerTool: (t) => runtime.registerTool(t),
        registerMemory: (m) => runtime.registerMemory(m),
        registerHook: <T extends HookContext>(h: HookRegistration<T>) => hooks.register(h),
        registerShutdown: (fn) => shutdowns.push(fn),
        lateBindTool:
          (toolName: string) =>
          async (args: Record<string, unknown>): Promise<string> => {
            const tool = runtime.getTools().find((t: Tool) => t.name === toolName)
            if (!tool) return `Tool "${toolName}" not available`
            const result = await tool.execute(args)
            return typeof result === 'string' ? result : JSON.stringify(result)
          },
      }

      await manifest.register(ctx)
      log.debug(`Registered ${manifest.type}: ${manifest.name} (${plugin.packageName})`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Failed to register plugin ${plugin.packageName}: ${message}`)
    }
  }

  // Chain plugin-registered shutdowns into runtime.stop once.
  if (shutdowns.length > 0) {
    const origStop = runtime.stop.bind(runtime)
    runtime.stop = async () => {
      for (const fn of shutdowns) {
        try {
          await fn()
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn(`Plugin shutdown error: ${message}`)
        }
      }
      await origStop()
    }
  }
}
