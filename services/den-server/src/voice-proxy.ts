/**
 * Voice proxy — the node fronts STT/TTS for RivetHub so clients never talk
 * to the model servers directly (no CORS surface, no upstream addresses in
 * the client, and the same mTLS gate as every other /api/* route).
 *
 *   POST /api/voice/transcribe   raw audio body (audio/wav | audio/webm)
 *   → 200 upstream JSON ({ text })
 *   POST /api/voice/speak        { input, instructions?, voice? }
 *   → 200 audio bytes (upstream content-type, audio/wav in practice)
 *
 * Upstreams are per-node env config (RIVETOS_DEN_VOICE_STT_URL /
 * RIVETOS_DEN_VOICE_TTS_URL — the RIVETOS_DEN_ prefix rides buildGatewayEnv's
 * prefix passthrough, so an embedded den actually sees them). An absent
 * upstream is a clean 501: voice is an optional per-node capability.
 *
 * STT is an OpenAI /v1/audio/transcriptions-compatible endpoint (multipart
 * `file` field). TTS is /v1/audio/speech-compatible; a voice-design model
 * NEEDS `instructions`, so a per-node default (RIVETOS_DEN_VOICE_TTS_
 * INSTRUCTIONS) applies whenever the request carries none.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/** Mic clips, not albums: a minute of 48kHz/16-bit mono WAV is ~5.6MB. */
export const DEFAULT_VOICE_AUDIO_MAX_BYTES = 15 * 1024 * 1024

/** Spoken replies are short; a whole transcript does not belong in one call. */
export const VOICE_SPEAK_INPUT_MAX_CHARS = 4096

const STT_TIMEOUT_MS = 60_000
const TTS_TIMEOUT_MS = 120_000
const SPEAK_BODY_MAX_BYTES = 64 * 1024

export interface VoiceRoutesOptions {
  /** Empty = transcribe answers 501. */
  sttUrl: string
  /** Empty = speak answers 501. */
  ttsUrl: string
  /** Default `instructions` when a speak request carries none. */
  ttsInstructions?: string
  maxAudioBytes?: number
  /** Test seam. */
  fetchImpl?: typeof fetch
  log?: (msg: string) => void
}

export interface VoiceRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

function json(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}

/** Bounded body read. Destroys the socket past the cap — the client is
 *  mid-upload of something we will never accept. */
function readBounded(req: IncomingMessage, cap: number): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > cap) {
        req.removeAllListeners('data')
        req.removeAllListeners('end')
        resolve('too-large')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function extFor(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  return 'wav'
}

function multipartFile(
  field: string,
  filename: string,
  mime: string,
  bytes: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `----rivetos-voice-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ndefault\r\n--${boundary}--\r\n`,
    'utf8',
  )
  return {
    body: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

export function createVoiceRoutes(opts: VoiceRoutesOptions): VoiceRoutes {
  const sttUrl = opts.sttUrl.trim()
  const ttsUrl = opts.ttsUrl.trim()
  const defaultInstructions = opts.ttsInstructions?.trim() ?? ''
  const maxAudio =
    opts.maxAudioBytes && opts.maxAudioBytes > 0
      ? opts.maxAudioBytes
      : DEFAULT_VOICE_AUDIO_MAX_BYTES
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((): void => undefined)

  const upstreamFail = (res: ServerResponse, route: string, detail: string): boolean => {
    log(`[voice] ${route} upstream failed: ${detail}`)
    return json(res, 502, { error: `voice upstream failed: ${detail.slice(0, 500)}` })
  }

  const transcribe = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!sttUrl) {
      return json(res, 501, { error: 'voice transcription is not configured on this node' })
    }
    const audio = await readBounded(req, maxAudio)
    if (audio === 'too-large') {
      return json(res, 413, { error: `audio exceeds ${String(maxAudio)} bytes` })
    }
    if (audio.length === 0) return json(res, 400, { error: 'empty audio body' })
    const mime = (req.headers['content-type'] ?? 'audio/wav').split(';')[0].trim() || 'audio/wav'
    const { body, contentType } = multipartFile('file', `audio.${extFor(mime)}`, mime, audio)
    let upstream: Response
    try {
      upstream = await fetchImpl(sttUrl, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      })
    } catch (err) {
      return upstreamFail(res, 'transcribe', err instanceof Error ? err.message : String(err))
    }
    const text = await upstream.text().catch(() => '')
    if (!upstream.ok) return upstreamFail(res, 'transcribe', `${String(upstream.status)} ${text}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(text)
    return true
  }

  const speak = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!ttsUrl) {
      return json(res, 501, { error: 'voice synthesis is not configured on this node' })
    }
    const raw = await readBounded(req, SPEAK_BODY_MAX_BYTES)
    if (raw === 'too-large') return json(res, 413, { error: 'speak body too large' })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return json(res, 400, { error: 'speak body must be JSON' })
    }
    const body = (parsed ?? {}) as { input?: unknown; instructions?: unknown; voice?: unknown }
    if (typeof body.input !== 'string' || body.input.trim() === '') {
      return json(res, 400, { error: 'input required' })
    }
    if (body.input.length > VOICE_SPEAK_INPUT_MAX_CHARS) {
      return json(res, 413, { error: `input exceeds ${String(VOICE_SPEAK_INPUT_MAX_CHARS)} chars` })
    }
    const instructions =
      typeof body.instructions === 'string' && body.instructions.trim() !== ''
        ? body.instructions
        : defaultInstructions
    const payload: Record<string, string> = { input: body.input }
    if (instructions) payload.instructions = instructions
    if (typeof body.voice === 'string' && body.voice.trim() !== '') payload.voice = body.voice
    let upstream: Response
    try {
      upstream = await fetchImpl(ttsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      })
    } catch (err) {
      return upstreamFail(res, 'speak', err instanceof Error ? err.message : String(err))
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      return upstreamFail(res, 'speak', `${String(upstream.status)} ${text}`)
    }
    // Spoken replies are small (a sentence ≈ 100KB of WAV); buffering keeps
    // the fetch seam trivial to fake and sidesteps web-vs-node stream piping.
    const audio = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'audio/wav',
      'Content-Length': String(audio.length),
    })
    res.end(audio)
    return true
  }

  return {
    async handle(req, res, url): Promise<boolean> {
      if (req.method !== 'POST') return false
      if (url.pathname === '/api/voice/transcribe') return transcribe(req, res)
      if (url.pathname === '/api/voice/speak') return speak(req, res)
      return false
    },
  }
}
