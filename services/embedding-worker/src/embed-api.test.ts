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

import { delayForRetry, embedBatch, isRetryableHttpStatus } from './embed-api.js'

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

function jsonResponse(
  status: number,
  body: unknown,
  statusText = 'Error',
  headers?: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers(headers ?? {}),
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

  it('honors Retry-After seconds on 429 instead of exponential backoff', () => {
    const withHeader = jsonResponse(429, {}, 'Too Many Requests', { 'Retry-After': '3' })
    expect(delayForRetry(0, withHeader)).toBe(3000)

    const withoutHeader = jsonResponse(429, {}, 'Too Many Requests')
    expect(delayForRetry(0, withoutHeader)).toBe(1000)

    const serverError = jsonResponse(503, {}, 'Unavailable', { 'Retry-After': '9' })
    expect(delayForRetry(1, serverError)).toBe(2000)

    const huge = jsonResponse(429, {}, 'Too Many Requests', { 'Retry-After': '3600' })
    expect(delayForRetry(0, huge)).toBe(60_000)
  })

  it('isolates to per-row requests after retryable statuses are exhausted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, {}, 'Too Many Requests'))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()

    const pending = embedBatch(['a', 'b'])
    await vi.runAllTimersAsync()
    const result = await pending

    // embedOnce: attempts 0..maxRetries (2) = 3 fetches per call.
    // 1 batch + 2 isolated rows = 9.
    expect(fetchMock).toHaveBeenCalledTimes(9)
    expect(result).toEqual([null, null])
  })
})
