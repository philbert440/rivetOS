import { describe, expect, it } from 'vitest'
import {
  deviceIdentityFromCert,
  isDeviceClientCert,
  isGatewayAuthorized,
  isLoopbackHost,
  parseCertSubject,
  wantsHtmlUnauthorized,
} from './auth.js'
import type { IncomingMessage } from 'node:http'
import type { PeerCertificate, TLSSocket } from 'node:tls'

function fakeReq(
  remote: string,
  peer?: Partial<PeerCertificate> & { authorized?: boolean },
): IncomingMessage {
  const sock = {
    remoteAddress: remote,
    encrypted: peer !== undefined,
    authorized: peer?.authorized ?? false,
    getPeerCertificate: peer ? () => peer as PeerCertificate : undefined,
  } as unknown as TLSSocket
  return { socket: sock } as IncomingMessage
}

describe('parseCertSubject / isDeviceClientCert', () => {
  it('accepts OU=client', () => {
    expect(
      isDeviceClientCert({
        subject: { CN: 'device:phone', OU: 'client' },
      } as PeerCertificate),
    ).toBe(true)
  })

  it('accepts CN device: prefix without OU', () => {
    expect(
      isDeviceClientCert({
        subject: { CN: 'device:desk' },
      } as PeerCertificate),
    ).toBe(true)
  })

  it('rejects mesh node leaves', () => {
    expect(
      isDeviceClientCert({
        subject: { CN: 'ct112.mesh' },
      } as PeerCertificate),
    ).toBe(false)
  })

  it('parses string subjects', () => {
    expect(
      parseCertSubject({ subject: '/O=Rivet/OU=client/CN=device:x' } as unknown as PeerCertificate),
    ).toEqual({
      cn: 'device:x',
      ou: 'client',
    })
  })

  it('deviceIdentityFromCert strips device: prefix', () => {
    expect(
      deviceIdentityFromCert({
        subject: { CN: 'device:pixel', OU: 'client' },
      } as PeerCertificate),
    ).toEqual({ cn: 'device:pixel', deviceId: 'pixel' })
  })
})

describe('isGatewayAuthorized', () => {
  it('allows plain HTTP loopback without TLS', () => {
    expect(
      isGatewayAuthorized(fakeReq('127.0.0.1'), {
        tlsConfigured: false,
        requireClientCert: true,
      }),
    ).toBe(true)
  })

  it('rejects plain HTTP from a remote address', () => {
    expect(
      isGatewayAuthorized(fakeReq('192.0.2.50'), {
        tlsConfigured: false,
        requireClientCert: true,
      }),
    ).toBe(false)
  })

  it('allows loopback over TLS without a peer cert', () => {
    expect(
      isGatewayAuthorized(fakeReq('127.0.0.1', { authorized: false }), {
        tlsConfigured: true,
        requireClientCert: true,
      }),
    ).toBe(true)
  })

  it('requires a device client cert for remote TLS', () => {
    expect(
      isGatewayAuthorized(
        fakeReq('192.0.2.50', {
          authorized: true,
          subject: { CN: 'device:hub', OU: 'client' },
        }),
        { tlsConfigured: true, requireClientCert: true },
      ),
    ).toBe(true)
    expect(
      isGatewayAuthorized(
        fakeReq('192.0.2.50', {
          authorized: true,
          subject: { CN: 'ct112.mesh' },
        }),
        { tlsConfigured: true, requireClientCert: true },
      ),
    ).toBe(false)
    expect(
      isGatewayAuthorized(fakeReq('192.0.2.50', { authorized: false }), {
        tlsConfigured: true,
        requireClientCert: true,
      }),
    ).toBe(false)
  })
})

describe('isLoopbackHost', () => {
  it('recognizes common loopback names', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
  })
})

describe('wantsHtmlUnauthorized', () => {
  function req(method: string, accept?: string): IncomingMessage {
    return { method, headers: { accept } } as IncomingMessage
  }

  it('serves HTML only for browser document GETs', () => {
    expect(wantsHtmlUnauthorized(req('GET', 'text/html,application/xhtml+xml'), '/')).toBe(true)
    expect(wantsHtmlUnauthorized(req('HEAD', 'text/html'), '/den/')).toBe(true)
  })

  it('keeps JSON for APIs, POST, and clients without text/html', () => {
    expect(wantsHtmlUnauthorized(req('GET', 'text/html'), '/api/memory/stats')).toBe(false)
    expect(wantsHtmlUnauthorized(req('POST', 'text/html'), '/')).toBe(false)
    expect(wantsHtmlUnauthorized(req('GET', '*/*'), '/')).toBe(false)
    expect(wantsHtmlUnauthorized(req('GET'), '/')).toBe(false)
  })
})
