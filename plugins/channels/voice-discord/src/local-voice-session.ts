/**
 * LocalVoiceSession — turn-based voice session backed by the local GERTY stack.
 *
 * Parallel to VoiceSession (which is xAI/Gemini realtime). The local models are
 * request/response, so this session does its own silence-VAD per speaker, runs
 * STT, hands the transcript to the runtime turn pipeline (via the plugin's
 * Channel adapter → the real `local` agent), and speaks the agent's reply.
 *
 * Audio in:  Discord Opus → prism decode → PCM 24kHz mono 16-bit → Endpointer.
 * Audio out: synthesize() PCM 24kHz mono 16-bit → AudioPlayer (→ 48kHz stereo).
 *
 * Speaking is driven externally by the plugin (speak()), invoked from a
 * turn:after hook with the agent's final response — NOT from streaming, so we
 * never voice partial chunks or tool logs.
 */

import { type VoiceConnection, EndBehaviorType } from '@discordjs/voice'
import type { Readable, Transform } from 'node:stream'
import { AudioPlayer } from './audio-player.js'
import { TranscriptLogger } from './transcript.js'
import {
  transcribe,
  synthesize,
  chunkText,
  Endpointer,
  DEFAULT_ENDPOINTER,
  type LocalVoiceConfig,
} from './local-voice.js'

interface OpusDecoder extends Transform {
  destroy(error?: Error): this
}
interface PrismMedia {
  opus: {
    Decoder: new (opts: { rate: number; channels: number; frameSize: number }) => OpusDecoder
  }
}

export interface LocalSessionCallbacks {
  /** A complete user utterance was transcribed — hand it to the agent. */
  onUserUtterance: (userId: string, text: string) => void
}

export class LocalVoiceSession {
  readonly channelId: string
  private connection: VoiceConnection
  private cfg: LocalVoiceConfig
  private allowedUsers: string[]
  private silenceMs: number
  private callbacks: LocalSessionCallbacks

  private audioPlayer: AudioPlayer
  private transcript: TranscriptLogger
  private sessionId: string

  private subscribed = new Set<string>()
  private opusStreams = new Map<string, Readable>()
  private decoders = new Map<string, OpusDecoder>()
  private endpointers = new Map<string, Endpointer>()
  private audioReady = false
  private speaking = false

  constructor(
    connection: VoiceConnection,
    opts: {
      local: LocalVoiceConfig
      allowedUsers: string[]
      silenceDurationMs?: number
      transcriptDir?: string
    },
    callbacks: LocalSessionCallbacks,
  ) {
    this.connection = connection
    this.cfg = opts.local
    this.allowedUsers = opts.allowedUsers
    this.silenceMs = opts.silenceDurationMs ?? DEFAULT_ENDPOINTER.silenceMs
    this.callbacks = callbacks
    this.channelId = connection.joinConfig.channelId ?? ''
    this.sessionId = `session_${Date.now()}`

    this.transcript = new TranscriptLogger(
      this.sessionId,
      opts.transcriptDir ?? 'transcripts',
      'Rivet Local (voice)',
    )

    this.audioPlayer = new AudioPlayer()
    this.connection.subscribe(this.audioPlayer.getPlayer())

    // DAVE E2EE transition — wait for key exchange before subscribing to audio.
    ;(this.connection as NodeJS.EventEmitter).on('transitioned', () => {
      if (!this.audioReady) {
        console.info('[LocalVoice] DAVE transition complete — audio ready')
        this.audioReady = true
        this.startListening()
      }
    })
    setTimeout(() => {
      if (!this.audioReady) {
        console.info('[LocalVoice] DAVE timeout — starting audio listener')
        this.audioReady = true
        this.startListening()
      }
    }, 5000)
  }

  // -----------------------------------------------------------------------
  // Listening / VAD
  // -----------------------------------------------------------------------

  private startListening(): void {
    this.connection.receiver.speaking.on('start', (userId: string) => {
      if (!this.allowedUsers.includes(userId)) return
      if (this.subscribed.has(userId)) return
      this.subscribed.add(userId)
      this.subscribeToUser(userId)
    })
  }

