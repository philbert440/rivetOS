/**
 * Voice proxy — the node fronts STT/TTS for RivetHub so clients never talk
 * to the model servers directly (no CORS surface, no upstream addresses in
 * the client, and the same mTLS gate as every other /api/* route).
 *
 *   POST /api/voice/transcribe   raw audio body (audio/wav | audio/webm | …)
 *   → 200 upstream JSON ({ text })
 *   POST /api/voice/speak        { input, instructions?, voice? }
 *   → 200 audio bytes, streamed through (upstream content-type)
 *
 * Upstreams are per-node env config (RIVETOS_DEN_VOICE_STT_URL /
 * RIVETOS_DEN_VOICE_TTS_URL — the RIVETOS_DEN_ prefix rides buildGatewayEnv's
 * prefix passthrough, so an embedded den actually sees them). An absent
 * upstream is a clean 501: voice is an optional per-node capability.
 *
 * STT is an OpenAI /v1/audio/transcriptions-compatible endpoint (multipart
 * `file` field). TTS is /v1/audio/speech-compatible; a voice-design model
 * NEEDS `instructions`, so a per-node default (RIVETOS_DEN_VOICE_TTS_
 * INSTRUCTIONS) applies whenever the request carries none (an explicit ""
 * does not override the default — absent and empty mean the same thing).
 *
 * Every request runs under ONE AbortController: a route deadline, the client
 * body read, and the upstream fetch all share it, and a client that
 * disconnects mid-flight (res 'close' before the response finished) aborts
 * the upstream work instead of leaving it running to the timeout. Upstream
 * responses are bounded too — a misconfigured upstream must not be able to
 * OOM den-server with a giant 200.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/** Mic clips, not albums: a minute of 48kHz/16-bit mono WAV is ~5.6MB. */
export const DEFAULT_VOICE_AUDIO_MAX_BYTES = 15 * 1024 * 1024

/** Spoken replies are short; a whole transcript does not belong in one call.
 *  Measured in BYTES of UTF-8, not characters — multi-byte text budgets the
 *  same as ASCII. */
export const VOICE_SPEAK_INPUT_MAX_BYTES = 4096

/** Transcription JSON for a 15MB clip is a few KB; 1MB is already absurd. */
export const STT_RESPONSE_MAX_BYTES = 1024 * 1024

/** Streamed-through cap for synthesized audio. */
export const TTS_RESPONSE_MAX_BYTES = 30 * 1024 * 1024

const STT_TIMEOUT_MS = 60_000
const TTS_TIMEOUT_MS = 120_000
const SPEAK_BODY_MAX_BYTES = 64 * 1024

/** Multipart part MIMEs we will state to the upstream. Anything else (or a
 *  value carrying quote/CR/LF header-injection characters) falls back to
 *  audio/wav — defense-in-depth; Node's parser blocks raw CRLF anyway. */
const AUDIO_MIME_ALLOWLIST = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
])

export interface VoiceRoutesOptions {
  /** Empty = transcribe answers 501. */
  sttUrl: string
  /** Empty = speak answers 501. */
  ttsUrl: string
  /** Default `instructions` when a speak request carries none. */
  ttsInstructions?: string
  maxAudioBytes?: number
  /** Test seams. */
  fetchImpl?: typeof fetch
  sttTimeoutMs?: number
  ttsTimeoutMs?: number
  maxTtsResponseBytes?: number
  log?: (msg: string) => void
}

export interface VoiceRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

function json(res: ServerResponse, status: number, body: unknown): boolean {
  if (res.writableEnded || res.destroyed) return true
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}

/** 413 with Connection: close, then destroy once the response has flushed —
 *  a body we refused cannot be drained for keep-alive reuse at these sizes. */
function jsonRefuseBody(req: IncomingMessage, res: ServerResponse, body: unknown): boolean {
  if (res.writableEnded || res.destroyed) return true
  res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
  res.end(JSON.stringify(body))
  res.once('finish', () => req.destroy())
  return true
}

type BoundedRead = Buffer | 'too-large' | 'aborted'

/** Bounded, settle-once body read. Counts actual bytes (never trusts
 *  Content-Length), pauses past the cap, resolves 'aborted' on client
 *  disconnect / abort signal, and detaches every listener on settle. */
