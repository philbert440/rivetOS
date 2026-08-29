/**
 * /api/voice — proxy routing over a fake upstream fetch.
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createVoiceRoutes,
  VOICE_SPEAK_INPUT_MAX_BYTES,
  type VoiceRoutesOptions,
} from './voice-proxy.js'

const STT = 'http://192.0.2.60:9000/v1/audio/transcriptions'
const TTS = 'http://192.0.2.60:9001/v1/audio/speech'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function serve(opts: VoiceRoutesOptions): Promise<string> {
  const routes = createVoiceRoutes(opts)
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!(await routes.handle(req, res, url))) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      }
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => server.close(r)))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch stub that never settles until its signal aborts — including a
 *  signal that was ALREADY aborted when the stub is invoked (client destroy
 *  racing ahead of the fetch call must still be observable). */
function hungFetch(onAbort?: () => void): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const fail = (): void => {
        onAbort?.()
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }
      if (init?.signal?.aborted) {
        fail()
        return
      }
      init?.signal?.addEventListener('abort', fail, { once: true })
    })) as typeof fetch
}

/** Chunked-transfer POST (no Content-Length at all) — pins that the server
 *  counts actual bytes rather than trusting headers. The refused-body path
 *  responds 413 + Connection: close and then destroys the socket, so a
 *  client-side ECONNRESET AFTER the status arrived is the expected shape,
 *  not a failure. */
function postChunked(
  base: string,
  path: string,
  chunks: string[],
): Promise<{ status: number | undefined }> {
  const u = new URL(path, base)
  return new Promise((resolve, reject) => {
    let status: number | undefined
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'POST' },
      (res) => {
        status = res.statusCode
        res.resume()
        res.on('end', () => resolve({ status }))
        res.on('error', () => resolve({ status }))
      },
    )
    req.on('error', (err) => {
      if (status !== undefined) resolve({ status })
      else reject(err)
    })
    for (const c of chunks) req.write(c)
    req.end()
  })
}

