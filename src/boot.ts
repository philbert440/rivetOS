/**
 * Boot — the composition root.
 *
 * This is the ONLY file that knows about concrete plugin types.
 * It reads config, instantiates plugins, and wires them into the runtime.
 * Not part of core. Not part of any plugin. Just the glue.
 */

import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Runtime } from '../packages/core/src/runtime.js';
import { HookPipelineImpl } from '../packages/core/src/domain/hooks.js';
import { createFallbackHook } from '../packages/core/src/domain/fallback.js';
import { createSafetyHooks, RULE_NPM_DRY_RUN, RULE_WARN_CONFIG_WRITE, RULE_NO_DELETE_GIT } from '../packages/core/src/domain/safety-hooks.js';
import type { AuditWriter, AuditEntry } from '../packages/core/src/domain/safety-hooks.js';
import { createAutoActionHooks } from '../packages/core/src/domain/auto-actions.js';
import type { ShellExecutor } from '../packages/core/src/domain/auto-actions.js';
import { createSessionHooks } from '../packages/core/src/domain/session-hooks.js';
import { logger } from '../packages/core/src/logger.js';
import type { FallbackConfig } from '@rivetos/types';

// Providers
import { AnthropicProvider } from '../plugins/providers/anthropic/src/index.js';
import { GoogleProvider } from '../plugins/providers/google/src/index.js';
import { XAIProvider } from '../plugins/providers/xai/src/index.js';
import { OllamaProvider } from '../plugins/providers/ollama/src/index.js';
import { OpenAICompatProvider } from '../plugins/providers/openai-compat/src/index.js';

// Channels
import { TelegramChannel } from '../plugins/channels/telegram/src/index.js';
import { DiscordChannel } from '../plugins/channels/discord/src/index.js';
// Voice plugin imported lazily — native deps (opus, sodium) may not be installed

// Tools
import { ShellTool } from '../plugins/tools/shell/src/index.js';
import { CodingPipeline, createCodingPipelineTool } from '../plugins/tools/coding-pipeline/src/index.js';
import { createWebTools } from '../plugins/tools/web-search/src/index.js';
import { createFileToolsPlugin } from '../plugins/tools/file/src/index.js';
import { createSearchToolsPlugin } from '../plugins/tools/search/src/index.js';
import { createInteractionToolsPlugin } from '../plugins/tools/interaction/src/index.js';
import type { Tool } from '@rivetos/types';

// MCP
import { MCPClientPlugin } from '../plugins/tools/mcp-client/src/index.js';

// Memory
import { PostgresMemory, SearchEngine, Expander, createMemoryTools, BackgroundEmbedder, BackgroundCompactor } from '../plugins/memory/postgres/src/index.js';
const log = logger('Boot');

