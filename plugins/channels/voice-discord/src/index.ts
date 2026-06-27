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

import type { PluginManifest, TurnAfterContext } from '@rivetos/types'
import { VoicePlugin } from './plugin.js'
import type { LocalVoiceConfig } from './local-voice.js'

interface RivetosConfigShape {
  channels?: Record<string, Record<string, unknown> | undefined>
  memory?: { postgres?: { connection_string?: string } }
}

/** Rivet Local's own self-described voice — see /rivet-shared/bin/rivet-local-voice.v2.md */
const DEFAULT_VOICE_INSTRUCT =
  'A warm, natural male voice. Conversational — not overly formal, but not too casual either. ' +
  'A bit of gravitas without being dramatic or announcer-y. Steady and calm, genuinely easy to ' +
  'listen to — never sounds like he is performing. A bit of texture to it, not too smooth or ' +
  'polished; the kind of voice you would want to have a long conversation with.'

function buildLocalConfig(cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): LocalVoiceConfig {
  // Host comes from config (`gerty_host`) or env (`GERTY_HOST`) — no IP baked in.
  const host = (cfg.gerty_host as string | undefined) ?? env.GERTY_HOST ?? 'localhost'
  return {
    sttUrl: (cfg.stt_url as string | undefined) ?? `http://${host}:9000/v1/chat/completions`,
    ttsUrl: (cfg.tts_url as string | undefined) ?? `http://${host}:9001/v1/audio/speech`,
    sttModel: (cfg.stt_model as string | undefined) ?? 'qwen3-asr',
    ttsModel: (cfg.tts_model as string | undefined) ?? 'qwen3-tts',
    voiceInstruct: (cfg.voice_instruct as string | undefined) ?? DEFAULT_VOICE_INSTRUCT,
    language: (cfg.language as string | undefined) ?? 'English',
    sampleRate: (cfg.sample_rate as number | undefined) ?? 24000,
    maxNewTokens: (cfg.tts_max_new_tokens as number | undefined) ?? 4096,
    speaker: cfg.speaker as string | undefined,
  }
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

    const provider = (cfg.provider as 'xai' | 'gemini' | 'local' | undefined) ?? 'xai'

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
      provider,
      local: provider === 'local' ? buildLocalConfig(cfg, ctx.env) : undefined,
      agentId: (cfg.agent as string | undefined) ?? 'local',
      channelId: (cfg.channel_id as string | undefined) ?? 'voice-discord',
      voiceChannelId: cfg.voice_channel_id as string | undefined,
      silenceDurationMs: cfg.silence_ms as number | undefined,
    })

    if (provider === 'local') {
      // Voice is a RivetOS Channel: transcripts run through the real agent, and
      // the agent's final response is spoken from this turn:after hook. The
      // runtime starts the channel (logs the bot in) during runtime.start().
      ctx.registerChannel(voicePlugin)
      ctx.registerHook<TurnAfterContext>({
        id: 'voice-discord:finalize-turn',
        event: 'turn:after',
        description: 'Flush the final spoken clause for the local voice channel',
        handler: (hc) => {
          if (hc.sessionId) voicePlugin.onTurnComplete(hc.sessionId, hc.aborted)
        },
      })
      ctx.registerShutdown(() => voicePlugin.stop())
      ctx.logger.info('Voice (local/GERTY) registered as channel — routing through agent')
      return
    }

    // Cloud realtime (xai/gemini): standalone — start directly, not a Channel.
    voicePlugin.start().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Voice plugin failed: ${message}`)
    })
    ctx.registerShutdown(() => voicePlugin.stop())
  },
}
