import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayError, request, RivetGateway } from './index.js'

afterEach(() => vi.unstubAllGlobals())

describe.each([true, false])('fetch injection enabled: %s', (injected) => {
  function fixture() {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const fallback = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', injected ? fallback : fetch)
    const config = { baseUrl: 'https://den.test', ...(injected ? { fetch } : {}) }
    return { fetch, fallback, config, client: new RivetGateway(config) }
  }

  it('selects fetch for request', async () => {
    const { fetch, fallback, config } = fixture()
    fetch.mockResolvedValue(Response.json({ ok: true }))
    expect(await request(config, '/test')).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('selects fetch for file reads', async () => {
    const { fetch, fallback, client } = fixture()
    fetch.mockResolvedValue(new Response('contents'))
    expect(await client.filesReadText('notes.md')).toBe('contents')
    expect(fetch).toHaveBeenCalledWith(
      'https://den.test/api/files/download?path=notes.md',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fallback).not.toHaveBeenCalled()
  })

  it('selects fetch for all raw-body endpoints', async () => {
    const { fetch, fallback, client } = fixture()
    fetch.mockImplementation(async () => Response.json({ ok: true }))
    const bytes = new ArrayBuffer(2)
    await client.filesUpload('/', 'a', bytes)
    await client.stageUpload('a', bytes)
    await client.voiceTranscribe(bytes, 'audio/wav')
    await client.voiceSpeak({ text: 'hello' })
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/files/upload',
      '/api/uploads',
      '/api/voice/transcribe',
      '/api/voice/speak',
    ])
    expect(fetch.mock.calls.every(([, opts]) => opts?.method === 'POST')).toBe(true)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('selects fetch for health probes', async () => {
    const { fetch, fallback, client } = fixture()
    fetch.mockResolvedValue(Response.json({ ok: true }))
    expect(await client.health()).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, opts] = fetch.mock.calls[0]
    expect(String(url)).toMatch(/\/healthz$/)
    expect(opts?.method).toBe('GET')
    expect(
      Object.keys(opts?.headers ?? {}).some((name) => name.toLowerCase() === 'authorization'),
    ).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
  })
})

describe('request abort reason', () => {
  it('rethrows a TimeoutError signal reason instead of gateway unreachable', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Delegation deadline exceeded', 'TimeoutError')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort(reason)
      throw new TypeError('fetch failed')
    })
    await expect(
      request({ baseUrl: 'https://den.test', fetch }, '/api/tasks/t/wait', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason)
  })

  it('rethrows the signal reason when fetch rejects with a plain AbortError', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Delegation deadline exceeded', 'TimeoutError')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort(reason)
      throw new DOMException('This operation was aborted', 'AbortError')
    })
    await expect(
      request({ baseUrl: 'https://den.test', fetch }, '/api/tasks/t/wait', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason)
  })

  it('still rethrows a plain AbortError when the signal is not aborted', async () => {
    const abort = new DOMException('cancelled', 'AbortError')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw abort
    })
    await expect(request({ baseUrl: 'https://den.test', fetch }, '/t')).rejects.toBe(abort)
  })

  it('wraps a non-abort fetch failure as gateway unreachable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    const err = await request({ baseUrl: 'https://den.test', fetch }, '/t').catch(
      (caught: unknown) => caught,
    )
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ status: 0 })
  })
})
