import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGateway } from './gateway.js'

describe('runGateway', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})

  afterEach(() => {
    error.mockClear()
    log.mockClear()
    process.exitCode = 0
  })

  it('prints usage without a subcommand', () => {
    runGateway([])
    expect(log).toHaveBeenCalledWith('Usage: rivetos gateway caps')
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('rejects leftover token mint and does not write a token file', () => {
    runGateway(['token'])
    expect(process.exitCode).toBe(1)
    expect(error.mock.calls[0]?.[0]).toMatch(/Gateway bearer tokens are removed/)
    runGateway(['token', '--rotate'])
    expect(process.exitCode).toBe(1)
  })
})
