import { describe, expect, it, vi } from 'vitest'
import { isPreSendConnectError, retryPreSendConnect } from './pg-transient.js'

function coded(code: string, message = 'pg error'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('isPreSendConnectError', () => {
  it.each([
    ['53300 too many clients', coded('53300', 'sorry, too many clients already')],
    [
      '53300 reserved slots',
      coded(
        '53300',
        'remaining connection slots are reserved for roles with the SUPERUSER attribute',
      ),
    ],
    ['57P03 cannot_connect_now', coded('57P03', 'the database system is starting up')],
    ['ECONNREFUSED', coded('ECONNREFUSED', 'connect ECONNREFUSED')],
    ['pg-pool checkout timeout', new Error('timeout exceeded when trying to connect')],
  ])('true: %s', (_name, err) => {
    expect(isPreSendConnectError(err)).toBe(true)
  })

  it.each([
    ['ECONNRESET', coded('ECONNRESET', 'read ECONNRESET')],
    ['ETIMEDOUT', coded('ETIMEDOUT', 'connect ETIMEDOUT')],
    ['plain Error', new Error('boom')],
    ['null', null],
  ])('false: %s', (_name, err) => {
    expect(isPreSendConnectError(err)).toBe(false)
  })
})

describe('retryPreSendConnect', () => {
  const sleep = vi.fn(async () => undefined)

  it('succeeds on the 3rd try', async () => {
    sleep.mockClear()
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(coded('53300'))
      .mockRejectedValueOnce(coded('53300'))
      .mockResolvedValueOnce('ok')
    const onRetry = vi.fn()
    await expect(retryPreSendConnect(fn, { sleep, onRetry })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-transient error (fn called once)', async () => {
    sleep.mockClear()
    const err = new Error('not transient')
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err)
    const onRetry = vi.fn()
    await expect(retryPreSendConnect(fn, { sleep, onRetry })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('exhaustion rethrows the LAST error and calls fn 4 times', async () => {
    sleep.mockClear()
    const e1 = coded('53300', 'first')
    const e2 = coded('53300', 'second')
    const e3 = coded('57P03', 'third')
    const e4 = coded('ECONNREFUSED', 'last')
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(e1)
      .mockRejectedValueOnce(e2)
      .mockRejectedValueOnce(e3)
      .mockRejectedValueOnce(e4)
    const onRetry = vi.fn()
    await expect(retryPreSendConnect(fn, { sleep, onRetry })).rejects.toBe(e4)
    expect(fn).toHaveBeenCalledTimes(4)
    expect(onRetry).toHaveBeenCalledTimes(3)
  })
})
