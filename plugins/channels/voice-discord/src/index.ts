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
