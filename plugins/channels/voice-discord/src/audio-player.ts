/**
 * Audio Player — Resamples xAI 24kHz mono PCM to Discord 48kHz stereo PCM.
 *
 * Uses a PassThrough stream to feed discord.js AudioPlayer with
 * continuous audio data. Each response creates a new stream;
 * endResponse() closes it cleanly so the player transitions to idle.
 */

import {
  AudioPlayer as DJSAudioPlayer,
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
} from '@discordjs/voice'
import { PassThrough } from 'node:stream'

export class AudioPlayer {
  private player: DJSAudioPlayer
  private currentStream: PassThrough | null = null
  private isPlaying = false

  constructor() {
    this.player = new DJSAudioPlayer()

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false
      this.currentStream = null
    })

    this.player.on('error', (error) => {
      console.error('[Player]', error.message)
      this.isPlaying = false
      this.currentStream = null
    })
  }

  /**
   * Resample 24kHz mono PCM16 → 48kHz stereo PCM16 for Discord.
   * Each input sample becomes 4 output samples (2x rate × 2 channels).
   */
  private resample(input: Buffer): Buffer {
    const samples = input.length / 2
    const output = Buffer.alloc(samples * 8)
    for (let i = 0; i < samples; i++) {
      const s = input.readInt16LE(i * 2)
      const o = i * 8
      output.writeInt16LE(s, o) // left sample 1
      output.writeInt16LE(s, o + 2) // right sample 1
      output.writeInt16LE(s, o + 4) // left sample 2 (2x rate)
      output.writeInt16LE(s, o + 6) // right sample 2
    }
    return output
  }

  private startStream(): void {
    this.currentStream = new PassThrough()
    const resource = createAudioResource(this.currentStream, {
      inputType: StreamType.Raw,
      inlineVolume: false,
    })
    this.player.play(resource)
    this.isPlaying = true
  }

  playAudio(pcm: Buffer): void {
    const resampled = this.resample(pcm)
    if (!this.currentStream || !this.isPlaying) {
      this.startStream()
    }
    this.currentStream!.write(resampled)
  }

  endResponse(): void {
    if (this.currentStream) {
      this.currentStream.end()
      this.currentStream = null
    }
  }

  stop(): void {
    this.player.stop()
    this.currentStream?.end()
    this.currentStream = null
    this.isPlaying = false
  }

  getPlayer(): DJSAudioPlayer {
    return this.player
  }
}
