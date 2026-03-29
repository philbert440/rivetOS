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
import { logger } from '../packages/core/src/logger.js';

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
import { createCodingPipelineTool } from '../plugins/tools/coding-pipeline/src/index.js';

// Memory
import { PostgresMemory, SearchEngine, Expander, createMemoryTools, BackgroundEmbedder, BackgroundCompactor } from '../plugins/memory/postgres/src/index.js';
const log = logger('Boot');

export async function boot(configPath?: string) {
  configPath = configPath ?? resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml');

  log.info(`Loading config from ${configPath}`);
  const config = await loadConfig(configPath);

  // Create runtime
  const runtime = new Runtime({
    workspaceDir: config.runtime.workspace.replace('~', process.env.HOME ?? '.'),
    defaultAgent: config.runtime.default_agent,
    maxToolIterations: config.runtime.max_tool_iterations,
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      name: id,
      provider: agent.provider,
      defaultThinking: (agent.default_thinking as any) ?? 'medium',
    })),
    heartbeats: config.runtime.heartbeats as any[],
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
          lcmConnectionString: config.memory?.postgres?.connection_string as string ?? process.env.RIVETOS_PG_URL ?? '',
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

  // Register coding pipeline (uses sub-agents internally)
  // The pipeline needs a handle to spawn sub-agents — we create a lightweight adapter
  // that delegates to the runtime's sub-agent manager (registered during start())
  const pipelineConfig = config.runtime.coding_pipeline as Record<string, unknown> | undefined;
  if (pipelineConfig !== undefined || config.agents.grok || config.agents.local) {
    runtime.registerTool(createCodingPipelineTool(
      {
        builderAgent: (pipelineConfig?.builder_agent as string) ?? 'grok',
        validatorAgent: (pipelineConfig?.validator_agent as string) ?? 'opus',
        maxBuildCycles: (pipelineConfig?.max_build_cycles as number) ?? 3,
        maxValidationRejections: (pipelineConfig?.max_validation_rejections as number) ?? 2,
        workingDir: config.runtime.workspace.replace('~', process.env.HOME ?? '.'),
        autoCommit: (pipelineConfig?.auto_commit as boolean) ?? true,
        autoPush: (pipelineConfig?.auto_push as boolean) ?? true,
      },
      {
        // Adapter: delegates to runtime's sub-agent manager
        async spawn(request) {
          // Use delegation engine directly since sub-agent manager is internal to runtime
          const { DelegationEngine } = await import('../packages/core/src/domain/delegation.js');
          const engine = new DelegationEngine({
            router: (runtime as any).router,
            workspace: (runtime as any).workspace,
            tools: (runtime as any).tools,
          });
          const result = await engine.delegate({
            fromAgent: request.agent === 'grok' ? 'opus' : 'grok',
            toAgent: request.agent,
            task: request.task,
            timeoutMs: request.timeoutMs,
          });
          return { response: result.response, status: result.status };
        },
      },
    ));
  }

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
