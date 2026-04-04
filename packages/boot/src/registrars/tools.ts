/**
 * Tool Registrar — registers shell, file, search, web, interaction, MCP, and coding pipeline tools.
 */

import type { Runtime } from '@rivetos/core';
import type { Tool } from '@rivetos/types';
import type { RivetConfig } from '../config.js';
import { logger } from '@rivetos/core';

const log = logger('Boot:Tools');

export async function registerTools(runtime: Runtime, config: RivetConfig, workspaceDir: string): Promise<void> {
  // Shell
  const { ShellTool } = await import('@rivetos/tool-shell');
  runtime.registerTool(new ShellTool({ cwd: workspaceDir }));

  // File tools (file_read, file_write, file_edit)
  const { createFileToolsPlugin } = await import('@rivetos/tool-file');
  for (const tool of createFileToolsPlugin().getTools!()) {
    runtime.registerTool(tool);
  }

  // Search tools (search_glob, search_grep)
  const { createSearchToolsPlugin } = await import('@rivetos/tool-search');
  for (const tool of createSearchToolsPlugin().getTools!()) {
    runtime.registerTool(tool);
  }

  // Interaction tools (todo, ask_user)
  const { createInteractionToolsPlugin } = await import('@rivetos/tool-interaction');
  for (const tool of createInteractionToolsPlugin().getTools!()) {
    runtime.registerTool(tool);
  }

  // Web search + fetch (Google CSE for non-xAI providers)
  const { createWebTools } = await import('@rivetos/tool-web-search');
  const webTools = createWebTools({
    googleApiKey: process.env.GOOGLE_CSE_API_KEY ?? process.env.GOOGLE_API_KEY,
    googleCseId: process.env.GOOGLE_CSE_ID,
  });
  for (const tool of webTools) {
    runtime.registerTool(tool);
  }

  // MCP servers
  await registerMcpTools(runtime, config);

  // Coding pipeline
  await registerCodingPipeline(runtime, config, workspaceDir);
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

async function registerMcpTools(runtime: Runtime, config: RivetConfig): Promise<void> {
  if (!config.mcp?.servers || Object.keys(config.mcp.servers).length === 0) return;

  try {
    const { MCPClientPlugin } = await import('@rivetos/tool-mcp-client');
    const mcpPlugin = new MCPClientPlugin({ servers: config.mcp.servers });
    const mcpTools = await mcpPlugin.connect();

    for (const tool of mcpTools) {
      runtime.registerTool(tool);
    }

    if (mcpTools.length > 0) {
      log.info(`MCP: ${mcpTools.length} tool(s) from ${Object.keys(config.mcp.servers).length} server(s)`);
    }

    // Register for shutdown
    const origStop = runtime.stop.bind(runtime);
    runtime.stop = async () => { await mcpPlugin.disconnect(); await origStop(); };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to initialize MCP client: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Coding Pipeline
// ---------------------------------------------------------------------------

async function registerCodingPipeline(runtime: Runtime, config: RivetConfig, workspaceDir: string): Promise<void> {
  const { CodingPipeline, createCodingPipelineTool } = await import('@rivetos/tool-coding-pipeline');

  const pipelineCfg = config.runtime.coding_pipeline;
  const pipeline = new CodingPipeline({
    builderAgent: pipelineCfg?.builder_agent ?? 'grok',
    validatorAgent: pipelineCfg?.validator_agent ?? 'opus',
    maxBuildLoops: pipelineCfg?.max_build_loops ?? 3,
    maxValidationLoops: pipelineCfg?.max_validation_loops ?? 2,
    workingDir: workspaceDir,
    autoCommit: pipelineCfg?.auto_commit ?? true,
  });

  // Wire pipeline to sub-agent tools — deferred until tools are registered during start()
  const findTool = (name: string): ((args: Record<string, unknown>) => Promise<string>) => {
    const allTools = runtime.getTools();
    const tool = allTools?.find((t: Tool) => t.name === name);
    return tool
      ? async (args: Record<string, unknown>) => {
          const result = await tool.execute(args);
          return typeof result === 'string' ? result : JSON.stringify(result);
        }
      : async () => 'Tool not available';
  };

  const origStart = runtime.start.bind(runtime);
  runtime.start = async () => {
    await origStart();
    pipeline.setToolExecutors({
      subagentSpawn: findTool('subagent_spawn'),
      subagentSend: findTool('subagent_send'),
      subagentKill: findTool('subagent_kill'),
      shellExec: findTool('shell'),
    });
  };

  runtime.registerTool(createCodingPipelineTool(pipeline));
}
