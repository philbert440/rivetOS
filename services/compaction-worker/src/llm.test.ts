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

import { callLlm, LlmCallError } from './llm.js'

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
    })
    // 4xx is not retried — only one fetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  it('throws on finish_reason=length as truncated', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: '' } }],
      }),
    )
    await expect(callLlm('sys', 'user', 32000)).rejects.toMatchObject({
      name: 'LlmCallError',
      message: expect.stringContaining('truncated at max_tokens=32000'),
    })
  })

  it('accepts 2-char [] when minChars is 2 (wiki no-op answer)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '[]' } }],
      }),
    )
    await expect(callLlm('sys', 'user', 100, { minChars: 2 })).resolves.toBe('[]')
  })
})
