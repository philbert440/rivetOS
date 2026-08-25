/**
 * Unit tests for embed HTTP retry classification and 429 recovery.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.js', () => ({
  config: {
    embedUrl: 'http://embed.test',
    embedModel: 'nemotron',
    apiTimeoutMs: 5000,
    maxRetries: 2,
  },
}))

import { embedBatch, isRetryableHttpStatus } from './embed-api.js'

describe('isRetryableHttpStatus', () => {
  it('retries rate-limits, timeouts, and 5xx', () => {
    expect(isRetryableHttpStatus(408)).toBe(true)
    expect(isRetryableHttpStatus(425)).toBe(true)
    expect(isRetryableHttpStatus(429)).toBe(true)
    expect(isRetryableHttpStatus(500)).toBe(true)
    expect(isRetryableHttpStatus(503)).toBe(true)
  })

  it('does not retry ordinary 4xx client errors', () => {
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableHttpStatus(401)).toBe(false)
    expect(isRetryableHttpStatus(403)).toBe(false)
    expect(isRetryableHttpStatus(404)).toBe(false)
    expect(isRetryableHttpStatus(413)).toBe(false)
  })
})

function jsonResponse(status: number, body: unknown, statusText = 'Error'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as Response
}

describe('embedBatch HTTP retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('retries 429 and succeeds when the API recovers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, 'Too Many Requests'))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ index: 0, embedding: [0.1, 0.2] }] }, 'OK'),
      )
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()

    const pending = embedBatch(['hello'])
    await vi.runAllTimersAsync()
    const result = await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result[0]).toEqual([0.1, 0.2])
  })

  it('does not retry 400 and returns a null vector', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, {}, 'Bad Request'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedBatch(['hello'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result[0]).toBeNull()
  })
})
