/**
 * Voice Session — manages a single voice channel session.
 *
 * Wires together: Discord voice connection ↔ Opus decode ↔ xAI Realtime ↔ Audio player.
 * Handles DAVE E2EE transition before subscribing to audio.
 */

import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import { XAIRealtimeClient, type XAIConfig } from './xai-client.js';
import { AudioPlayer } from './audio-player.js';
import { TranscriptLogger } from './transcript.js';
import type { VoicePluginConfig } from './plugin.js';
import pg from 'pg';

const { Pool } = pg;

export class VoiceSession {
  private connection: VoiceConnection;
  private xai: XAIRealtimeClient;
  private audioPlayer: AudioPlayer;
  private transcript: TranscriptLogger;
  
  private config: VoicePluginConfig;
  private sessionId: string;
  private subscribedUsers = new Set<string>();
  private opusStreams = new Map<string, any>();
  private decoders = new Map<string, any>();
  private audioReady = false;
  private postgresPool: pg.Pool | null = null;
  

  constructor(connection: VoiceConnection, config: VoicePluginConfig) {
    this.connection = connection;
    this.config = config;
    
    this.sessionId = `session_${Date.now()}`;

    // Memory pool
    if (config.postgresConnectionString) {
      this.postgresPool = new Pool({ connectionString: config.postgresConnectionString, max: 2 });
      
    }

    // Transcript logger
    this.transcript = new TranscriptLogger(
      this.sessionId,
      config.transcriptDir ?? 'transcripts',
      config.voice ?? 'Ara',
    );

    // Audio player (resamples 24kHz mono → 48kHz stereo for Discord)
    this.audioPlayer = new AudioPlayer();
    this.connection.subscribe(this.audioPlayer.getPlayer());

    // xAI Realtime client
    const xaiConfig: XAIConfig = {
      apiKey: config.xaiApiKey,
      voice: config.voice ?? 'Ara',
      instructions:
        config.instructions ??
        "You are Rivet, Phil's AI assistant. You're in a Discord voice channel. " +
          'Keep responses concise — this is voice, not text. 1-3 sentences max unless asked for detail. ' +
          "Be direct, helpful, a little dry. Don't interrupt — wait for the user to finish speaking.",
      sampleRate: config.sampleRate ?? 24000,
      silenceDurationMs: config.silenceDurationMs ?? 1500,
      collectionId: config.xaiCollectionId,
    };

    this.xai = new XAIRealtimeClient(xaiConfig, {
      onAudio: (audio) => this.audioPlayer.playAudio(audio),
      onUserTranscript: (text) => {
        console.info(`[Phil] ${text}`);
        this.transcript.addMessage('Phil', text);
      },
      onAssistantTranscript: (text) => {
        console.info(`[Rivet] ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
        this.transcript.addMessage('Rivet', text);
      },
      onResponseDone: () => this.audioPlayer.endResponse(),
      onFunctionCall: (name, callId, args) => this.handleFunctionCall(name, callId, args),
      onError: (err) => console.error('[xAI]', { error: err.message }),
    });

    this.xai.connect();

    // DAVE E2EE transition — wait for key exchange before audio
    this.connection.on('transitioned' as any, () => {
      if (!this.audioReady) {
        console.info('DAVE transition complete — audio ready');
        this.audioReady = true;
        this.startListening();
      }
    });

    // Fallback: start listening after 5s if no DAVE event
    setTimeout(() => {
      if (!this.audioReady) {
        console.info('DAVE timeout — starting audio listener');
        this.audioReady = true;
        this.startListening();
      }
    }, 5000);
  }

  // -----------------------------------------------------------------------
  // Audio Listening
  // -----------------------------------------------------------------------

  private startListening(): void {
    this.connection.receiver.speaking.on('start', (userId) => {
      if (!this.config.allowedUsers.includes(userId)) return;
      if (this.subscribedUsers.has(userId)) return;
      this.subscribedUsers.add(userId);
      this.subscribeToUser(userId);
    });
  }

  private subscribeToUser(userId: string): void {
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const prism = require('prism-media');
    const decoder = new prism.opus.Decoder({
      rate: this.config.sampleRate ?? 24000,
      channels: 1,
      frameSize: 960,
    });

    this.opusStreams.set(userId, opusStream);
    this.decoders.set(userId, decoder);

    opusStream.pipe(decoder);

    decoder.on('data', (pcm: Buffer) => {
      this.xai.sendAudio(pcm);
    });

    decoder.on('error', (err: Error) => {
      console.warn(`Opus decode error: ${err.message}`);
    });

    opusStream.on('error', (err: Error) => {
      console.warn(`Opus stream error: ${err.message}`);
    });

    opusStream.on('end', () => {
      this.subscribedUsers.delete(userId);
      this.opusStreams.delete(userId);
      this.decoders.delete(userId);
    });
  }

  // -----------------------------------------------------------------------
  // Function Calls — memory search tools
  // -----------------------------------------------------------------------

  private async handleFunctionCall(name: string, _callId: string, rawArgs: string): Promise<string> {
    let args: any;
    try {
      args = JSON.parse(rawArgs || '{}');
    } catch {
      args = {};
    }

    console.info(`Function call: ${name}(${JSON.stringify(args)})`);

    if (name === 'search_memories') {
      if (!this.lcmPool) {
        return JSON.stringify({ error: 'Memory search not configured (no postgresConnectionString)' });
      }
      try {
        const query = String(args.query ?? '');
        const limit = Math.min(Number(args.limit) || 10, 20);
        const result = await this.lcmPool.query(
          `SELECT m.message_id as id, m.content, m.role, m.created_at,
                  ts_rank_cd(m.content_tsv, plainto_tsquery('english', $1)) AS score
           FROM messages m
           WHERE m.content_tsv @@ plainto_tsquery('english', $1)
           ORDER BY score DESC LIMIT $2`,
          [query, limit],
        );
        return JSON.stringify({
          query,
          results: result.rows.map((r: any) => ({
            id: r.id,
            content: r.content?.slice(0, 500),
            role: r.role,
            score: parseFloat(r.score),
            date: r.created_at,
          })),
        });
      } catch (err: any) {
        console.error('[Voice] search_memories error:', err.message);
        return JSON.stringify({ error: `Search failed: ${err.message}` });
      }
    }

    if (name === 'get_recent_conversations') {
      if (!this.lcmPool) {
        return JSON.stringify({ error: 'Memory not configured (no postgresConnectionString)' });
      }
      try {
        const limit = args.limit ?? 20;
        const result = await this.lcmPool.query(
          `SELECT m.content, m.role, m.created_at, c.agent_id
           FROM messages m
           JOIN conversations c ON c.conversation_id = m.conversation_id
           ORDER BY m.created_at DESC
           LIMIT $1`,
          [limit],
        );
        return JSON.stringify({
          messages: result.rows.map((r: any) => ({
            role: r.role,
            content: r.content.slice(0, 500),
            agent: r.agent_id,
            createdAt: r.created_at,
          })),
        });
      } catch (err: any) {
        console.error('[Voice] get_recent_conversations error:', err.message);
        return JSON.stringify({ error: `Query failed: ${err.message}` });
      }
    }

    return JSON.stringify({ error: `Unknown function: ${name}` });
  }

  // -----------------------------------------------------------------------
  // Controls
  // -----------------------------------------------------------------------

  setVoice(voice: string): void {
    this.xai.updateSession(
      voice,
      this.config.instructions ??
        "You are Rivet, Phil's AI assistant. Keep responses concise.",
    );
  }

  getStatus(): string {
    const startTime = parseInt(this.sessionId.split('_')[1]);
    const minutes = Math.floor((Date.now() - startTime) / 60_000);
    return `Session: ${minutes}min | Active users: ${this.subscribedUsers.size} | xAI: ${this.xai.isReady() ? 'ready' : 'connecting'}`;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  destroy(): void {
    for (const [, stream] of this.opusStreams) {
      try { stream.destroy(); } catch {}
    }
    for (const [, decoder] of this.decoders) {
      try { decoder.destroy(); } catch {}
    }
    this.opusStreams.clear();
    this.decoders.clear();
    this.subscribedUsers.clear();

    this.transcript.finalize();
    this.xai.disconnect();
    this.audioPlayer.stop();
    this.connection.destroy();
    this.postgresPool?.end().catch(() => {});
  }
}
