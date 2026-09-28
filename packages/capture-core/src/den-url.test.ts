import { expect, it } from 'vitest'
import { denTlsConfigured, guardDenUrl, resolveDenUrl } from './den-url.js'

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
})
it('ignores nested ports at a deeper indentation than the first child', () => {
  expect(
    resolveDenUrl({}, () => 'den:\n    port: 1234\n    tls:\n      port: 9999')?.denUrl,
  ).toBe('https://127.0.0.1:1234')
  expect(resolveDenUrl({}, () => 'den:\n    tls:\n      port: 9999')?.denUrl).toBe(
    'https://127.0.0.1:5174',
  )
})
it('keeps the first direct value for each key', () => {
  expect(
    resolveDenUrl(
      {},
      () => 'den:\n  port: 1234\n  port: 9999\n  tls_ca: /first\n  tls_ca: /last',
    ),
  ).toEqual({ denUrl: 'https://127.0.0.1:1234', caPath: '/first' })
})
it('strips inline comments outside quotes', () => {
  expect(
    resolveDenUrl({}, () => 'den:\n  port: 1234 # port\n  tls_ca: /config/ca # CA'),
  ).toEqual({ denUrl: 'https://127.0.0.1:1234', caPath: '/config/ca' })
})
it.each(['"/config/ # ca"', "'/config/ # ca'"])(
  'preserves quoted hashes in %s',
  (value) => {
    expect(resolveDenUrl({}, () => `den:\n  tls_ca: ${value} # comment`)?.caPath).toBe(
      '/config/ # ca',
    )
  },
)
it.each(['', 'invalid', '12abc'])('defaults empty or non-numeric port %j', (port) => {
  expect(resolveDenUrl({}, () => `den:\n  port: ${port}`)?.denUrl).toBe(
    'https://127.0.0.1:5174',
  )
})

const TLS_CONFIG = 'mesh:\n  node_name: tnode\nden:\n  port: 5174\n'
const issued = (name: string) => `/rivet-shared/rivet-ca/issued/${name}`
const bothIssued = (p: string) => p === issued('tnode.crt') || p === issued('tnode.key')

it('denTlsConfigured follows den.tls_cert/key, then env, then mesh issue-node files', () => {
  expect(denTlsConfigured({}, {}, () => false)).toBe(false)
  expect(denTlsConfigured({}, { tls_cert: '/c', tls_key: '/k' }, () => false)).toBe(true)
  expect(denTlsConfigured({}, { tls_cert: '/c' }, () => false)).toBe(false)
  expect(
    denTlsConfigured({ RIVETOS_DEN_TLS_CERT: '/c', RIVETOS_DEN_TLS_KEY: '/k' }, {}, () => false),
  ).toBe(true)
  expect(denTlsConfigured({}, { node_name: 'tnode' }, bothIssued)).toBe(true)
  expect(denTlsConfigured({}, { node_name: 'tnode' }, (p) => p === issued('tnode.crt'))).toBe(false)
  expect(
    denTlsConfigured({ RIVETOS_SHARED_DIR: '/mnt/s' }, { node_name: 'n' }, (p) =>
      p.startsWith('/mnt/s/rivet-ca/issued/n.'),
    ),
  ).toBe(true)
})

it('guardDenUrl uses the first origin of a comma list and says so', () => {
  expect(guardDenUrl('https://127.0.0.1:5174, http://192.0.2.15:5174', false)).toEqual({
    denUrl: 'https://127.0.0.1:5174',
    warnings: [expect.stringContaining('lists several origins')],
  })
})

it('guardDenUrl rewrites http loopback to https only when the den serves https', () => {
  expect(guardDenUrl('http://127.0.0.1:5174', true)).toEqual({
    denUrl: 'https://127.0.0.1:5174',
    warnings: [expect.stringContaining('serves https only')],
  })
  expect(guardDenUrl('http://localhost:5174', true).denUrl).toBe('https://localhost:5174')
  expect(guardDenUrl('http://[::1]:5174', true).denUrl).toBe('https://[::1]:5174')
  expect(guardDenUrl('http://127.0.0.1:5174', false)).toEqual({
    denUrl: 'http://127.0.0.1:5174',
    warnings: [],
  })
  // Local config does not describe a remote den.
  expect(guardDenUrl('http://192.0.2.15:5174', true).warnings).toEqual([])
  expect(guardDenUrl('https://127.0.0.1:5174', true).warnings).toEqual([])
})

it('guardDenUrl applies both guards in order', () => {
  const out = guardDenUrl('http://127.0.0.1:5174,http://192.0.2.15:5174', true)
  expect(out.denUrl).toBe('https://127.0.0.1:5174')
  expect(out.warnings).toHaveLength(2)
})

it('resolveDenUrl guards a pre-set http loopback URL against a TLS den and reports it', () => {
  expect(
    resolveDenUrl({ RIVET_DEN_URL: 'http://127.0.0.1:5174' }, () => TLS_CONFIG, { exists: bothIssued }),
  ).toEqual({
    denUrl: 'https://127.0.0.1:5174',
    caPath: '/rivet-shared/rivet-ca/intermediate/chain.pem',
    warnings: [expect.stringContaining('serves https only')],
  })
  // No TLS material: the explicit http value is trusted and no warning is attached.
  expect(
    resolveDenUrl({ RIVET_DEN_URL: 'http://127.0.0.1:5174' }, () => TLS_CONFIG, { exists: () => false }),
  ).toEqual({
    denUrl: 'http://127.0.0.1:5174',
    caPath: '/rivet-shared/rivet-ca/intermediate/chain.pem',
  })
})

it('resolveDenUrl reads den.tls_cert/tls_key and mesh.node_name without disturbing port and tls_ca', () => {
  expect(
    resolveDenUrl(
      { RIVET_DEN_URL: 'http://127.0.0.1:9999' },
      () => 'mesh:\n  node_name: x\n  tls:\n    cert_path: /nested\nden:\n  port: 9999\n  tls_cert: "/c"\n  tls_key: /k # key\n  tls_ca: /ca\n',
      { exists: () => false },
    ),
  ).toEqual({
    denUrl: 'https://127.0.0.1:9999',
    caPath: '/ca',
    warnings: [expect.stringContaining('serves https only')],
  })
})
