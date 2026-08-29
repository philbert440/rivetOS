/**
 * /api/voice — proxy routing over a fake upstream fetch.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceRoutes, VOICE_SPEAK_INPUT_MAX_CHARS } from './voice-proxy.js'

const STT = 'http://192.0.2.60:9000/v1/audio/transcriptions'
const TTS = 'http://192.0.2.60:9001/v1/audio/speech'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function serve(routes: ReturnType<typeof createVoiceRoutes>): Promise<string> {
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

describe('/api/voice', () => {
  it('answers 501 when upstreams are not configured', async () => {
    const base = await serve(createVoiceRoutes({ sttUrl: '', ttsUrl: '' }))
    const t = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', body: 'x' })
    expect(t.status).toBe(501)
    const s = await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(s.status).toBe(501)
  })

  it('ignores non-POST and unknown voice paths', async () => {
    const base = await serve(createVoiceRoutes({ sttUrl: STT, ttsUrl: TTS }))
    expect((await fetch(`${base}/api/voice/transcribe`)).status).toBe(404)
    expect((await fetch(`${base}/api/voice/nope`, { method: 'POST' })).status).toBe(404)
  })

  it('transcribe forwards multipart and passes the upstream JSON through', async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(STT)
      const ct = (init?.headers as Record<string, string>)['content-type']
      expect(ct).toMatch(/^multipart\/form-data; boundary=/)
      const body = Buffer.from(init?.body as Uint8Array).toString('latin1')
      expect(body).toContain('name="file"; filename="audio.webm"')
      expect(body).toContain('Content-Type: audio/webm')
      expect(body).toContain('AUDIOBYTES')
      return jsonResponse(200, { text: 'hello world' })
    })
    const base = await serve(
      createVoiceRoutes({ sttUrl: STT, ttsUrl: '', fetchImpl: fetchImpl as typeof fetch }),
    )
    const res = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm;codecs=opus' },
      body: 'AUDIOBYTES',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello world' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('transcribe bounds the audio body', async () => {
    const fetchImpl = vi.fn()
    const base = await serve(
      createVoiceRoutes({
        sttUrl: STT,
        ttsUrl: '',
        maxAudioBytes: 8,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    )
    const big = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      body: 'way more than eight bytes',
    })
    expect(big.status).toBe(413)
    expect(fetchImpl).not.toHaveBeenCalled()
    const empty = await fetch(`${base}/api/voice/transcribe`, { method: 'POST' })
    expect(empty.status).toBe(400)
  })

  it('transcribe maps upstream failure and unreachable to 502', async () => {
    let mode: 'error' | 'throw' = 'error'
    const fetchImpl = vi.fn(async () => {
      if (mode === 'throw') throw new Error('connect ECONNREFUSED')
      return new Response('model exploded', { status: 500 })
    })
    const base = await serve(
      createVoiceRoutes({ sttUrl: STT, ttsUrl: '', fetchImpl: fetchImpl as typeof fetch }),
    )
    const upstream = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', body: 'x' })
    expect(upstream.status).toBe(502)
    expect(((await upstream.json()) as { error: string }).error).toContain('500 model exploded')
    mode = 'throw'
    const unreachable = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', body: 'x' })
    expect(unreachable.status).toBe(502)
  })

  it('speak validates the body', async () => {
    const fetchImpl = vi.fn()
    const base = await serve(
      createVoiceRoutes({ sttUrl: '', ttsUrl: TTS, fetchImpl: fetchImpl as unknown as typeof fetch }),
    )
    expect((await fetch(`${base}/api/voice/speak`, { method: 'POST', body: '{{' })).status).toBe(400)
    expect(
      (
        await fetch(`${base}/api/voice/speak`, {
          method: 'POST',
          body: JSON.stringify({ input: '' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${base}/api/voice/speak`, {
          method: 'POST',
          body: JSON.stringify({ input: 'x'.repeat(VOICE_SPEAK_INPUT_MAX_CHARS + 1) }),
        })
      ).status,
    ).toBe(413)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('speak applies the default instructions and lets explicit ones win', async () => {
    const payloads: unknown[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)))
      return new Response(Buffer.from('WAVBYTES'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      })
    })
    const base = await serve(
      createVoiceRoutes({
        sttUrl: '',
        ttsUrl: TTS,
        ttsInstructions: 'warm default voice',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    )
    const first = await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('audio/wav')
    expect(Buffer.from(await first.arrayBuffer()).toString()).toBe('WAVBYTES')
    await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      body: JSON.stringify({ input: 'hello', instructions: 'gravelly narrator', voice: 'eric' }),
    })
    expect(payloads[0]).toEqual({ input: 'hello', instructions: 'warm default voice' })
    expect(payloads[1]).toEqual({
      input: 'hello',
      instructions: 'gravelly narrator',
      voice: 'eric',
    })
  })

  it('speak maps upstream failure to 502', async () => {
    const fetchImpl = vi.fn(async () => new Response('tts down', { status: 503 }))
    const base = await serve(
      createVoiceRoutes({ sttUrl: '', ttsUrl: TTS, fetchImpl: fetchImpl as typeof fetch }),
    )
    const res = await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('503 tts down')
  })
})
