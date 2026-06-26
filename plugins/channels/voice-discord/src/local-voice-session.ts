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
  /** The user started speaking (barge-in signal — used to interrupt the turn). */
  onSpeechStart: (userId: string) => void
}

export class LocalVoiceSession {
  readonly channelId: string
  private connection: VoiceConnection
  private cfg: LocalVoiceConfig
  /** Active CustomVoice speaker; switchable live via setVoice (/voice command). */
  private speaker?: string
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
  // Streaming speech queue: clauses are enqueued as the agent generates them
  // and synthesized/played in order. clearSpeech() (barge-in) drains it.
  private speechQueue: string[] = []
  private draining = false
  private cancelled = false

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
    this.speaker = opts.local.speaker
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
      // Barge-in: the user started talking. Stop our audio immediately (don't
      // wait for the agent round-trip), and signal the plugin so it can abort
      // the active turn via /interrupt.
      if (this.draining || this.speechQueue.length > 0) this.clearSpeech()
      this.callbacks.onSpeechStart(userId)
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

  /** True while audio is queued or playing (used for barge-in / interrupt detection). */
  isSpeaking(): boolean {
    return this.draining || this.speechQueue.length > 0
  }

  /**
   * Enqueue a clause for speech. Clauses arrive as the agent streams its reply,
   * so the first one starts playing within ~1s of generation instead of after
   * the whole turn. A single drainer synthesizes + plays them in order.
   */
  enqueueSpeech(clause: string): void {
    const c = clause.trim()
    if (!c) return
    this.transcript.addMessage('Rivet', c)
    this.cancelled = false
    this.speechQueue.push(c)
    if (!this.draining) void this.drainSpeech()
  }

  private async drainSpeech(): Promise<void> {
    this.draining = true
    try {
      // Prefetch the next chunk's audio while the current one plays — gap-free.
      let next: Promise<Buffer> | null = this.speechQueue.length
        ? synthesize(this.speechQueue[0], this.cfg, this.speaker)
        : null
      while (this.speechQueue.length && !this.cancelled) {
        this.speechQueue.shift()
        const pcm = await (next as Promise<Buffer>)
        next = this.speechQueue.length
          ? synthesize(this.speechQueue[0], this.cfg, this.speaker)
          : null
        if (this.cancelled) break
        this.audioPlayer.playAudio(pcm)
      }
    } catch (err: unknown) {
      console.error(`[LocalVoice] TTS failed: ${(err as Error).message}`)
    } finally {
      this.draining = false
      if (!this.cancelled) this.audioPlayer.endResponse()
    }
  }

  /** Barge-in / interrupt: drop queued speech and stop playback immediately. */
  clearSpeech(): void {
    this.cancelled = true
    this.speechQueue = []
    this.audioPlayer.stop()
  }

  getStatus(): string {
    const start = parseInt(this.sessionId.split('_')[1])
    const minutes = Math.floor((Date.now() - start) / 60_000)
    return `Local voice: ${minutes}min | speakers: ${this.subscribed.size} | GERTY ${this.cfg.sttUrl.replace(/^https?:\/\//, '').split('/')[0]}`
  }

  /** Switch the live CustomVoice speaker (e.g. /voice anna). Takes effect on the
   *  next reply. An empty name reverts to VoiceDesign (no preset). */
  setVoice(name: string): void {
    this.speaker = name.trim() || undefined
    console.info(`[LocalVoice] speaker -> ${this.speaker ?? 'VoiceDesign'}`)
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