function readBounded(req: IncomingMessage, cap: number, signal: AbortSignal): Promise<BoundedRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (value: BoundedRead): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > cap) {
        req.pause()
        settle('too-large')
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => settle(Buffer.concat(chunks))
    // 'close' before 'end' (which settles first on a normal body) or a
    // stream error both mean the client is gone.
    const onGone = (): void => settle('aborted')
    const onAbort = (): void => {
      settle('aborted')
      req.destroy()
    }
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onGone)
      req.off('close', onGone)
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) {
      settled = true
      resolve('aborted')
      return
    }
    signal.addEventListener('abort', onAbort)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onGone)
    req.on('close', onGone)
  })
}

/** readUpstreamBounded, with abort/stream failures folded into an outcome —
 *  an aborted fetch body throwing out of a handler must never become an
 *  unhandled rejection. */
async function readUpstreamSafe(
  upstream: Response,
  cap: number,
): Promise<Buffer | 'too-large' | 'failed'> {
  try {
    return await readUpstreamBounded(upstream, cap)
  } catch {
    return 'failed'
  }
}

/** Bounded read of an upstream Response body. */
async function readUpstreamBounded(upstream: Response, cap: number): Promise<Buffer | 'too-large'> {
  const body = upstream.body
  if (!body) {
    const buf = Buffer.from(await upstream.arrayBuffer())
    return buf.length > cap ? 'too-large' : buf
  }
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) {
      await reader.cancel().catch(() => undefined)
      return 'too-large'
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** Short, plain-text snippet of an upstream error body — never HTML, never
 *  unbounded, same string to the client and the log. */
function upstreamSnippet(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function sanitizeAudioMime(raw: string | undefined): string {
  if (!raw || /[\r\n"]/.test(raw)) return 'audio/wav'
  const mime = raw.split(';')[0].trim().toLowerCase()
  return AUDIO_MIME_ALLOWLIST.has(mime) ? mime : 'audio/wav'
}

function extFor(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('mpeg')) return 'mp3'
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
  const maxTtsResponse =
    opts.maxTtsResponseBytes && opts.maxTtsResponseBytes > 0
      ? opts.maxTtsResponseBytes
      : TTS_RESPONSE_MAX_BYTES
  const sttTimeout = opts.sttTimeoutMs ?? STT_TIMEOUT_MS
  const ttsTimeout = opts.ttsTimeoutMs ?? TTS_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((): void => undefined)

  const upstreamFail = (res: ServerResponse, route: string, detail: string): boolean => {
    const snippet = upstreamSnippet(detail)
    log(`[voice] ${route} upstream failed: ${snippet}`)
    return json(res, 502, { error: `voice upstream failed: ${snippet}` })
  }

  /** One deadline + one abort scope for read + upstream + write. The res
   *  'close' listener fires on client disconnect (writableEnded is still
   *  false then) — normal completion unhooks first. */
  const scoped = async (
    req: IncomingMessage,
    res: ServerResponse,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean> => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const onClose = (): void => {
      if (!res.writableEnded) ac.abort()
    }
    res.on('close', onClose)
    try {
      return await run(ac.signal)
    } finally {
      clearTimeout(timer)
      res.off('close', onClose)
    }
  }

  const transcribe = (req: IncomingMessage, res: ServerResponse): Promise<boolean> =>
    scoped(req, res, sttTimeout, async (signal) => {
      if (!sttUrl) {
        return json(res, 501, { error: 'voice transcription is not configured on this node' })
      }
      const audio = await readBounded(req, maxAudio, signal)
      if (audio === 'too-large') {
        return jsonRefuseBody(req, res, { error: `audio exceeds ${String(maxAudio)} bytes` })
      }
      if (audio === 'aborted') {
        res.destroy()
        return true
      }
      if (audio.length === 0) return json(res, 400, { error: 'empty audio body' })
      const mime = sanitizeAudioMime(req.headers['content-type'])
      const { body, contentType } = multipartFile('file', `audio.${extFor(mime)}`, mime, audio)
      let upstream: Response
      try {
        upstream = await fetchImpl(sttUrl, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: new Uint8Array(body),
          signal,
        })
      } catch (err) {
        return upstreamFail(res, 'transcribe', err instanceof Error ? err.message : String(err))
      }
      const raw = await readUpstreamSafe(upstream, STT_RESPONSE_MAX_BYTES)
      if (raw === 'failed') {
        if (signal.aborted) {
          res.destroy()
          return true
        }
        return upstreamFail(res, 'transcribe', 'upstream body unreadable')
      }
      if (raw === 'too-large') return upstreamFail(res, 'transcribe', 'oversized upstream response')
      const text = raw.toString('utf8')
      if (!upstream.ok) {
        return upstreamFail(res, 'transcribe', `upstream ${String(upstream.status)}: ${text}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return upstreamFail(res, 'transcribe', 'upstream returned non-JSON')
      }
      return json(res, 200, parsed)
    })

  const speak = (req: IncomingMessage, res: ServerResponse): Promise<boolean> =>
    scoped(req, res, ttsTimeout, async (signal) => {
      if (!ttsUrl) {
        return json(res, 501, { error: 'voice synthesis is not configured on this node' })
      }
      const raw = await readBounded(req, SPEAK_BODY_MAX_BYTES, signal)
      if (raw === 'too-large') return jsonRefuseBody(req, res, { error: 'speak body too large' })
      if (raw === 'aborted') {
        res.destroy()
        return true
      }
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
      if (Buffer.byteLength(body.input, 'utf8') > VOICE_SPEAK_INPUT_MAX_BYTES) {
        return json(res, 413, {
          error: `input exceeds ${String(VOICE_SPEAK_INPUT_MAX_BYTES)} UTF-8 bytes`,
        })
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
          signal,
        })
      } catch (err) {
        return upstreamFail(res, 'speak', err instanceof Error ? err.message : String(err))
      }
      if (!upstream.ok) {
        const errBody = await readUpstreamSafe(upstream, STT_RESPONSE_MAX_BYTES)
        if (errBody === 'failed') {
          if (signal.aborted) {
            res.destroy()
            return true
          }
          return upstreamFail(res, 'speak', 'upstream error body unreadable')
        }
        const detail =
          errBody === 'too-large' ? 'oversized upstream error' : errBody.toString('utf8')
        return upstreamFail(res, 'speak', `upstream ${String(upstream.status)}: ${detail}`)
      }
      // Stream through with a byte counter — audio goes out as it arrives,
      // nothing is buffered whole, and an over-cap upstream is cut off.
      const stream = upstream.body
      if (!stream) {
        const buf = await readUpstreamSafe(upstream, maxTtsResponse)
        if (buf === 'too-large') return upstreamFail(res, 'speak', 'oversized upstream response')
        if (buf === 'failed') {
          if (signal.aborted) {
            res.destroy()
            return true
          }
          return upstreamFail(res, 'speak', 'upstream body unreadable')
        }
        res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'audio/wav' })
        res.end(buf)
        return true
      }
      // CONTRACT past this writeHead: the 200 head is irrevocable, so every
      // failure — abort, over-cap, upstream stall, client gone — must
      // res.destroy(), never end(): a clean short body would look like a
      // complete (corrupt) audio file to the client.
      res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'audio/wav' })
      const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>
      // Abort can fire while we are parked on reader.read() (stalled
      // upstream) — destroy the response immediately so the client sees a
      // failed transfer without waiting for the read to return.
      const onPipeAbort = (): void => {
        res.destroy()
      }
      signal.addEventListener('abort', onPipeAbort, { once: true })
      let sent = 0
      try {
        for (;;) {
          let done: boolean
          let value: Uint8Array | undefined
          try {
            ;({ done, value } = await reader.read())
          } catch (err) {
            log(`[voice] speak stream failed: ${err instanceof Error ? err.message : String(err)}`)
            res.destroy()
            return true
          }
          if (signal.aborted) {
            await reader.cancel().catch(() => undefined)
            res.destroy()
            return true
          }
          if (done || !value) break
          sent += value.byteLength
          if (sent > maxTtsResponse) {
            log('[voice] speak upstream exceeded response cap — truncating')
            await reader.cancel().catch(() => undefined)
            res.destroy()
            return true
          }
          // Abortable drain: resolve false on abort so a stalled client
          // socket cannot park the handler past its deadline.
          const ok = await new Promise<boolean>((resolve) => {
            if (signal.aborted) {
              resolve(false)
              return
            }
            const onAbort = (): void => resolve(false)
            signal.addEventListener('abort', onAbort, { once: true })
            res.write(Buffer.from(value), (err) => {
              signal.removeEventListener('abort', onAbort)
              resolve(!err)
            })
          })
          if (!ok) {
            await reader.cancel().catch(() => undefined)
            res.destroy()
            return true
          }
        }
      } finally {
        signal.removeEventListener('abort', onPipeAbort)
      }
      res.end()
      return true
    })

  return {
    async handle(req, res, url): Promise<boolean> {
      if (req.method !== 'POST') return false
      if (url.pathname === '/api/voice/transcribe') return transcribe(req, res)
      if (url.pathname === '/api/voice/speak') return speak(req, res)
      return false
    },
  }
}
