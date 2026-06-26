/**
 * local-voice — STT/TTS/VAD helpers for the local (turn-based) voice path.
 *
 * No cloud. Talks only to the GERTY stack:
 *   STT  POST {sttUrl}  qwen3-asr   (/v1/chat/completions, input_audio wav base64)
 *   TTS  POST {ttsUrl}  qwen3-tts   (/v1/audio/speech, VoiceDesign) → WAV 24kHz mono 16-bit
 *
 * Audio contract with the rest of the plugin:
 *   - inbound mic PCM is 24kHz mono 16-bit LE (prism Opus decoder rate)
 *   - AudioPlayer.playAudio() wants 24kHz mono 16-bit LE PCM
 * So TTS output (24kHz mono 16-bit WAV) feeds AudioPlayer directly after header strip,
 * and STT input is downsampled 24k→16k in pure JS (no ffmpeg dependency).
 *
 * Node 22 (global fetch). Pure JS — no native deps beyond what the plugin already has.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LocalVoiceConfig {
  /** STT endpoint, e.g. http://<gerty-host>:9000/v1/chat/completions */
  sttUrl: string
  /** TTS endpoint, e.g. http://<gerty-host>:9001/v1/audio/speech */
  ttsUrl: string
  sttModel: string // 'qwen3-asr'
  ttsModel: string // 'qwen3-tts'
  /** VoiceDesign instruct — Rivet Local's chosen warm-male voice. */
  voiceInstruct: string
  /** TTS language tag (qwen3-tts), default 'English'. */
  language: string
  /** Sample rate of inbound mic PCM / TTS output PCM (24000). */
  sampleRate: number
}

// ---------------------------------------------------------------------------
// PCM / WAV utilities
// ---------------------------------------------------------------------------

/** Linear-resample mono 16-bit LE PCM from `inRate` to `outRate`. */
export function resamplePcm16(pcm: Buffer, inRate: number, outRate: number): Buffer {
  if (inRate === outRate) return pcm
  const inSamples = Math.floor(pcm.length / 2)
  const outSamples = Math.floor((inSamples * outRate) / inRate)
  const out = Buffer.alloc(outSamples * 2)
  const step = inRate / outRate
  for (let i = 0; i < outSamples; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, inSamples - 1)
    const frac = pos - i0
    const s0 = pcm.readInt16LE(i0 * 2)
    const s1 = pcm.readInt16LE(i1 * 2)
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2)
  }
  return out
}

/** Wrap mono 16-bit LE PCM in a minimal RIFF/WAVE container. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  const dataLen = pcm.length
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLen, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // audio format = PCM
  header.writeUInt16LE(1, 22) // channels = 1
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate (mono 16-bit)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(dataLen, 40)
  return Buffer.concat([header, pcm])
}

/** Extract raw PCM samples from a WAV buffer (finds the `data` chunk; tolerant of extra chunks). */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    // Not a WAV — assume it's already raw PCM.
    return wav
  }
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      return wav.subarray(offset + 8, offset + 8 + size)
    }
    offset += 8 + size + (size % 2) // chunks are word-aligned
  }
  return wav.subarray(44) // fallback: skip canonical header
}

// ---------------------------------------------------------------------------
// STT — utterance PCM (24kHz mono 16-bit) → transcript text
// ---------------------------------------------------------------------------