export async function boot(configPath?: string) {
  configPath = configPath ?? resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml');

  log.info(`Loading config from ${configPath}`);
  const config = await loadConfig(configPath);

  // Create hook pipeline
  const hooks = new HookPipelineImpl(log);

  // Register fallback chains from config
  const fallbackConfigs: FallbackConfig[] = [];
  if (config.runtime.fallbacks) {
    for (const fb of config.runtime.fallbacks as FallbackConfig[]) {
      fallbackConfigs.push(fb);
    }
  }
  // Also check per-agent fallbacks
  for (const [id, agent] of Object.entries(config.agents)) {
    const agentFallbacks = agent.fallbacks as string[] | undefined;
    if (agentFallbacks?.length) {
      fallbackConfigs.push({
        providerId: agent.provider as string,
        fallbacks: agentFallbacks,
      });
    }
  }
  if (fallbackConfigs.length > 0) {
    hooks.register(createFallbackHook(fallbackConfigs));
    log.info(`Hooks: ${fallbackConfigs.length} fallback chain(s) registered`);
  }

  // Register safety hooks (M2.2)
  const workspaceDir = config.runtime.workspace.replace('~', process.env.HOME ?? '.');
  const safetyConfig = config.runtime.safety as Record<string, unknown> | undefined;
  {
    // File-based audit writer
    const auditWriter: AuditWriter = {
      write: async (entry: AuditEntry) => {
        const { appendFile, mkdir: mkdirAudit } = await import('node:fs/promises');
        const auditDir = resolve(workspaceDir, '.data', 'audit');
        await mkdirAudit(auditDir, { recursive: true });
        const today = new Date().toISOString().split('T')[0];
        const auditPath = resolve(auditDir, `${today}.jsonl`);
        await appendFile(auditPath, JSON.stringify(entry) + '\n');
      },
    };

    const safetyHooks = createSafetyHooks({
      shellDanger: safetyConfig?.shellDanger !== false,
      workspaceFence: safetyConfig?.workspaceFence as any,
      auditWriter: safetyConfig?.audit !== false ? auditWriter : undefined,
      customRules: [RULE_NPM_DRY_RUN, RULE_NO_DELETE_GIT, RULE_WARN_CONFIG_WRITE],
    });

    for (const hook of safetyHooks) {
      hooks.register(hook);
    }
    log.info(`Hooks: ${safetyHooks.length} safety hook(s) registered`);
  }

  // Register auto-action hooks (M2.3 — all opt-in via config)
  const autoActionsConfig = config.runtime.auto_actions as Record<string, unknown> | undefined;
  if (autoActionsConfig) {
    const shellExec: ShellExecutor = {
      exec: async (command: string, cwd?: string) => {
        const { execSync } = await import('node:child_process');
        try {
          const stdout = execSync(command, {
            cwd: cwd ?? workspaceDir,
            timeout: 30000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { stdout: stdout ?? '', stderr: '', exitCode: 0 };
        } catch (err: any) {
          return {
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? '',
            exitCode: err.status ?? 1,
          };
        }
      },
    };

    const autoHooks = createAutoActionHooks({
      shell: shellExec,
      cwd: workspaceDir,
      autoFormat: autoActionsConfig.format === true,
      autoLint: autoActionsConfig.lint === true,
      autoTest: autoActionsConfig.test === true,
      autoGitCheck: autoActionsConfig.gitCheck === true,
    });

    for (const hook of autoHooks) {
      hooks.register(hook);
    }
    if (autoHooks.length > 0) {
      log.info(`Hooks: ${autoHooks.length} auto-action hook(s) registered`);
    }
  }

  // Register session hooks (M2.4)
  {
    const { appendFile: appendFs, readFile: readFs, writeFile: writeFs, mkdir: mkdirFs } = await import('node:fs/promises');
    const sessionHooks = createSessionHooks({
      context: {
        workspaceDir,
        fileWriter: {
          write: async (path: string, content: string) => {
            const dir = resolve(path, '..');
            await mkdirFs(dir, { recursive: true });
            await writeFs(path, content);
          },
          read: async (path: string) => {
            try {
              return await readFs(path, 'utf-8');
            } catch {
              return null;
            }
          },
          append: async (path: string, content: string) => {
            const dir = resolve(path, '..');
            await mkdirFs(dir, { recursive: true });
            await appendFs(path, content);
          },
        },
      },
      sessionStart: true,
      sessionSummary: true,
      autoCommit: false, // Opt-in — too aggressive as default
      preCompact: true,
      postCompact: true,
    });

    for (const hook of sessionHooks) {
      hooks.register(hook);
    }
    log.info(`Hooks: ${sessionHooks.length} session hook(s) registered`);
  }

  // Create runtime
  const runtime = new Runtime({
    workspaceDir,
    defaultAgent: config.runtime.default_agent,
    maxToolIterations: config.runtime.max_tool_iterations,
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      name: id,
      provider: agent.provider,
      defaultThinking: (agent.default_thinking as string) ?? 'medium',
    })),
    heartbeats: config.runtime.heartbeats as import('@rivetos/types').HeartbeatConfig[],
    skillDirs: config.runtime.skill_dirs,
    hooks,
    fallbacks: fallbackConfigs,
  });

  // Register providers
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    try {
      switch (id) {
        case 'anthropic': {
          // Resolve API key: config → env var → stored OAuth token
          let anthropicKey = providerConfig.api_key as string ?? process.env.ANTHROPIC_API_KEY ?? '';
          if (!anthropicKey) {
            try {
              const { loadTokens } = await import('../plugins/providers/anthropic/src/oauth.js');
              const tokens = await loadTokens();
              if (tokens?.accessToken) {
                anthropicKey = tokens.accessToken;
              }
            } catch {}
          }
          if (!anthropicKey) {
            console.warn('[RivetOS] No Anthropic API key or OAuth token found. Run: rivetos anthropic setup');
          }
          runtime.registerProvider(new AnthropicProvider({
            apiKey: anthropicKey,
            model: providerConfig.model as string,
            maxTokens: providerConfig.max_tokens as number,
          }));
          break;
        }
        case 'google':
          runtime.registerProvider(new GoogleProvider({
            apiKey: providerConfig.api_key as string ?? process.env.GOOGLE_API_KEY ?? '',
            model: providerConfig.model as string,
            maxTokens: providerConfig.max_tokens as number,
          }));
          break;
        case 'xai':
          runtime.registerProvider(new XAIProvider({
            apiKey: providerConfig.api_key as string ?? process.env.XAI_API_KEY ?? '',
            model: providerConfig.model as string,
            maxTokens: providerConfig.max_tokens as number,
            temperature: providerConfig.temperature as number,
          }));
          break;
        case 'ollama':
          runtime.registerProvider(new OllamaProvider({
            baseUrl: providerConfig.base_url as string,
            model: providerConfig.model as string,
            numCtx: providerConfig.num_ctx as number,
            temperature: providerConfig.temperature as number,
            keepAlive: providerConfig.keep_alive as string,
          }));
          break;
        case 'openai-compat':
        case 'llama-server':
          runtime.registerProvider(new OpenAICompatProvider({
            baseUrl: providerConfig.base_url as string,
            apiKey: providerConfig.api_key as string,
            model: providerConfig.model as string,
            maxTokens: providerConfig.max_tokens as number,
            temperature: providerConfig.temperature as number,
            topP: providerConfig.top_p as number,
            repeatPenalty: providerConfig.repeat_penalty as number,
            id: id,
            name: providerConfig.name as string ?? id,
          }));
          break;
        default:
          log.warn(`Unknown provider: ${id} (skipped)`);
      }
    } catch (err: any) {
      log.error(`Failed to register provider ${id}: ${err.message}`);
    }
  }

  // Register channels
  for (const [id, channelConfig] of Object.entries(config.channels)) {
    try {
      switch (id) {
        case 'telegram':
          runtime.registerChannel(new TelegramChannel({
            botToken: channelConfig.bot_token as string ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
            ownerId: channelConfig.owner_id as string ?? '',
            allowedUsers: channelConfig.allowed_users as string[],
            agent: channelConfig.agent as string,
          }));
          break;
      case 'discord':
        runtime.registerChannel(new DiscordChannel({
          botToken: channelConfig.bot_token as string ?? process.env.DISCORD_BOT_TOKEN ?? '',
          ownerId: channelConfig.owner_id as string ?? '',
          allowedGuilds: channelConfig.allowed_guilds as string[],
          allowedChannels: channelConfig.allowed_channels as string[],
          allowedUsers: channelConfig.allowed_users as string[],
          channelBindings: channelConfig.channel_bindings as Record<string, string>,
          mentionOnly: channelConfig.mention_only as boolean,
        }));
        break;
      case 'voice':
      case 'voice-discord': {
        const { VoicePlugin } = await import('../plugins/channels/voice-discord/src/index.js');
        const voicePlugin = new VoicePlugin({
          discordToken: channelConfig.bot_token as string ?? process.env.VOICE_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN ?? '',
          xaiApiKey: channelConfig.xai_api_key as string ?? process.env.XAI_API_KEY ?? '',
          guildId: channelConfig.guild_id as string ?? '',
          allowedUsers: channelConfig.allowed_users as string[] ?? [],
          voice: channelConfig.voice as string,
          instructions: channelConfig.instructions as string,
          transcriptDir: channelConfig.transcript_dir as string,
          postgresConnectionString: config.memory?.postgres?.connection_string as string ?? process.env.RIVETOS_PG_URL ?? '',
        });
        // Voice plugin manages its own lifecycle (not a Channel)
        voicePlugin.start().catch((err: any) => log.error(`Voice plugin failed: ${err.message}`));
        // Register for shutdown
        const origStop = runtime.stop.bind(runtime);
        runtime.stop = async () => { await voicePlugin.stop(); await origStop(); };
        break;
      }
      // TODO: Add cli channel
        default:
          log.warn(`Unknown channel: ${id} (skipped)`);
      }
    } catch (err: any) {
      log.error(`Failed to register channel ${id}: ${err.message}`);
    }
  }

  // Register memory
  if (config.memory?.postgres) {
    const pgConfig = config.memory.postgres;
    const connectionString = pgConfig.connection_string as string ?? process.env.RIVETOS_PG_URL ?? '';

    if (connectionString) {
      try {
        const memory = new PostgresMemory({ connectionString });
        runtime.registerMemory(memory);

        // Use the adapter's internal pool and engines (no duplicate pool)
        const searchEngine = memory.getSearchEngine();
        const expanderInstance = memory.getExpander();

        // Compactor config
        const compactorEndpoint = pgConfig.compactor_endpoint as string ?? process.env.RIVETOS_COMPACTOR_URL ?? '';
        const compactorModel = pgConfig.compactor_model as string ?? 'rivet-v0.1';

        const memoryTools = createMemoryTools(searchEngine, expanderInstance, {
          compactorEndpoint: compactorEndpoint || undefined,
          compactorModel,
          pool: memory.getPool(),
        });
        for (const tool of memoryTools) {
          runtime.registerTool(tool);
        }

        // Start background embedder if endpoint configured
        const embedEndpoint = pgConfig.embed_endpoint as string ?? process.env.RIVETOS_EMBED_URL ?? '';
        if (embedEndpoint) {
          const embedder = new BackgroundEmbedder({
            connectionString,
            embedEndpoint,
            batchSize: 10,
            intervalMs: 30000,
          });
          embedder.start();
        }

        // Start background compactor if endpoint configured
        if (compactorEndpoint) {
          const compactor = new BackgroundCompactor({
            connectionString,
            compactorEndpoint,
            compactorModel,
            intervalMs: 1_800_000, // 30 minutes
          });
          compactor.start();
          log.info(`Compactor: ${compactorEndpoint} (model: ${compactorModel})`);
        }

        log.info('Memory: postgres (ros_* tables)');
      } catch (err: any) {
        log.error(`Failed to initialize memory: ${err.message}`);
      }
    }
  }

  // Register tools
  runtime.registerTool(new ShellTool({
    cwd: config.runtime.workspace.replace('~', process.env.HOME ?? '.'),
  }));

  // Register file tools (file_read, file_write, file_edit)
  const filePlugin = createFileToolsPlugin();
  for (const tool of filePlugin.getTools()) {
    runtime.registerTool(tool);
  }

  // Register search tools (search_glob, search_grep)
  const searchPlugin = createSearchToolsPlugin();
  for (const tool of searchPlugin.getTools()) {
    runtime.registerTool(tool);
  }

  // Register interaction tools (todo)
  const interactionPlugin = createInteractionToolsPlugin();
  for (const tool of interactionPlugin.getTools()) {
    runtime.registerTool(tool);
  }

  // Register web search + fetch tools (Google CSE for non-xAI providers)
  // xAI has native web search built into the Responses API
  const webTools = createWebTools({
    googleApiKey: process.env.GOOGLE_CSE_API_KEY ?? process.env.GOOGLE_API_KEY,
    googleCseId: process.env.GOOGLE_CSE_ID,
  });
  for (const tool of webTools) {
    runtime.registerTool(tool);
  }

  // Register MCP server tools
  if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
    try {
      const mcpPlugin = new MCPClientPlugin({
        servers: config.mcp.servers as any,
      });
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
    } catch (err: any) {
      log.error(`Failed to initialize MCP client: ${err.message}`);
    }
  }

  // Register coding pipeline (uses sub-agents for build→review→validate loop)
  const pipelineCfg = config.runtime.coding_pipeline as Record<string, unknown> | undefined;
  const pipeline = new CodingPipeline({
    builderAgent: (pipelineCfg?.builder_agent as string) ?? 'grok',
    validatorAgent: (pipelineCfg?.validator_agent as string) ?? 'opus',
    maxBuildLoops: (pipelineCfg?.max_build_loops as number) ?? 3,
    maxValidationLoops: (pipelineCfg?.max_validation_loops as number) ?? 2,
    workingDir: config.runtime.workspace.replace('~', process.env.HOME ?? '.'),
    autoCommit: (pipelineCfg?.auto_commit as boolean) ?? true,
  });

  // Wire pipeline to sub-agent tools (after all tools registered)
  // The pipeline calls subagent_spawn/shell internally via tool executors
  const findTool = (name: string) => {
    const allTools = runtime.getTools();
    const tool = allTools?.find((t: any) => t.name === name);
    return tool ? (args: Record<string, unknown>) => tool.execute(args) : async () => 'Tool not available';
  };
  // Deferred — tools registered during runtime.start(), so we set executors lazily
  const origStart = runtime.start.bind(runtime);
  // Voice plugin shutdown handled via process signal
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

  // Write PID file
  const pidPath = resolve(process.env.HOME ?? '.', '.rivetos', 'rivetos.pid');
  const { writeFile: writePid, unlink } = await import('node:fs/promises');
  const { mkdir: mkPidDir } = await import('node:fs/promises');
  await mkPidDir(resolve(process.env.HOME ?? '.', '.rivetos'), { recursive: true });
  await writePid(pidPath, String(process.pid));

  // Handle shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    await runtime.stop();
    try { await unlink(pidPath); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start
  await runtime.start();
}

// Direct execution support (npx tsx src/boot.ts <config>)
if (process.argv[1]?.endsWith('boot.ts') || process.argv[1]?.endsWith('boot.js')) {
  boot(process.argv[2]).catch((err) => {
    console.error('[RivetOS] [ERROR] [Boot] Fatal:', err);
    process.exit(1);
  });
}
