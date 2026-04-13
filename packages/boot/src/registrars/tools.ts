/**
 * Tool Registrar — dynamically loads and registers tools using the
 * plugin discovery system.
 *
 * All tool plugins now export a standard `createPlugin()` factory that
 * returns a ToolPlugin with `getTools()`. Discovery finds them via
 * the `rivetos` field in their package.json.
 *
 * Special handling:
 *   - web-search: needs Google CSE config from env
 *   - mcp-client: needs async init (server connections)
 *   - coding-pipeline: needs late-bound tool executors from runtime
 *   - shell: needs workspace dir for cwd
 */

import type { Runtime } from '@rivetos/core'
import type { Tool, ToolPlugin } from '@rivetos/types'
import type { RivetConfig } from '../config.js'
import type { PluginRegistry } from '../discovery.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Tools')

export async function registerTools(
  runtime: Runtime,
  config: RivetConfig,
  workspaceDir: string,
  registry: PluginRegistry,
): Promise<void> {
  const discovered = registry.getByType('tool')

  for (const plugin of discovered) {
    const name = plugin.manifest.name

    try {
      const mod = (await import(plugin.packageName)) as Record<string, unknown>
      const createPlugin = mod.createPlugin as ((...args: unknown[]) => ToolPlugin) | undefined

      if (!createPlugin) {
        log.warn(`Plugin ${plugin.packageName} has no createPlugin() export — skipped`)
        continue
      }

      let toolPlugin: ToolPlugin

      // Plugin-specific config
      switch (name) {
        case 'shell':
          toolPlugin = createPlugin({ cwd: workspaceDir })
          break

        case 'web-search':
          toolPlugin = createPlugin({
            googleApiKey: process.env.GOOGLE_CSE_API_KEY ?? process.env.GOOGLE_API_KEY,
            googleCseId: process.env.GOOGLE_CSE_ID,
          })
          break

        case 'mcp-client': {
          if (!config.mcp?.servers || Object.keys(config.mcp.servers).length === 0) continue
          toolPlugin = createPlugin({ servers: config.mcp.servers })
          // MCP needs async init to connect to servers
          await toolPlugin.init({})
          break
        }

        case 'coding-pipeline': {
          const pipelineCfg = config.runtime.coding_pipeline
          toolPlugin = createPlugin({
            builderAgent: pipelineCfg?.builder_agent ?? 'grok',
            validatorAgent: pipelineCfg?.validator_agent ?? 'opus',
            maxBuildLoops: pipelineCfg?.max_build_loops ?? 3,
            maxValidationLoops: pipelineCfg?.max_validation_loops ?? 2,
            workingDir: workspaceDir,
            autoCommit: pipelineCfg?.auto_commit ?? true,
          })

          // Wire up late-bound tool executors
          const pluginWithPipeline = toolPlugin as ToolPlugin & {
            pipeline?: {
              setToolExecutors: (
                executors: Record<string, (args: Record<string, unknown>) => Promise<string>>,
              ) => void
            }
          }
          if (pluginWithPipeline.pipeline) {
            const lateBind = (
              toolName: string,
            ): ((args: Record<string, unknown>) => Promise<string>) => {
              return async (args: Record<string, unknown>) => {
                const tool = runtime.getTools().find((t: Tool) => t.name === toolName)
                if (!tool) return `Tool "${toolName}" not available`
                const result = await tool.execute(args)
                return typeof result === 'string' ? result : JSON.stringify(result)
              }
            }
            pluginWithPipeline.pipeline.setToolExecutors({
              delegateTask: lateBind('delegate_task'),
              shellExec: lateBind('shell'),
            })
          }
          break
        }

        default:
          // Standard tool plugins — no special config needed
          toolPlugin = createPlugin()
      }

      // Register all tools from the plugin
      const tools = toolPlugin.getTools()
      for (const tool of tools) {
        runtime.registerTool(tool)
      }

      // MCP-specific: register shutdown handler
      if (name === 'mcp-client' && toolPlugin.shutdown) {
        const origStop = runtime.stop.bind(runtime)
        runtime.stop = async () => {
          await toolPlugin.shutdown!()
          await origStop()
        }
      }

      if (tools.length > 0) {
        log.debug(
          `Registered ${tools.length} tool(s) from ${plugin.packageName}: ${tools.map((t) => t.name).join(', ')}`,
        )
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Failed to load tool plugin ${plugin.packageName}: ${message}`)
    }
  }
}
