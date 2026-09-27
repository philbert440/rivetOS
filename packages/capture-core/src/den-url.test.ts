import { expect, it } from 'vitest'
import { resolveDenUrl } from './den-url.js'

it('prefers launcher URL and CA', () => {
  expect(
    resolveDenUrl(
      { RIVET_DEN_URL: 'https://127.0.0.1:9999', RIVET_DEN_CA: '/launch/ca' },
      () => 'den:\n  port: 1234\n  tls_ca: /config/ca',
    ),
  ).toEqual({ denUrl: 'https://127.0.0.1:9999', caPath: '/launch/ca' })
})
it('reads den scalars and ignores other config sections', () => {
  expect(
    resolveDenUrl(
      { RIVETOS_DEN_TLS_CA: '/env/ca' },
      () =>
        'other:\n  port: 3\nden:\n  port: 1234 # comment\n  tls_ca: "/config/ca"\nrest:\n  port: 4',
    ),
  ).toEqual({ denUrl: 'https://127.0.0.1:1234', caPath: '/config/ca' })
})
it('resolves defaults and fallback CA', () => {
  expect(resolveDenUrl({}, () => undefined)).toEqual({
    denUrl: 'https://127.0.0.1:5174',
    caPath: '/rivet-shared/rivet-ca/intermediate/chain.pem',
  })
  expect(resolveDenUrl({ RIVETOS_DEN_TLS_CA: '/env/ca' }, () => undefined)?.caPath).toBe('/env/ca')
})
it('rejects malformed endpoints', () => {
  expect(resolveDenUrl({ RIVET_DEN_URL: 'file:///tmp/den' }, () => undefined)).toBeUndefined()
  expect(resolveDenUrl({}, () => 'den:\n  port: invalid')).toBeUndefined()
})
