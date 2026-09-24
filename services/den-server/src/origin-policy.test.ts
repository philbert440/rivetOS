import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  checkOrigin,
  hostnameOf,
  normalizeOrigin,
  parseList,
  type OriginPolicyOptions,
} from './origin-policy.js'

const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1'): IncomingMessage =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage

const plain: OriginPolicyOptions = { tls: false, allowedOrigins: [], allowedHosts: [] }
const tls: OriginPolicyOptions = { tls: true, allowedOrigins: [], allowedHosts: [] }

describe('normalizeOrigin', () => {
  it('canonicalizes http(s) and keeps custom schemes comparable', () => {
    expect(normalizeOrigin('HTTPS://Node.Example:443/')).toBe('https://node.example')
    expect(normalizeOrigin('http://127.0.0.1:5174')).toBe('http://127.0.0.1:5174')
    expect(normalizeOrigin('app://bundle')).toBe('app://bundle')
    expect(normalizeOrigin('APP://Bundle/')).toBe('app://bundle')
  })

  it('rejects null and garbage', () => {
    expect(normalizeOrigin('null')).toBeNull()
    expect(normalizeOrigin('')).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
  })
})

describe('hostnameOf', () => {
  it('strips ports and brackets', () => {
    expect(hostnameOf('Node.Example:5174')).toBe('node.example')
    expect(hostnameOf('localhost')).toBe('localhost')
    expect(hostnameOf('[::1]:5174')).toBe('::1')
  })
})

describe('checkOrigin', () => {
  it('lets native clients (no Origin) through without a CORS grant', () => {
    expect(checkOrigin(req({ host: '127.0.0.1:5174' }), plain)).toEqual({
      ok: true,
      allowOrigin: null,
    })
  })

  it('allows same-origin and echoes it', () => {
    const r = req({ host: '127.0.0.1:5174', origin: 'http://127.0.0.1:5174' })
    expect(checkOrigin(r, plain)).toEqual({ ok: true, allowOrigin: 'http://127.0.0.1:5174' })
  })

  it('treats a TLS-terminating proxy scheme change as same-origin', () => {
    const r = req({ host: 'node.example:5174', origin: 'https://node.example:5174' }, '10.0.0.9')
    expect(checkOrigin(r, plain).ok).toBe(true)
  })

  it('refuses foreign and null origins', () => {
    const foreign = req({ host: '127.0.0.1:5174', origin: 'https://evil.example' })
    expect(checkOrigin(foreign, plain).ok).toBe(false)
    expect(checkOrigin(foreign, tls).ok).toBe(false)
    expect(checkOrigin(req({ host: '127.0.0.1:5174', origin: 'null' }), plain).ok).toBe(false)
  })

  it('refuses a look-alike of the desktop origin', () => {
    const r = req({ host: '127.0.0.1:5174', origin: 'app://bundle.evil.com' })
    expect(checkOrigin(r, plain).ok).toBe(false)
  })

  it('allows the desktop shell, configured origins and mesh peers', () => {
    const opts: OriginPolicyOptions = {
      ...tls,
      allowedOrigins: ['https://hub.example'],
      peerOrigins: () => ['https://peer.example:5174'],
    }
    for (const origin of ['app://bundle', 'https://hub.example', 'https://peer.example:5174']) {
      expect(checkOrigin(req({ host: 'node.example:5174', origin }, '10.0.0.9'), opts)).toEqual({
        ok: true,
        allowOrigin: origin,
      })
    }
  })

  it('pins the Host of loopback callers on a plain-HTTP den (DNS rebinding)', () => {
    const rebound = req({ host: 'evil.example:5174', origin: 'http://evil.example:5174' })
    expect(checkOrigin(rebound, plain).ok).toBe(false)
    expect(checkOrigin(req({ host: 'evil.example:5174' }), plain).ok).toBe(false)
    expect(checkOrigin(req({ host: 'app.localhost:5174' }), plain).ok).toBe(true)
    expect(
      checkOrigin(req({ host: 'den.example:5174' }), { ...plain, allowedHosts: ['den.example'] }).ok,
    ).toBe(true)
  })

  it('leaves Host alone for remote plain-HTTP callers and under TLS', () => {
    expect(checkOrigin(req({ host: '192.0.2.10:5174' }, '192.0.2.99'), plain).ok).toBe(true)
    expect(checkOrigin(req({ host: 'node.example:5174' }), tls).ok).toBe(true)
  })
})

describe('parseList', () => {
  it('splits on commas and whitespace', () => {
    expect(parseList(' a, b  c,,')).toEqual(['a', 'b', 'c'])
    expect(parseList(undefined)).toEqual([])
  })
})