export async function transcribe(pcm24k: Buffer, cfg: LocalVoiceConfig): Promise<string> {
  const pcm16k = resamplePcm16(pcm24k, cfg.sampleRate, 16000)
  const wavB64 = pcmToWav(pcm16k, 16000).toString('base64')
  const body = {
    model: cfg.sttModel,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this audio verbatim. Output only the transcript.' },
          { type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } },
        ],
      },
    ],
  }
  const r = await fetch(cfg.sttUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    throw new Error(`STT ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return parseAsr(j.choices?.[0]?.message?.content ?? '')
}

/**
 * qwen3-asr wraps its output, e.g. `language English<asr_text>the transcript`
 * (sometimes with a closing `</asr_text>`). Pull out just the transcript.
 */
export function parseAsr(raw: string): string {
  let s = raw
  const open = s.indexOf('<asr_text>')
  if (open !== -1) s = s.slice(open + '<asr_text>'.length)
  const close = s.indexOf('</asr_text>')
  if (close !== -1) s = s.slice(0, close)
  // Fallback for the tagless form: strip a leading `language <Name>` prefix.
  s = s.replace(/^\s*language\s+\S+\s*/i, '')
  return s.trim()
}

// ---------------------------------------------------------------------------
// TTS — reply text → 24kHz mono 16-bit LE PCM (ready for AudioPlayer.playAudio)
// ---------------------------------------------------------------------------

export async function synthesize(text: string, cfg: LocalVoiceConfig): Promise<Buffer> {
  const payload = {
    model: cfg.ttsModel,
    input: text,
    task_type: 'VoiceDesign',
    instructions: cfg.voiceInstruct,
    language: cfg.language,
    response_format: 'wav',
  }
  const r = await fetch(cfg.ttsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) {
    throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  const wav = Buffer.from(await r.arrayBuffer())
  return wavToPcm(wav) // qwen3-tts returns 24kHz mono 16-bit — matches AudioPlayer input
}

/**
 * Split a reply into short TTS chunks. The qwen3-tts VoiceDesign model
 * truncates (early-stops) on long inputs, so we synthesize sentence/clause-
 * sized pieces and play them back-to-back. Splitting on sentence boundaries
 * first, then clauses, then words; each chunk capped at `maxLen` chars.
 */
export function chunkText(text: string, maxLen = 100): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter(Boolean)
  const out: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= maxLen) {
      out.push(sentence)
      continue
    }
    // Long sentence — break on clause punctuation, then accumulate words.
    let buf = ''
    const pieces = sentence.split(/(?<=[,;:—-])\s+/)
    for (const piece of pieces) {
      for (const word of piece.split(' ')) {
        if ((buf + ' ' + word).trim().length > maxLen) {
          if (buf) out.push(buf.trim())
          buf = word
        } else {
          buf = (buf + ' ' + word).trim()
        }
      }
    }
    if (buf) out.push(buf.trim())
  }
  return out
}

/**
 * Pull complete, speakable clauses out of a growing text buffer, leaving the
 * incomplete tail for the next call. Breaks on sentence enders (. ! ? …) always,
 * and on clause punctuation (, ; : —) once enough has accumulated, so we start
 * speaking early without emitting choppy two-word fragments. Boundaries must be
 * followed by whitespace/end (avoids splitting "3.5" or "e.g.").
 */
export function splitClauses(
  buf: string,
  minClauseChars = 30,
): { clauses: string[]; rest: string } {
  let lastBreak = -1
  let sinceBreak = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    const next = buf[i + 1]
    const atBoundary = next === undefined || next === ' ' || next === '\n'
    sinceBreak++
    if (!atBoundary) continue
    const sentenceEnd = c === '.' || c === '!' || c === '?' || c === '…'
    const clauseEnd = c === ',' || c === ';' || c === ':' || c === '—'
    if (sentenceEnd || (clauseEnd && sinceBreak >= minClauseChars)) {
      lastBreak = i
      sinceBreak = 0
    }
  }
  if (lastBreak === -1) return { clauses: [], rest: buf }
  const head = buf.slice(0, lastBreak + 1).trim()
  const rest = buf.slice(lastBreak + 1)
  return { clauses: head ? chunkText(head) : [], rest }
}

// ---------------------------------------------------------------------------
// Endpointer — silence-based VAD over the inbound PCM stream
// ---------------------------------------------------------------------------
//
// The Discord receiver is subscribed with EndBehaviorType.Manual, so it never
// signals end-of-speech. We detect it ourselves: accumulate frames while the
// user is speaking; once we've seen `silenceMs` of sub-threshold audio after
// real speech, emit the buffered utterance. A `minSpeechMs` guard suppresses
// stray blips. Barge-in detection (speech while the bot is talking) is exposed
// via onSpeechStart so the session can stop playback.

export interface EndpointerOpts {
  sampleRate: number
  silenceMs: number // trailing silence that ends an utterance (e.g. 1200)
  minSpeechMs: number // minimum voiced duration to count as an utterance (e.g. 350)
  rmsThreshold: number // 0..32767; samples below this are "silence" (e.g. 600)
  maxUtteranceMs: number // hard cap so a stuck stream still flushes (e.g. 30000)
}

export const DEFAULT_ENDPOINTER: Omit<EndpointerOpts, 'sampleRate'> = {
  silenceMs: 1200,
  minSpeechMs: 350,
  rmsThreshold: 600,
  maxUtteranceMs: 30000,
}

export class Endpointer {
  private opts: EndpointerOpts
  private bytesPerMs: number
  private chunks: Buffer[] = []
  private voicedBytes = 0
  private silenceBytes = 0
  private inUtterance = false

  /** Fired with the complete utterance PCM when end-of-speech is detected. */
  onUtterance: (pcm: Buffer) => void = () => {}
  /** Fired the moment voiced audio begins (for barge-in). */
  onSpeechStart: () => void = () => {}

  constructor(opts: EndpointerOpts) {
    this.opts = opts
    this.bytesPerMs = (opts.sampleRate * 2) / 1000 // mono 16-bit
  }

  /** Feed a decoded PCM frame (24kHz mono 16-bit LE). */
  push(frame: Buffer): void {
    const voiced = rms(frame) >= this.opts.rmsThreshold

    if (voiced) {
      if (!this.inUtterance) {
        this.inUtterance = true
        this.onSpeechStart()
      }
      this.chunks.push(frame)
      this.voicedBytes += frame.length
      this.silenceBytes = 0
    } else if (this.inUtterance) {
      // trailing silence — keep buffering so we don't clip word tails
      this.chunks.push(frame)
      this.silenceBytes += frame.length
      if (this.silenceBytes >= this.opts.silenceMs * this.bytesPerMs) {
        this.flush()
        return
      }
    }
    // else: pre-speech silence — drop it.

    const totalMs = (this.voicedBytes + this.silenceBytes) / this.bytesPerMs
    if (this.inUtterance && totalMs >= this.opts.maxUtteranceMs) this.flush()
  }

  /** Emit the buffered utterance if it cleared the minimum-speech bar, then reset. */
  flush(): void {
    const voicedMs = this.voicedBytes / this.bytesPerMs
    const pcm = Buffer.concat(this.chunks)
    this.reset()
    if (voicedMs >= this.opts.minSpeechMs && pcm.length > 0) {
      this.onUtterance(pcm)
    }
  }

  reset(): void {
    this.chunks = []
    this.voicedBytes = 0
    this.silenceBytes = 0
    this.inUtterance = false
  }
}

/** Root-mean-square amplitude of a mono 16-bit LE PCM frame. */
function rms(frame: Buffer): number {
  const n = Math.floor(frame.length / 2)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / n)
}
