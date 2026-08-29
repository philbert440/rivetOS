/**
 * Voice for the Hub — mic → node ASR, and reply text → node TTS.
 *
 * Both halves ride the den voice proxy (/api/voice/*), which 501s when the
 * node has no RIVETOS_DEN_VOICE_* endpoints configured — surfaced here as a
 * human-readable message, distinct from "this shell has no microphone".
 *
 * Capture: MediaRecorder (whatever mime the UA picks), decoded with
 * WebAudio, downmixed to mono and resampled to 16 kHz, encoded as WAV PCM16
 * client-side — the ASR side then never depends on browser codec support.
 * navigator.mediaDevices does not exist in insecure contexts; the desktop
 * shell restores it for the bundle origin, but every entry point here still
 * has to cope with it being undefined (older shells, LAN browsers).
 */

import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'

export const VOICE_NOT_CONFIGURED = 'voice is not configured on this node'
export const MIC_UNAVAILABLE = 'microphone unavailable in this shell/browser'

const ASR_SAMPLE_RATE = 16_000
/** TTS input cap — long transcripts get their head spoken, not an error. */
const SPEAK_MAX_CHARS = 1200

export function voiceInputSupported(): boolean {
  // The DOM types promise mediaDevices unconditionally; insecure contexts
  // (plain-http LAN, older shells without the origin switch) break that
  // promise at runtime — the guards are load-bearing despite the types.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined
}

function friendly(err: unknown): Error {
  if (err instanceof GatewayError && err.status === 501) return new Error(VOICE_NOT_CONFIGURED)
  return err instanceof Error ? err : new Error(String(err))
}

/** Mono float samples → WAV (PCM16 little-endian). Pure; unit-tested. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits
  ascii(36, 'data')
  v.setUint32(40, dataBytes, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return buf
}

/** Downmix to mono + linear-resample to the ASR rate. Exported for tests —
 *  the browser-audio path can't run under vitest, but the resample math must
 *  be pinned (the AudioBuffer shape is structural). */
export function monoResample(
  decoded: Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'sampleRate' | 'getChannelData'>,
  targetRate: number,
): Float32Array {
  if (decoded.length === 0) return new Float32Array(0)
  const channels = decoded.numberOfChannels
  const src = new Float32Array(decoded.length)
  for (let c = 0; c < channels; c++) {
    const ch = decoded.getChannelData(c)
    for (let i = 0; i < ch.length; i++) src[i] += ch[i] / channels
  }
  if (decoded.sampleRate === targetRate) return src
  const outLen = Math.max(1, Math.round((src.length * targetRate) / decoded.sampleRate))
  const out = new Float32Array(outLen)
  const step = src.length / outLen
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(src.length - 1, i0 + 1)
    out[i] = src[i0] + (src[i1] - src[i0]) * (pos - i0)
  }
  return out
}

export interface ActiveRecording {
  /** Stop capture, transcribe, resolve the text ('' when nothing was heard). */
  finish(): Promise<string>
  /** Stop capture and throw the clip away. */
  cancel(): void
}

/** Start mic capture. The caller renders the recording state and calls
 *  finish() (toggle) — or cancel() on unmount/escape. */
