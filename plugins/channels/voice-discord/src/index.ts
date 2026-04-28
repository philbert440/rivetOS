// TODO: Add integration tests for voice channel lifecycle

/**
 * @rivetos/channel-voice-discord
 *
 * Discord voice channel plugin via xAI Realtime API.
 * Ported from rivet-voice standalone service.
 *
 * Features:
 * - Auto-join when allowed user enters voice channel
 * - Auto-leave with grace period
 * - Startup scan (joins if user already in channel)
 * - xAI Realtime WebSocket: bidirectional audio (PCM 24kHz)
 * - Server VAD (voice activity detection)
 * - DAVE E2EE support (required by Discord as of 2026-03)
 * - Opus decode → PCM → xAI → PCM → 48kHz stereo → Discord
 * - Voice switching via /voice slash command
 * - Transcript logging to markdown files
 * - Slash commands: /voice join, leave, status, voice
 */

export { VoicePlugin } from './plugin.js'
export type { VoicePluginConfig } from './plugin.js'

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

import type { PluginManifest } from '@rivetos/types'
import { VoicePlugin } from './plugin.js'

interface RivetosConfigShape {
  channels?: Record<string, Record<string, unknown> | undefined>
  memory?: { postgres?: { connection_string?: string } }
}

export const manifest: PluginManifest = {
  type: 'channel',
  name: 'voice-discord',
  register(ctx) {
    // Channel may be configured under `voice` (legacy alias) or `voice-discord`.
    const root = ctx.config as RivetosConfigShape
    const cfg = ctx.pluginConfig ?? root.channels?.voice ?? {}

    const discordToken =
      (cfg.bot_token as string | undefined) ??
      ctx.env.VOICE_BOT_TOKEN ??
      ctx.env.DISCORD_BOT_TOKEN ??
      ''
    if (!discordToken) return

    const voicePlugin = new VoicePlugin({
      discordToken,
      xaiApiKey: (cfg.xai_api_key as string | undefined) ?? ctx.env.XAI_API_KEY ?? '',
      guildId: (cfg.guild_id as string | undefined) ?? '',
      allowedUsers: (cfg.allowed_users as string[] | undefined) ?? [],
      voice: cfg.voice as string | undefined,
      instructions: cfg.instructions as string | undefined,
      transcriptDir: cfg.transcript_dir as string | undefined,
      postgresConnectionString:
        root.memory?.postgres?.connection_string ?? ctx.env.RIVETOS_PG_URL ?? '',
    })

    voicePlugin.start().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Voice plugin failed: ${message}`)
    })

    ctx.registerShutdown(() => {
      voicePlugin.stop()
    })
  },
}
