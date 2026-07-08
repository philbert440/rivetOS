import { describe, it, expect } from 'vitest'
import { gatewayOrigin, isValidGatewayUrl } from './gateway-url.js'

describe('isValidGatewayUrl', () => {
  it('accepts plain http(s) origins', () => {
    expect(isValidGatewayUrl('http://192.168.1.5:5174')).toBe(true)
    expect(isValidGatewayUrl('https://hub.example.com')).toBe(true)
    expect(isValidGatewayUrl('http://192.168.1.5:5174/')).toBe(true)
  })

  it('rejects non-http schemes', () => {
    expect(isValidGatewayUrl('javascript:alert(1)')).toBe(false)
    expect(isValidGatewayUrl('data:text/html,hi')).toBe(false)
    expect(isValidGatewayUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects userinfo (poisoned roster / open redirect)', () => {
    // Parses as host evil.com with username 127.0.0.1:5174 — must refuse
    expect(isValidGatewayUrl('http://127.0.0.1:5174@evil.com')).toBe(false)
    expect(isValidGatewayUrl('http://user:pass@192.168.1.5:5174')).toBe(false)
  })

  it('rejects path / query / hash (hub base must be origin-only)', () => {
    expect(isValidGatewayUrl('http://192.168.1.5:5174/den/')).toBe(false)
    expect(isValidGatewayUrl('http://192.168.1.5:5174?x=1')).toBe(false)
    expect(isValidGatewayUrl('http://192.168.1.5:5174#frag')).toBe(false)
  })
})

describe('gatewayOrigin', () => {
  it('returns origin for valid URLs', () => {
    expect(gatewayOrigin('http://192.168.1.5:5174/')).toBe('http://192.168.1.5:5174')
  })
  it('returns null for invalid', () => {
    expect(gatewayOrigin('javascript:x')).toBeNull()
  })
})
