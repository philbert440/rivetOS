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
              botToken: (channelConfig.bot_token as string) ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
              ownerId: (channelConfig.owner_id as string) ?? '',
              allowedUsers: channelConfig.allowed_users as string[],
              agent: channelConfig.agent as string,
            }),
          )
          break
        }

        case 'discord': {
          const { DiscordChannel } = await import('@rivetos/channel-discord')
          runtime.registerChannel(
            new DiscordChannel({
              botToken: (channelConfig.bot_token as string) ?? process.env.DISCORD_BOT_TOKEN ?? '',
              ownerId: (channelConfig.owner_id as string) ?? '',
              allowedGuilds: channelConfig.allowed_guilds as string[],
              allowedChannels: channelConfig.allowed_channels as string[],
              allowedUsers: channelConfig.allowed_users as string[],
              channelBindings: channelConfig.channel_bindings as Record<string, string>,
              mentionOnly: channelConfig.mention_only as boolean,
            }),
          )
          break
        }

        case 'voice':
        case 'voice-discord': {
          const { VoicePlugin } = await import('@rivetos/channel-voice-discord')
          const voicePlugin = new VoicePlugin({
            discordToken:
              (channelConfig.bot_token as string) ??
              process.env.VOICE_BOT_TOKEN ??
              process.env.DISCORD_BOT_TOKEN ??
              '',
            xaiApiKey: (channelConfig.xai_api_key as string) ?? process.env.XAI_API_KEY ?? '',
            guildId: (channelConfig.guild_id as string) ?? '',
            allowedUsers: (channelConfig.allowed_users as string[]) ?? [],
            voice: channelConfig.voice as string,
            instructions: channelConfig.instructions as string,
            transcriptDir: channelConfig.transcript_dir as string,
            postgresConnectionString:
              (config.memory?.postgres?.connection_string as string) ??
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
            await voicePlugin.stop()
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
