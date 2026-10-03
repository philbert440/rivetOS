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
    llmFallbacks: [] as Array<{
      url: string
      model: string
      apiKey: string
      transientStatuses: number[]
    }>,
    llmFallbackCooldownMs: 60_000,
    llmFallbackAttemptTimeoutMs: 2_000,
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
        { url: 'http://fb1.test/v1', model: 'fb1-model', apiKey: 'fb1-key', transientStatuses: [] },
        { url: 'http://fb2.test/v1', model: 'fb2-model', apiKey: '', transientStatuses: [] },
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

    it('tries the next endpoint on a request-scoped 4xx without moving later calls', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 400, 'Bad Request'))
        .mockResolvedValueOnce(ok('fallback took the long prompt'))
        .mockResolvedValueOnce(ok('primary still serves the rest'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'fb1-model',
      })
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'test-model',
      })
    })

    it('a rejected answer alone does not sticky-failover; a later endpoint outage does', async () => {
      const accept = (c: string) => (c.startsWith('[') ? null : 'unparseable JSON')
      // Primary reject (not an outage) then fb1 503 (outage) → advance sticky to fb2.
      fetchMock
        .mockResolvedValueOnce(ok('not json at all'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(ok('[]'))
      await expect(callLlmDetailed('sys', 'user', 100, { minChars: 2, accept })).resolves.toEqual({
        content: '[]',
        model: 'fb2-model',
      })
      // Next call starts at fb2 because fb1 was an endpoint outage.
      fetchMock.mockResolvedValueOnce(ok('[]'))
      await callLlmDetailed('sys', 'user', 100, { minChars: 2, accept })
      expect(urlOf(fetchMock.mock.calls[4])).toContain('fb2.test')
    })

    it('moves forward from a sticky fallback that fails, and stays there', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        fetchMock
          .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
          .mockResolvedValueOnce(ok('fb1 answered the first call'))
        await callLlmDetailed('sys', 'user', 100)

        vi.advanceTimersByTime(30_000)
        fetchMock
          .mockResolvedValueOnce(jsonResponse({}, 402, 'Payment Required'))
          .mockResolvedValueOnce(ok('fb2 answered the second call'))
          .mockResolvedValueOnce(ok('fb2 answered the third call'))
        await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
          model: 'fb2-model',
        })
        expect(urlOf(fetchMock.mock.calls[2])).toContain('fb1.test')
        await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
          model: 'fb2-model',
        })
        expect(urlOf(fetchMock.mock.calls[4])).toContain('fb2.test')

        // The move re-armed the cooldown: 45s after it, still on fb2.
        vi.advanceTimersByTime(45_000)
        fetchMock.mockResolvedValueOnce(ok('fb2 answered the fourth call'))
        await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
          model: 'fb2-model',
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('an all-fail from a sticky fallback tries the primary before concluding', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(ok('fb1 answered the first call'))
      await callLlmDetailed('sys', 'user', 100)

      // Sticky at fb1: fb1 and fb2 fail permanently, then the wrap retries the
      // primary (also permanent) so the cascade includes it before throwing.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
      const err = await callLlmDetailed('sys', 'user', 100).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmCallError)
      expect(urlOf(fetchMock.mock.calls[2])).toContain('fb1.test')
      expect(urlOf(fetchMock.mock.calls[4])).toContain('llm.test')
      expect(String((err as Error).message)).toContain('test-model: LLM HTTP 401')

      fetchMock.mockResolvedValueOnce(ok('primary answered this time'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'test-model',
      })
    })

    it('sticky on the last endpoint with a permanent 4xx still tries the primary', async () => {
      // Fail over to fb2 and stick there.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(ok('fb2 answered the first call'))
      await callLlmDetailed('sys', 'user', 100)

      // Credits exhausted on fb2: wrap to the primary instead of going terminal
      // with the primary never tried.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 402, 'Payment Required'))
        .mockResolvedValueOnce(ok('primary recovered during cooldown'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'test-model',
      })
      expect(urlOf(fetchMock.mock.calls[3])).toContain('fb2.test')
      expect(urlOf(fetchMock.mock.calls[4])).toContain('llm.test')

      // Sticky was cleared when the primary answered: next call starts there.
      fetchMock.mockResolvedValueOnce(ok('primary still serves'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'test-model',
      })
      expect(urlOf(fetchMock.mock.calls[5])).toContain('llm.test')
    })

    it('sticky last-endpoint permanent failure stays retryable when the primary is also down', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(ok('fb2 answered the setup call'))
      await callLlmDetailed('sys', 'user', 100)

      // fb2 permanent, then wrap tries the whole skipped prefix (primary + fb1).
      // Primary 503 (retryable) keeps the cascade retryable even though fb2 was not.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 402, 'Payment Required'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
      const err = await callLlmDetailed('sys', 'user', 100).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmCallError)
      expect((err as LlmCallError).retryable).toBe(true)
      expect(String((err as Error).message)).toContain('all 3 LLM endpoints failed')
      expect(String((err as Error).message)).toContain('fb2-model: LLM HTTP 402')
      expect(String((err as Error).message)).toContain('test-model: LLM HTTP 503')
    })

    it('a request-scoped failure on the last endpoint does not clear sticky failover', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(ok('fb1 answered the first call'))
      await callLlmDetailed('sys', 'user', 100)

      // Oversized prompt on the sticky fallback: 413 moves only this call.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 413, 'Payload Too Large'))
        .mockResolvedValueOnce(jsonResponse({}, 413, 'Payload Too Large'))
        // Wrap tries the primary; it also rejects the oversized body.
        .mockResolvedValueOnce(jsonResponse({}, 413, 'Payload Too Large'))
      await expect(callLlmDetailed('sys', 'user', 100)).rejects.toMatchObject({
        name: 'LlmCallError',
      })

      // Sticky must still be on fb1 — a request-scoped miss must not send the
      // next normal call back to a wedged primary.
      fetchMock.mockResolvedValueOnce(ok('fb1 still sticky after 413'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'fb1-model',
      })
      expect(urlOf(fetchMock.mock.calls[5])).toContain('fb1.test')
    })

    it('advances sticky past a later down endpoint after a request-scoped primary failure', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 400, 'Bad Request'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(jsonResponse({}, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(ok('fb2 took over after fb1 outage'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'fb2-model',
      })
      expect(fetchMock).toHaveBeenCalledTimes(4)

      // Primary was request-scoped (no sticky from it) but fb1 was an endpoint
      // outage, so later calls start at fb2.
      fetchMock.mockReset()
      fetchMock.mockResolvedValueOnce(ok('still sticky on fb2 after mixed cascade'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'fb2-model',
      })
      expect(urlOf(fetchMock.mock.calls[0])).toContain('fb2.test')
    })

    it("a call's all-fail does not clear a failover another call set meanwhile", async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
        const slow = String(init.body).includes('"slow"')
        if (slow && url.includes('llm.test')) {
          await gate
          return jsonResponse({}, 503, 'Service Unavailable')
        }
        if (slow) return jsonResponse({}, 400, 'Bad Request')
        if (url.includes('llm.test')) return jsonResponse({}, 401, 'Unauthorized')
        return ok('fast call answered on fb1')
      })
      const slow = callLlmDetailed('sys', 'slow', 100).catch((e: unknown) => e)
      await expect(callLlmDetailed('sys', 'fast', 100)).resolves.toMatchObject({
        model: 'fb1-model',
      })
      release()
      expect(await slow).toBeInstanceOf(LlmCallError)

      fetchMock.mockReset()
      fetchMock.mockResolvedValueOnce(ok('next call stays on fb1'))
      await expect(callLlmDetailed('sys', 'next', 100)).resolves.toMatchObject({
        model: 'fb1-model',
      })
    })

    it("uses each endpoint's own transient codes", async () => {
      config.llmTransientStatuses = [403]
      config.llmFallbacks[0].transientStatuses = [404]
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 403, 'Forbidden'))
        .mockResolvedValueOnce(jsonResponse({}, 403, 'Forbidden'))
        .mockResolvedValueOnce(jsonResponse({}, 404, 'Not Found'))
        .mockResolvedValueOnce(ok('fb1 recovered after a 404'))
      await expect(callLlmDetailed('sys', 'user', 100)).resolves.toMatchObject({
        model: 'fb1-model',
      })
      expect(fetchMock).toHaveBeenCalledTimes(4)

      // fb2 lists nothing, so a 403 there is permanent: one fetch, no retry.
      resetLlmFailover()
      fetchMock.mockReset()
      config.llmTransientStatuses = []
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
        .mockResolvedValueOnce(jsonResponse({}, 403, 'Forbidden'))
      const err = await callLlmDetailed('sys', 'user', 100).catch((e: unknown) => e)
      expect(err).toMatchObject({ retryable: false })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('keeps the full timeout on the primary and last endpoint; middle fallbacks get the short one', async () => {
      fetchMock.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'))
      const err = await callLlmDetailed('sys', 'user', 100).catch((e: unknown) => e)
      const message = String((err as Error).message)
      // Primary keeps LLM_TIMEOUT_MS (5000 in this mock) even when fallbacks exist.
      expect(message).toContain('test-model: LLM timed out after 5000ms')
      // Middle fallback uses llmFallbackAttemptTimeoutMs (2000).
      expect(message).toContain('fb1-model: LLM timed out after 2000ms')
      // Last endpoint keeps the full timeout.
      expect(message).toContain('fb2-model: LLM timed out after 5000ms')
    })

    it('callLlm returns only the content', async () => {
      fetchMock.mockResolvedValueOnce(ok('plain content from primary'))
      await expect(callLlm('sys', 'user', 100)).resolves.toBe('plain content from primary')
    })
  })
})

