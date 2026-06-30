import { describe, it, expect, vi, afterEach } from 'vitest'
import { VllmProvider } from './index.js'

/** Build a fake /v1/models fetch response. */
function modelsResponse(data: Array<{ id: string; max_model_len?: number }>): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('vllm auto-discovery', () => {
  it('adopts the single served model when none is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(modelsResponse([{ id: 'qwen3.6-27b-int4', max_model_len: 32768 }])),
    )
    const p = new VllmProvider({ baseUrl: 'http://localhost:8000' })
    expect(p.getModel()).toBe('default') // placeholder before probe

    expect(await p.isAvailable()).toBe(true)
    expect(p.getModel()).toBe('qwen3.6-27b-int4')
    expect(p.getContextWindow()).toBe(32768)
  })

  it('picks the first model and keeps the others available when several are served', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        modelsResponse([
          { id: 'model-a', max_model_len: 8192 },
          { id: 'model-b', max_model_len: 4096 },
        ]),
      ),
    )
    const p = new VllmProvider({ baseUrl: 'http://localhost:8000' })
    await p.isAvailable()
    expect(p.getModel()).toBe('model-a')
    expect(p.getContextWindow()).toBe(8192)
  })

  it('never overrides an explicitly configured model or context window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(modelsResponse([{ id: 'served-model', max_model_len: 32768 }])),
    )
    const p = new VllmProvider({
      baseUrl: 'http://localhost:8000',
      model: 'my-pinned-model',
      contextWindow: 16384,
    })
    await p.isAvailable()
    expect(p.getModel()).toBe('my-pinned-model')
    expect(p.getContextWindow()).toBe(16384)
  })

  it('adopts max_model_len for the chosen model even when model is pinned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        modelsResponse([
          { id: 'other', max_model_len: 1000 },
          { id: 'pinned', max_model_len: 65536 },
        ]),
      ),
    )
    const p = new VllmProvider({ baseUrl: 'http://localhost:8000', model: 'pinned' })
    await p.isAvailable()
    expect(p.getContextWindow()).toBe(65536)
  })

  it('discovers only once across repeated probes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(modelsResponse([{ id: 'first', max_model_len: 100 }]))
      .mockResolvedValueOnce(modelsResponse([{ id: 'second', max_model_len: 200 }]))
    vi.stubGlobal('fetch', fetchMock)
    const p = new VllmProvider({ baseUrl: 'http://localhost:8000' })
    await p.isAvailable()
    await p.isAvailable()
    expect(p.getModel()).toBe('first') // not re-selected to 'second'
    expect(p.getContextWindow()).toBe(100)
  })
})

describe('vllm availability diagnostics', () => {
  it('returns false and warns on a connection failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const p = new VllmProvider({ baseUrl: 'http://localhost:8000' })
    expect(await p.isAvailable()).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot reach'))
  })

  it('returns false with an auth hint on 401', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 } as unknown as Response),
    )
    const p = new VllmProvider({ baseUrl: 'http://localhost:8000' })
    expect(await p.isAvailable()).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('api_key'))
  })

  it('fails availability when a pinned model is absent and verifyModelOnInit is set', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelsResponse([{ id: 'something-else' }])))
    const p = new VllmProvider({
      baseUrl: 'http://localhost:8000',
      model: 'expected-model',
      verifyModelOnInit: true,
    })
    expect(await p.isAvailable()).toBe(false)
  })
})