  private subscribeToUser(userId: string): void {
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    })

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const prism = require('prism-media') as PrismMedia
    const decoder = new prism.opus.Decoder({
      rate: this.cfg.sampleRate,
      channels: 1,
      frameSize: 960,
    })

    const endpointer = new Endpointer({
      sampleRate: this.cfg.sampleRate,
      silenceMs: this.silenceMs,
      minSpeechMs: DEFAULT_ENDPOINTER.minSpeechMs,
      rmsThreshold: DEFAULT_ENDPOINTER.rmsThreshold,
      maxUtteranceMs: DEFAULT_ENDPOINTER.maxUtteranceMs,
    })
    endpointer.onSpeechStart = () => {
      // Barge-in: if the user starts talking while we're speaking, stop playback.
      if (this.speaking) {
        this.audioPlayer.stop()
        this.speaking = false
      }
    }
    endpointer.onUtterance = (pcm) => {
      void this.handleUtterance(userId, pcm)
    }

    this.opusStreams.set(userId, opusStream)
    this.decoders.set(userId, decoder)
    this.endpointers.set(userId, endpointer)

    opusStream.pipe(decoder)
    decoder.on('data', (pcm: Buffer) => endpointer.push(pcm))
    decoder.on('error', (err: Error) => console.warn(`[LocalVoice] decode: ${err.message}`))
    opusStream.on('error', (err: Error) => console.warn(`[LocalVoice] opus: ${err.message}`))
    opusStream.on('end', () => {
      endpointer.flush()
      this.subscribed.delete(userId)
      this.opusStreams.delete(userId)
      this.decoders.delete(userId)
      this.endpointers.delete(userId)
    })
  }

  private async handleUtterance(userId: string, pcm: Buffer): Promise<void> {
    try {
      const text = await transcribe(pcm, this.cfg)
      if (!text || text.length < 2) return
      console.info(`[LocalVoice] [${userId}] "${text}"`)
      this.transcript.addMessage('Phil', text)
      this.callbacks.onUserUtterance(userId, text)
    } catch (err: unknown) {
      console.error(`[LocalVoice] STT failed: ${(err as Error).message}`)
    }
  }

  // -----------------------------------------------------------------------
  // Speaking — called by the plugin from the turn:after hook
  // -----------------------------------------------------------------------

  async speak(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean) return
    this.transcript.addMessage('Rivet', clean)

    // qwen3-tts truncates long inputs, so synthesize sentence/clause-sized
    // chunks and play them back-to-back. Prefetch the next chunk while the
    // current one is being written to keep playback gap-free, and lower
    // time-to-first-audio (we start speaking after just the first chunk).
    const chunks = chunkText(clean)
    if (chunks.length === 0) return
    try {
      this.speaking = true
      let next: Promise<Buffer> = synthesize(chunks[0], this.cfg)
      for (let i = 0; i < chunks.length; i++) {
        const pcm = await next
        if (i + 1 < chunks.length) next = synthesize(chunks[i + 1], this.cfg)
        if (!this.speaking) break // barge-in cancelled playback
        this.audioPlayer.playAudio(pcm)
      }
      this.audioPlayer.endResponse()
    } catch (err: unknown) {
      console.error(`[LocalVoice] TTS failed: ${(err as Error).message}`)
    } finally {
      this.speaking = false
    }
  }

  getStatus(): string {
    const start = parseInt(this.sessionId.split('_')[1])
    const minutes = Math.floor((Date.now() - start) / 60_000)
    return `Local voice: ${minutes}min | speakers: ${this.subscribed.size} | GERTY ${this.cfg.sttUrl.replace(/^https?:\/\//, '').split('/')[0]}`
  }

  // setVoice is a no-op for local (voice is fixed by VoiceDesign instruct), kept
  // for interface parity with the slash-command handler.
  setVoice(_name: string): void {
    /* local voice is the VoiceDesign instruct; nothing to switch */
  }

  destroy(): void {
    for (const [, stream] of this.opusStreams) {
      try {
        stream.destroy()
      } catch {
        /* ignore */
      }
    }
    for (const [, decoder] of this.decoders) {
      try {
        decoder.destroy()
      } catch {
        /* ignore */
      }
    }
    this.opusStreams.clear()
    this.decoders.clear()
    this.endpointers.clear()
    this.subscribed.clear()
    this.transcript.finalize()
    this.audioPlayer.stop()
    this.connection.destroy()
  }
}