describe('callLlm with opts.endpoint (single endpoint, e.g. the session tagger)', () => {
  const ok = (content: string) =>
    jsonResponse({ choices: [{ finish_reason: 'stop', message: { content } }] })
  const TAGGER = { url: 'http://tagger.test/v1', model: 'tag-model', apiKey: 'tag-key', transientStatuses: [] as number[] }

  beforeEach(() => {
    fetchMock.mockReset()
    config.llmTransientStatuses = []
    config.llmFallbacks = [
      { url: 'http://fb1.test/v1', model: 'fb1-model', apiKey: 'fb1-key', transientStatuses: [] },
    ]
    resetLlmFailover()
  })

  it('calls only that endpoint with its own model and key', async () => {
    fetchMock.mockResolvedValueOnce(ok('[]'))
    await expect(callLlm('sys', 'user', 50, { minChars: 2, endpoint: TAGGER })).resolves.toBe('[]')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('http://tagger.test/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer tag-key')
    expect(JSON.parse(init.body).model).toBe('tag-model')
  })

  it('never fails over to the primary or the fallbacks, and leaves sticky failover untouched', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503, 'Service Unavailable'))
    await expect(callLlm('sys', 'user', 50, { endpoint: TAGGER })).rejects.toBeInstanceOf(LlmCallError)
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe('http://tagger.test/v1/chat/completions')
    }
    // The next ordinary call still starts at the primary: the tagger outage
    // did not move the compactor's failover index.
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(ok('a perfectly fine summary text'))
    await callLlm('sys', 'user', 50)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://llm.test:8003/v1/chat/completions')
  })

  it('honours a per-attempt timeout override', async () => {
    const seen: number[] = []
    const spy = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockResolvedValueOnce(ok('[]'))
    await callLlm('sys', 'user', 50, { minChars: 2, endpoint: TAGGER, timeoutMs: 1234 })
    for (const call of spy.mock.calls) if (typeof call[1] === 'number') seen.push(call[1])
    spy.mockRestore()
    expect(seen).toContain(1234)
    expect(seen).not.toContain(5_000)
  })

  it('honours maxRetries: 0 means one attempt', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503, 'Service Unavailable'))
    await expect(callLlm('sys', 'user', 50, { endpoint: TAGGER, maxRetries: 0 })).rejects.toBeInstanceOf(
      LlmCallError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses a minted token, and re-mints once when it is rejected with 401', async () => {
    const tokens = ['stale', 'fresh']
    const tokenSource = {
      getToken: vi.fn(async () => tokens[0]),
      invalidate: vi.fn(() => {
        tokens.shift()
      }),
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401, 'Unauthorized'))
      .mockResolvedValueOnce(ok('[]'))
    await expect(
      callLlm('sys', 'user', 50, {
        minChars: 2,
        endpoint: { ...TAGGER, apiKey: 'ignored', tokenSource: tokenSource as never },
      }),
    ).resolves.toBe('[]')
    expect(tokenSource.invalidate).toHaveBeenCalledExactlyOnceWith('stale')
    const auth = fetchMock.mock.calls.map(
      (c) => (c[1] as { headers: Record<string, string> }).headers.Authorization,
    )
    expect(auth).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('a second 401 after the re-mint is a permanent failure, not a loop', async () => {
    const tokenSource = { getToken: vi.fn(async () => 't'), invalidate: vi.fn() }
    fetchMock.mockResolvedValue(jsonResponse({}, 401, 'Unauthorized'))
    await expect(
      callLlm('sys', 'user', 50, { endpoint: { ...TAGGER, tokenSource: tokenSource as never } }),
    ).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(tokenSource.invalidate).toHaveBeenCalledTimes(1)
  })
})
