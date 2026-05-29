import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveAdvertiseHost } from './agents.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveAdvertiseHost', () => {
  it('prefers an explicit advertise_host', () => {
    expect(resolveAdvertiseHost({ advertise_host: '192.0.2.4' })).toBe('192.0.2.4')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveAdvertiseHost({ advertise_host: '  host.example  ' })).toBe('host.example')
  })

  it('falls back to RIVETOS_HOST when advertise_host is unset', () => {
    vi.stubEnv('RIVETOS_HOST', '192.0.2.50')
    expect(resolveAdvertiseHost({})).toBe('192.0.2.50')
    expect(resolveAdvertiseHost(undefined)).toBe('192.0.2.50')
  })

  it('ignores a blank advertise_host and falls back', () => {
    vi.stubEnv('RIVETOS_HOST', '192.0.2.51')
    expect(resolveAdvertiseHost({ advertise_host: '   ' })).toBe('192.0.2.51')
  })
})
