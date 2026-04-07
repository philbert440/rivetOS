/**
 * Channel Registrar — dynamically loads and registers messaging channels
 * using the plugin discovery system.
 *
 * Most channels follow the standard pattern: import class, instantiate with config.
 * Special cases (voice-discord) are handled with specific logic.
 */

import type { Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import type { PluginRegistry } from '../discovery.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Channels')

// ---------------------------------------------------------------------------
// Channel config resolution
// ---------------------------------------------------------------------------

function resolveChannelConfig(
  id: string,
  channelConfig: Record<string, unknown>,
  config: RivetConfig,
): Record<string, unknown> {
  switch (id) {
    case 'telegram':
      return {
        botToken:
          (channelConfig.bot_token as string | undefined) ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
        ownerId: (channelConfig.owner_id as string | undefined) ?? '',
        allowedUsers: channelConfig.allowed_users,
        agent: channelConfig.agent,
      }

    case 'discord':
      return {
        botToken:
          (channelConfig.bot_token as string | undefined) ?? process.env.DISCORD_BOT_TOKEN ?? '',
        ownerId: (channelConfig.owner_id as string | undefined) ?? '',
        allowedGuilds: channelConfig.allowed_guilds,
        allowedChannels: channelConfig.allowed_channels,
        allowedUsers: channelConfig.allowed_users,
        channelBindings: channelConfig.channel_bindings,
        mentionOnly: channelConfig.mention_only,
      }

    case 'voice':
    case 'voice-discord':
      return {
        discordToken:
          (channelConfig.bot_token as string | undefined) ??
          process.env.VOICE_BOT_TOKEN ??
          process.env.DISCORD_BOT_TOKEN ??
          '',
        xaiApiKey:
          (channelConfig.xai_api_key as string | undefined) ?? process.env.XAI_API_KEY ?? '',
        guildId: (channelConfig.guild_id as string | undefined) ?? '',
        allowedUsers: (channelConfig.allowed_users as string[] | undefined) ?? [],
        voice: channelConfig.voice,
        instructions: channelConfig.instructions,
        transcriptDir: channelConfig.transcript_dir,
        postgresConnectionString:
          (config.memory?.postgres.connection_string as string | undefined) ??
          process.env.RIVETOS_PG_URL ??
          '',
      }

    case 'agent':
      return channelConfig

    default:
      return channelConfig
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerChannels(
  runtime: Runtime,
  config: RivetConfig,
  registry: PluginRegistry,
): Promise<void> {
  for (const [id, channelConfig] of Object.entries(config.channels)) {
    try {
      // Map config IDs to discovery names
      const lookupName = id === 'voice' ? 'voice-discord' : id

      const discovered = registry.get('channel', lookupName)
      if (!discovered) {
        log.warn(`Unknown channel: ${id} (not found in plugin registry, skipped)`)
        continue
      }

      const mod = (await import(discovered.packageName)) as Record<string, unknown>
      const resolved = resolveChannelConfig(id, channelConfig, config)

      // Voice plugin is special — it manages its own lifecycle
      if (id === 'voice' || id === 'voice-discord') {
        const VoicePlugin = mod.VoicePlugin as new (args: Record<string, unknown>) => {
          start(): Promise<void>
          stop(): void
        }
        const voicePlugin = new VoicePlugin(resolved)
        voicePlugin.start().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          log.error(`Voice plugin failed: ${message}`)
        })
        // Register for shutdown
        const origStop = runtime.stop.bind(runtime)
        runtime.stop = async () => {
          voicePlugin.stop()
          await origStop()
        }
        continue
      }

      // Standard channels — find the Channel class
      const channelClassName = Object.keys(mod).find(
        (key) => key.endsWith('Channel') && key !== 'Channel',
      )
      if (!channelClassName) {
        log.error(`No Channel class found in ${discovered.packageName}`)
        continue
      }

      const ChannelClass = mod[channelClassName] as new (
        args: Record<string, unknown>,
      ) => import('@rivetos/types').Channel
      runtime.registerChannel(new ChannelClass(resolved))

      log.debug(`Registered channel: ${id} (${discovered.packageName})`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Failed to register channel ${id}: ${message}`)
    }
  }
}