describe('/api/voice', () => {
  it('answers 501 when upstreams are not configured', async () => {
    const base = await serve({ sttUrl: '', ttsUrl: '' })
    const t = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', body: 'x' })
    expect(t.status).toBe(501)
    const s = await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(s.status).toBe(501)
  })

  it('ignores non-POST and unknown voice paths', async () => {
    const base = await serve({ sttUrl: STT, ttsUrl: TTS })
    expect((await fetch(`${base}/api/voice/transcribe`)).status).toBe(404)
    expect((await fetch(`${base}/api/voice/nope`, { method: 'POST' })).status).toBe(404)
  })

  it('transcribe forwards exact multipart framing and parses the upstream JSON', async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(STT)
      const ct = (init?.headers as Record<string, string>)['content-type']
      const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(ct)?.[1]
      expect(boundary).toBeTruthy()
      const body = Buffer.from(init?.body as Uint8Array).toString('latin1')
      expect(body).toBe(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
          `Content-Type: audio/webm\r\n\r\n` +
          `AUDIOBYTES\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ndefault\r\n` +
          `--${boundary}--\r\n`,
      )
      return jsonResponse(200, { text: 'hello world' })
    })
    const base = await serve({ sttUrl: STT, ttsUrl: '', fetchImpl: fetchImpl as typeof fetch })
    const res = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm;codecs=opus' },
      body: 'AUDIOBYTES',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello world' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sanitizes a hostile client content-type to audio/wav', async () => {
    let part = ''
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      part = Buffer.from(init?.body as Uint8Array).toString('latin1')
      return jsonResponse(200, { text: 'ok' })
    })
    const base = await serve({ sttUrl: STT, ttsUrl: '', fetchImpl: fetchImpl as typeof fetch })
    const res = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm"; x="injected' },
      body: 'AUDIO',
    })
    expect(res.status).toBe(200)
    expect(part).toContain('filename="audio.wav"')
    expect(part).toContain('Content-Type: audio/wav\r\n')
    expect(part).not.toContain('injected')
    // Unlisted-but-benign types fall back too.
    await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'video/quicktime' },
      body: 'AUDIO',
    })
    expect(part).toContain('Content-Type: audio/wav\r\n')
  })

  it('counts body bytes (chunked, no Content-Length) against the cap', async () => {
    const fetchImpl = vi.fn()
    const base = await serve({
      sttUrl: STT,
      ttsUrl: '',
      maxAudioBytes: 8,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const big = await postChunked(base, '/api/voice/transcribe', ['fourby', 'tesmore', 'andmore'])
    expect(big.status).toBe(413)
    expect(fetchImpl).not.toHaveBeenCalled()
    const empty = await fetch(`${base}/api/voice/transcribe`, { method: 'POST' })
    expect(empty.status).toBe(400)
  })

  it('maps upstream failures to 502 with a truncated plain-text snippet', async () => {
    let body = '<html><body><h1>Bad Gateway</h1><p>secret internals</p></body></html>'
    let status = 500
    const fetchImpl = vi.fn(async () => new Response(body, { status }))
    const base = await serve({ sttUrl: STT, ttsUrl: '', fetchImpl: fetchImpl as typeof fetch })
    const html = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', body: 'x' })
    expect(html.status).toBe(502)
    const err = ((await html.json()) as { error: string }).error
    expect(err).not.toContain('<html>')
    expect(err).toContain('upstream 500')
    expect(err.length).toBeLessThan(240)
    // Non-JSON 200 is an upstream bug, not a client payload.
    body = 'plain text, not json'
    status = 200
    const nonJson = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', body: 'x' })
    expect(nonJson.status).toBe(502)
    expect(((await nonJson.json()) as { error: string }).error).toContain('non-JSON')
  })

  it('times out a hung upstream via the shared abort scope', async () => {
    const aborted = vi.fn()
    const base = await serve({
      sttUrl: STT,
      ttsUrl: '',
      sttTimeoutMs: 60,
      fetchImpl: hungFetch(aborted),
    })
    const res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(502)
    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('aborts the upstream when the client disconnects mid-flight', async () => {
    const aborted = vi.fn()
    const base = await serve({ sttUrl: STT, ttsUrl: '', fetchImpl: hungFetch(aborted) })
    const u = new URL(`${base}/api/voice/transcribe`)
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: u.hostname, port: u.port, path: u.pathname, method: 'POST' },
        () => undefined,
      )
      req.on('error', () => resolve()) // socket reset by our own destroy
      req.on('close', () => resolve())
      req.end('AUDIO', () => {
        // Body flushed; give the server a beat to enter the hung fetch (a
        // pre-fetch abort is equally valid — hungFetch observes both).
        setTimeout(() => {
          req.destroy()
          resolve()
        }, 100)
      })
      setTimeout(() => reject(new Error('client never settled')), 3000)
    })
    await vi.waitFor(() => expect(aborted).toHaveBeenCalledTimes(1), { timeout: 3000 })
  })

  it('destroys a half-written 200 when the abort scope fires mid-pipe', async () => {
    // One chunk arrives, then the upstream stalls forever — the route
    // deadline must cut the client connection (failed transfer), never
    // end() a clean-looking short body.
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('WAV-'))
        // never closes
      },
    })
    const fetchImpl = (async () =>
      new Response(stalled, {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      })) as unknown as typeof fetch
    const base = await serve({ sttUrl: '', ttsUrl: TTS, ttsTimeoutMs: 80, fetchImpl })
    const u = new URL(`${base}/api/voice/speak`)
    const outcome = await new Promise<{ status: number | undefined; clean: boolean }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            res.resume()
            res.on('error', () => resolve({ status: res.statusCode, clean: false }))
            res.on('aborted', () => resolve({ status: res.statusCode, clean: false }))
            res.on('end', () => resolve({ status: res.statusCode, clean: res.complete }))
          },
        )
        req.on('error', reject)
        req.end(JSON.stringify({ input: 'hi' }))
        setTimeout(() => reject(new Error('mid-pipe abort never surfaced')), 3000)
      },
    )
    expect(outcome.status).toBe(200)
    expect(outcome.clean).toBe(false)
  })

  it('speak validates the body, in UTF-8 bytes', async () => {
    const fetchImpl = vi.fn(async () => new Response('WAV', { status: 200 }))
    const base = await serve({
      sttUrl: '',
      ttsUrl: TTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect((await fetch(`${base}/api/voice/speak`, { method: 'POST', body: '{{' })).status).toBe(
      400,
    )
    expect(
      (
        await fetch(`${base}/api/voice/speak`, {
          method: 'POST',
          body: JSON.stringify({ input: '' }),
        })
      ).status,
    ).toBe(400)
    // 1366 × '嗨' = 4098 UTF-8 bytes but only 1366 characters — a char-count
    // check would wrongly accept it.
    const multiByte = '嗨'.repeat(Math.ceil((VOICE_SPEAK_INPUT_MAX_BYTES + 1) / 3))
    expect(Buffer.byteLength(multiByte, 'utf8')).toBeGreaterThan(VOICE_SPEAK_INPUT_MAX_BYTES)
    expect(
      (
        await fetch(`${base}/api/voice/speak`, {
          method: 'POST',
          body: JSON.stringify({ input: multiByte }),
        })
      ).status,
    ).toBe(413)
    // Exactly the cap is allowed.
    const exact = 'x'.repeat(VOICE_SPEAK_INPUT_MAX_BYTES)
    expect(
      (
        await fetch(`${base}/api/voice/speak`, {
          method: 'POST',
          body: JSON.stringify({ input: exact }),
        })
      ).status,
    ).toBe(200)
  })

  it('speak applies default instructions; explicit wins; empty string does NOT override', async () => {
    const payloads: unknown[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)))
      return new Response(Buffer.from('WAVBYTES'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      })
    })
    const base = await serve({
      sttUrl: '',
      ttsUrl: TTS,
      ttsInstructions: 'warm default voice',
      fetchImpl: fetchImpl as typeof fetch,
    })
    const speak = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/voice/speak`, { method: 'POST', body: JSON.stringify(body) })
    const first = await speak({ input: 'hello' })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('audio/wav')
    expect(Buffer.from(await first.arrayBuffer()).toString()).toBe('WAVBYTES')
    await speak({ input: 'hello', instructions: 'gravelly narrator', voice: 'eric' })
    await speak({ input: 'hello', instructions: '' })
    expect(payloads[0]).toEqual({ input: 'hello', instructions: 'warm default voice' })
    expect(payloads[1]).toEqual({
      input: 'hello',
      instructions: 'gravelly narrator',
      voice: 'eric',
    })
    expect(payloads[2]).toEqual({ input: 'hello', instructions: 'warm default voice' })
  })

  it('speak streams the upstream body through and enforces the response cap', async () => {
    const chunkedBody = (chunks: string[]): ReadableStream<Uint8Array> =>
      new ReadableStream({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(new TextEncoder().encode(c))
            await new Promise((r) => setTimeout(r, 5))
          }
          controller.close()
        },
      })
    const fetchImpl = vi.fn(async () => {
      return new Response(chunkedBody(['WAV-', 'PART-', 'END']), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      })
    })
    const base = await serve({ sttUrl: '', ttsUrl: TTS, fetchImpl: fetchImpl as typeof fetch })
    const ok = await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(ok.status).toBe(200)
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('WAV-PART-END')

    const capped = await serve({
      sttUrl: '',
      ttsUrl: TTS,
      maxTtsResponseBytes: 6,
      fetchImpl: fetchImpl as typeof fetch,
    })
    // Over-cap mid-stream: the 200 head is already gone, so the client sees a
    // truncated/reset body rather than a tidy error status.
    await expect(
      fetch(`${capped}/api/voice/speak`, {
        method: 'POST',
        body: JSON.stringify({ input: 'hi' }),
      }).then((r) => r.arrayBuffer()),
    ).rejects.toThrow()
  })

  it('speak maps upstream failure to 502', async () => {
    const fetchImpl = vi.fn(async () => new Response('tts down', { status: 503 }))
    const base = await serve({ sttUrl: '', ttsUrl: TTS, fetchImpl: fetchImpl as typeof fetch })
    const res = await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('upstream 503: tts down')
  })
})
