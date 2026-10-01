/**
 * callLlm error-fidelity tests — network / HTTP / empty failures must surface
 * as LlmCallError with actionable messages (not a collapsed "empty" null).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./config.js', () => ({
  config: {
    llmUrl: 'http://llm.test:8003/v1',
    llmModel: 'test-model',
    llmApiKey: '',
    llmTransientStatuses: [] as number[],
    llmFallbacks: [] as Array<{ url: string; model: string; apiKey: string }>,
    llmFallbackCooldownMs: 60_000,
  },
}))

// Mock memory-postgres constants so retries are fast.
vi.mock('@rivetos/memory-postgres', () => ({
  LLM_TIMEOUT_MS: 5_000,
  LLM_TEMPERATURE: 0.3,
  LLM_RETRIES: 1,
  LLM_RETRY_BACKOFF_MS: 1,
}))

const fetchMock = vi.fn()
vi.mock('undici', () => ({
  Agent: class {
    constructor(_opts: unknown) {}
  },
  fetch: (...args: unknown[]) => fetchMock(...args),
}))

import { callLlm, callLlmDetailed, LlmCallError, resetLlmFailover } from './llm.js'
import { config } from './config.js'

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response
}

describe('callLlm', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    config.llmTransientStatuses = []
    config.llmFallbacks = []
    resetLlmFailover()
  })

  it('returns content on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'hello summary text here' } }],
      }),
    )
    await expect(callLlm('sys', 'user', 100)).resolves.toBe('hello summary text here')
  })

  it('throws LlmCallError with URL on network failure (not empty)', async () => {
    const netErr = new Error('fetch failed')
    // undici attaches the connect error as cause
    ;(netErr as Error & { cause: Error }).cause = new Error('ECONNREFUSED')
    fetchMock.mockRejectedValue(netErr)

    const err = await callLlm('sys', 'user', 100).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmCallError)
    const message = String((err as Error).message)
    expect(message).toContain('LLM unreachable at http://llm.test:8003/v1')
    expect(message).toMatch(/ECONNREFUSED|fetch failed/)
    expect(message).not.toMatch(/empty LLM response/i)
    // LLM_RETRIES=1 → 2 attempts
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws on 4xx without retrying', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404, 'Not Found'))
    await expect(callLlm('sys', 'user', 100)).rejects.toMatchObject({
      name: 'LlmCallError',
      message: expect.stringContaining('LLM HTTP 404'),
      retryable: false,
      status: 404,
    })
    // 4xx is not retried — only one fetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('marks 429 as retryable so the job layer can back off without going terminal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429, 'Too Many Requests'))
    await expect(callLlm('sys', 'user', 100)).rejects.toMatchObject({
      name: 'LlmCallError',
      retryable: true,
      status: 429,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 4xx listed in llmTransientStatuses like a 5xx and succeeds', async () => {
    config.llmTransientStatuses = [403, 404]
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404, 'Not Found')).mockResolvedValueOnce(
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'recovered summary text' } }],
      }),
    )
    await expect(callLlm('sys', 'user', 100)).resolves.toBe('recovered summary text')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails a listed 4xx as retryable (not terminal) once retries run out', async () => {
    config.llmTransientStatuses = [403]
    fetchMock.mockResolvedValue(jsonResponse({}, 403, ''))
    const err = await callLlm('sys', 'user', 100).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmCallError)
    expect((err as LlmCallError).retryable).toBe(true)
    expect(String((err as Error).message)).toContain('LLM HTTP 403: client error')
    // LLM_RETRIES=1 → 2 attempts
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('marks network failures as retryable', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    const err = await callLlm('sys', 'user', 100).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmCallError)
    expect((err as LlmCallError).retryable).toBe(true)
    expect((err as LlmCallError).status).toBeUndefined()
  })

  it('throws on empty content after retries with minChars detail', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '' } }],
      }),
    )
    await expect(callLlm('sys', 'user', 100, { minChars: 2 })).rejects.toMatchObject({
      name: 'LlmCallError',
      message: expect.stringContaining('Empty or too-short LLM response'),
    })
    // LLM_RETRIES=1 → 2 attempts
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws on finish_reason=length as truncated without retrying the same prompt', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: '' } }],
      }),
    )
    await expect(callLlm('sys', 'user', 32000)).rejects.toMatchObject({
      name: 'LlmCallError',
      message: expect.stringContaining('truncated at max_tokens=32000'),
    })
    // Same prompt + same max_tokens will truncate again — compactLeaf
    // shrinks the batch instead of burning LLM_RETRIES here.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts 2-char [] when minChars is 2 (wiki no-op answer)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '[]' } }],
      }),
    )
    await expect(callLlm('sys', 'user', 100, { minChars: 2 })).resolves.toBe('[]')
  })

  it('labels an abort as timeout, not unreachable', async () => {
    fetchMock.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'))
    const err = await callLlm('sys', 'user', 100).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmCallError)
    expect(String((err as Error).message)).toMatch(/timed out after 5000ms/)
    expect(String((err as Error).message)).not.toMatch(/unreachable/)
  })

  it('labels a malformed 200 body as invalid JSON, not unreachable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    } as unknown as Response)
    const err = await callLlm('sys', 'user', 100).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmCallError)
    expect(String((err as Error).message)).toMatch(/invalid JSON/)
    expect(String((err as Error).message)).not.toMatch(/unreachable/)
  })

  describe('fallback endpoints', () => {
    const ok = (content: string) =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content } }] })
    const urlOf = (call: unknown[]) => String(call[0])
    const bodyOf = (call: unknown[]) =>
      JSON.parse(String((call[1] as { body: string }).body)) as { model: string }

    beforeEach(() => {
      config.llmFallbacks = [
        { url: 'http://fb1.test/v1', model: 'fb1-model', apiKey: 'fb1-key' },
        { url: 'http://fb2.test/v1', model: 'fb2-model', apiKey: '' },
      ]
    })

    it('fails over to the next endpoint with its own model and key', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(ok('fallback summary text here'))

      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toEqual({
        content: 'fallback summary text here',
        model: 'fb1-model',
      })
      const third = fetchMock.mock.calls[2]
      expect(urlOf(third)).toBe('http://fb1.test/v1/chat/completions')
      expect(bodyOf(third).model).toBe('fb1-model')
      expect((third[1] as { headers: Record<string, string> }).headers.Authorization).toBe(
        'Bearer fb1-key',
      )
    })

    it('fails over on a permanent 4xx such as a bad key', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(ok('fallback summary text here'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'fb1-model',
      })
    })

    it('stays on the fallback for the cooldown, then tries the primary again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        fetchMock
          .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
          .mockResolvedValueOnce(ok('first fallback answer'))
          .mockResolvedValueOnce(ok('second call answer text'))
        await callLlmDetailed('sys', 'user', 100)
        await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
          model: 'fb1-model',
        })
        expect(urlOf(fetchMock.mock.calls[2])).toContain('fb1.test')

        vi.advanceTimersByTime(61_000)
        fetchMock.mockResolvedValueOnce(ok('primary is back again'))
        await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
          model: 'test-model',
        })
        expect(urlOf(fetchMock.mock.calls[3])).toContain('llm.test')
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not fail over on truncation: a smaller batch is the fix', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ choices: [{ finish_reason: 'length', message: { content: '' } }] }),
      )
      const err = await callLlmDetailed('sys', 'user', 100).catch((e: unknown) => e)
      expect(err).toMatchObject({ name: 'LlmCallError', truncated: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('tries the next endpoint when accept rejects the answer, without switching later calls', async () => {
      const accept = (c: string) => (c.startsWith('[') ? null : 'unparseable JSON')
      fetchMock
        .mockResolvedValueOnce(ok('not json at all'))
        .mockResolvedValueOnce(ok('[]'))
        .mockResolvedValueOnce(ok('[]'))
      await expect(callLlmDetailed('sys', 'user', 100, { minChars: 2, accept })).resolves.toEqual({
        content: '[]',
        model: 'fb1-model',
      })
      await callLlmDetailed('sys', 'user', 100, { minChars: 2, accept })
      expect(urlOf(fetchMock.mock.calls[2])).toContain('llm.test')
    })

    it("returns the last endpoint's answer even if accept rejects it", async () => {
      const accept = () => 'unparseable JSON'
      fetchMock.mockResolvedValue(ok('still not json'))
      await expect(callLlmDetailed('sys', 'user', 100, { minChars: 2, accept })).resolves.toEqual({
        content: 'still not json',
        model: 'fb2-model',
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('throws one error naming every endpoint when all fail, and starts at the primary next time', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 403, 'Forbidden'))
      const err = await callLlmDetailed('sys', 'user', 100).catch((e: unknown) => e)
      expect(err).toMatchObject({ name: 'LlmCallError', status: 403, retryable: false })
      const message = String((err as Error).message)
      expect(message).toContain('all 3 LLM endpoints failed')
      for (const model of ['test-model', 'fb1-model', 'fb2-model']) {
        expect(message).toContain(`${model}: LLM HTTP 403`)
      }
      expect(urlOf(fetchMock.mock.calls[2])).toContain('fb2.test')

      fetchMock.mockReset()
      fetchMock.mockResolvedValueOnce(ok('primary answered this time'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'test-model',
      })
    })

    it('stays retryable when the primary is down and only the last fallback fails permanently', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
      const err = await callLlmDetailed('sys', 'user', 100).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmCallError)
      expect((err as LlmCallError).retryable).toBe(true)
      expect((err as LlmCallError).status).toBeUndefined()
      const message = String((err as Error).message)
      expect(message).toContain('test-model: LLM HTTP 503')
      expect(message).toContain('fb2-model: LLM HTTP 401')
    })

    it('callLlm returns only the content', async () => {
      fetchMock.mockResolvedValueOnce(ok('plain content from primary'))
      await expect(callLlm('sys', 'user', 100)).resolves.toBe('plain content from primary')
    })
  })
})