export async function startRecording(): Promise<ActiveRecording> {
  if (!voiceInputSupported()) throw new Error(MIC_UNAVAILABLE)
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: true })
    .catch((err: unknown) => {
      throw new Error(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'microphone permission denied'
          : MIC_UNAVAILABLE,
      )
    })
  const releaseMic = (): void => stream.getTracks().forEach((t) => t.stop())
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream)
    recorder.start()
  } catch (err) {
    // Construct/start can throw (unsupported mime, backend failure) — the
    // tracks must not stay hot behind a dead recorder.
    releaseMic()
    throw err instanceof Error ? err : new Error(MIC_UNAVAILABLE)
  }
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  // Read through a call, not a narrowed binding: cancel() flips this from
  // another task mid-await, which TS control-flow cannot see.
  let cancelled = false
  const isCancelled = (): boolean => cancelled

  const stopCapture = (): void => {
    try {
      recorder.stop()
    } catch {
      /* already stopped (cancel then finish, or double-stop) */
    }
    releaseMic()
  }

  return {
    cancel: () => {
      cancelled = true
      stopCapture()
    },
    finish: async () => {
      stopCapture()
      await stopped
      // A cancel() that raced this finish wins: the clip was discarded and
      // must never leave the device.
      if (isCancelled()) return ''
      const clip = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      if (clip.size === 0) return ''
      const ctx = new AudioContext()
      try {
        const decoded = await ctx.decodeAudioData(await clip.arrayBuffer())
        if (isCancelled()) return ''
        const wav = encodeWavPcm16(monoResample(decoded, ASR_SAMPLE_RATE), ASR_SAMPLE_RATE)
        const gw = useConnection.getState().gateway
        const res = await gw.voiceTranscribe(wav, 'audio/wav').catch((err: unknown) => {
          throw friendly(err)
        })
        return isCancelled() ? '' : res.text.trim()
      } finally {
        void ctx.close().catch(() => undefined)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Speaking — one shared player so a new speak stops the previous one.

let player: HTMLAudioElement | undefined
let playerUrl: string | undefined
let currentKey: string | undefined
const speakListeners = new Set<(speaking: boolean) => void>()

function notifySpeaking(on: boolean): void {
  for (const fn of speakListeners) fn(on)
}

/** The key of the clip currently playing (undefined when silent) — lets a
 *  per-message button render play vs stop for ITS text. */
export function speakingKey(): string | undefined {
  return currentKey
}

export function onSpeakingChange(fn: (speaking: boolean) => void): () => void {
  speakListeners.add(fn)
  return () => speakListeners.delete(fn)
}

export function stopSpeaking(): void {
  if (player) {
    player.pause()
    player.src = ''
  }
  if (playerUrl) {
    URL.revokeObjectURL(playerUrl)
    playerUrl = undefined
  }
  currentKey = undefined
  notifySpeaking(false)
}

/** Markdown → plain speakable text. Pure; unit-tested. */
export function stripForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Monotonic speak generation: a slower EARLIER request must never preempt
 *  a newer clip, and an interrupted play()'s rejection must not stop its
 *  successor. Only the newest generation touches the shared player. */
let speakGen = 0

/** Speak text via the node TTS. Replaces any current playback. `key`
 *  identifies the clip for speakingKey() (per-message play/stop buttons). */
export async function speak(text: string, key?: string): Promise<void> {
  const plain = stripForSpeech(text).slice(0, SPEAK_MAX_CHARS)
  if (!plain) return
  const gen = ++speakGen
  stopSpeaking()
  const gw = useConnection.getState().gateway
  const audio = await gw.voiceSpeak({ input: plain }).catch((err: unknown) => {
    throw friendly(err)
  })
  // Superseded while fetching — drop this clip without touching the player
  // (the newer generation owns it now).
  if (gen !== speakGen) return
  stopSpeaking()
  const url = URL.createObjectURL(new Blob([audio], { type: 'audio/wav' }))
  playerUrl = url
  currentKey = key ?? plain
  player = player ?? new Audio()
  player.src = url
  player.onended = () => {
    if (gen === speakGen) stopSpeaking()
  }
  player.onerror = () => {
    if (gen === speakGen) stopSpeaking()
  }
  notifySpeaking(true)
  await player.play().catch(() => {
    // Interrupting src rejects the PREVIOUS play(); only the current
    // generation may tear down on a genuine playback failure.
    if (gen === speakGen) stopSpeaking()
  })
}

// ---------------------------------------------------------------------------
// Auto-speak — per-browser toggle; speaks each newly completed assistant turn.

const AUTO_SPEAK_KEY = 'rivethub.voice.autoSpeak'

export function getAutoSpeak(): boolean {
  try {
    return localStorage.getItem(AUTO_SPEAK_KEY) === '1'
  } catch {
    return false
  }
}

export function setAutoSpeak(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_SPEAK_KEY, '1')
    else localStorage.removeItem(AUTO_SPEAK_KEY)
  } catch {
    /* storage unavailable — session-only toggle */
  }
  if (!on) stopSpeaking()
}
