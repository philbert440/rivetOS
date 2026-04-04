/**
 * Channel Registrar — instantiates and registers messaging channels from config.
 */

import type { Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Channels')

export async function registerChannels(runtime: Runtime, config: RivetConfig): Promise<void> {
  for (const [id, channelConfig] of Object.entries(config.channels)) {
    try {
      switch (id) {
        case 'telegram': {
          const { TelegramChannel } = await import('@rivetos/channel-telegram')
          runtime.registerChannel(
            new TelegramChannel({
              botToken:
                (channelConfig.bot_token as string | undefined) ??
                process.env.TELEGRAM_BOT_TOKEN ??
                '',
              ownerId: (channelConfig.owner_id as string | undefined) ?? '',
              allowedUsers: channelConfig.allowed_users as string[] | undefined,
              agent: channelConfig.agent as string | undefined,
            }),
          )
          break
        }

        case 'discord': {
          const { DiscordChannel } = await import('@rivetos/channel-discord')
          runtime.registerChannel(
            new DiscordChannel({
              botToken:
                (channelConfig.bot_token as string | undefined) ??
                process.env.DISCORD_BOT_TOKEN ??
                '',
              ownerId: (channelConfig.owner_id as string | undefined) ?? '',
              allowedGuilds: channelConfig.allowed_guilds as string[] | undefined,
              allowedChannels: channelConfig.allowed_channels as string[] | undefined,
              allowedUsers: channelConfig.allowed_users as string[] | undefined,
              channelBindings: channelConfig.channel_bindings as Record<string, string> | undefined,
              mentionOnly: channelConfig.mention_only as boolean | undefined,
            }),
          )
          break
        }

        case 'voice':
        case 'voice-discord': {
          const { VoicePlugin } = await import('@rivetos/channel-voice-discord')
          const voicePlugin = new VoicePlugin({
            discordToken:
              (channelConfig.bot_token as string | undefined) ??
              process.env.VOICE_BOT_TOKEN ??
              process.env.DISCORD_BOT_TOKEN ??
              '',
            xaiApiKey:
              (channelConfig.xai_api_key as string | undefined) ?? process.env.XAI_API_KEY ?? '',
            guildId: (channelConfig.guild_id as string | undefined) ?? '',
            allowedUsers: (channelConfig.allowed_users as string[] | undefined) ?? [],
            voice: channelConfig.voice as string | undefined,
            instructions: channelConfig.instructions as string | undefined,
            transcriptDir: channelConfig.transcript_dir as string | undefined,
            postgresConnectionString:
              (config.memory?.postgres.connection_string as string | undefined) ??
              process.env.RIVETOS_PG_URL ??
              '',
          })
          // Voice plugin manages its own lifecycle (not a Channel)
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
          break
        }

        default:
          log.warn(`Unknown channel: ${id} (skipped)`)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Failed to register channel ${id}: ${message}`)
    }
  }
}
