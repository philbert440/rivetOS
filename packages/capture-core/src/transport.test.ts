import { expect, it } from 'vitest'
import { resolveCaptureTransport } from './transport.js'

const DEN = 'https://127.0.0.1:5174'
const PG = 'postgres://localhost/rivet'
const noConfig = (): undefined => undefined

it('forces den when the den URL resolves', () => {
  expect(
    resolveCaptureTransport(
      { RIVETOS_CAPTURE_TRANSPORT: 'den', RIVET_DEN_URL: DEN, RIVETOS_PG_URL: PG },
      noConfig,
    ),
  ).toEqual({ kind: 'den', denUrl: DEN })
})

it('forced den without a resolvable URL is none', () => {
  expect(
    resolveCaptureTransport(
      { RIVETOS_CAPTURE_TRANSPORT: 'den', RIVET_DEN_URL: 'file:///tmp/den', RIVETOS_PG_URL: PG },
      noConfig,
    ),
  ).toEqual({
    kind: 'none',
    reason: 'RIVETOS_CAPTURE_TRANSPORT=den but RIVET_DEN_URL is not set',
  })
  // An invalid den.port now defaults to 5174 (S3a); only an unusable scheme is unresolvable.
  expect(
    resolveCaptureTransport({ RIVETOS_CAPTURE_TRANSPORT: 'den', RIVET_DEN_URL: 'ftp://den' }, noConfig),
  ).toEqual({
    kind: 'none',
    reason: 'RIVETOS_CAPTURE_TRANSPORT=den but RIVET_DEN_URL is not set',
  })
})

it('trims a forced den URL', () => {
  expect(
    resolveCaptureTransport(
      { RIVETOS_CAPTURE_TRANSPORT: ' den ', RIVET_DEN_URL: `  ${DEN}  ` },
      noConfig,
    ),
  ).toEqual({ kind: 'den', denUrl: DEN })
})

it('forces pg when RIVETOS_PG_URL is set', () => {
  expect(
    resolveCaptureTransport(
      { RIVETOS_CAPTURE_TRANSPORT: 'pg', RIVET_DEN_URL: DEN, RIVETOS_PG_URL: PG },
      noConfig,
    ),
  ).toEqual({ kind: 'pg', pgUrl: PG })
})

it('forced pg without a URL is none', () => {
  expect(
    resolveCaptureTransport({ RIVETOS_CAPTURE_TRANSPORT: 'pg', RIVET_DEN_URL: DEN }, noConfig),
  ).toEqual({
    kind: 'none',
    reason: 'RIVETOS_CAPTURE_TRANSPORT=pg but RIVETOS_PG_URL is not set',
  })
})

it('defaults to den when the den URL resolves and the user id is empty', () => {
  expect(resolveCaptureTransport({ RIVET_DEN_URL: DEN, RIVETOS_PG_URL: PG }, noConfig)).toEqual({
    kind: 'den',
    denUrl: DEN,
  })
  expect(resolveCaptureTransport({ RIVETOS_USER_ID: '   ' }, noConfig)).toEqual({
    kind: 'den',
    denUrl: DEN,
  })
  expect(resolveCaptureTransport({}, () => 'den:\n  port: 5999')).toEqual({
    kind: 'den',
    denUrl: 'https://127.0.0.1:5999',
  })
})

it('keeps pg for a routed user even when den is forced', () => {
  expect(
    resolveCaptureTransport(
      {
        RIVETOS_CAPTURE_TRANSPORT: 'den',
        RIVET_DEN_URL: DEN,
        RIVETOS_PG_URL: PG,
        RIVETOS_USER_ID: 'alice',
      },
      noConfig,
    ),
  ).toEqual({ kind: 'pg', pgUrl: PG })
})

it('defaults to pg when a routed user has a den URL', () => {
  expect(
    resolveCaptureTransport(
      { RIVET_DEN_URL: DEN, RIVETOS_PG_URL: PG, RIVETOS_USER_ID: 'alice' },
      noConfig,
    ),
  ).toEqual({ kind: 'pg', pgUrl: PG })
})

it('is none when a routed user has a den URL but no Postgres URL', () => {
  expect(
    resolveCaptureTransport({ RIVET_DEN_URL: DEN, RIVETOS_USER_ID: 'alice' }, noConfig),
  ).toEqual({
    kind: 'none',
    reason:
      'RIVETOS_USER_ID is set — den transport would hit the owner pool on loopback — and RIVETOS_PG_URL is not set',
  })
})

it('defaults to pg when den is disabled and only RIVETOS_PG_URL is set', () => {
  expect(
    resolveCaptureTransport(
      { RIVETOS_PG_URL: `  ${PG}  `, RIVETOS_USER_ID: 'alice' },
      () => 'den:\n  port: invalid',
    ),
  ).toEqual({ kind: 'pg', pgUrl: PG })
})

it('is none when neither den nor pg is configured', () => {
  expect(resolveCaptureTransport({ RIVET_DEN_URL: 'ftp://den' }, noConfig)).toEqual({
    kind: 'none',
    reason: 'RIVET_DEN_URL and RIVETOS_PG_URL are not set',
  })
})

it('ignores an unknown transport value and uses the default', () => {
  expect(
    resolveCaptureTransport({ RIVETOS_CAPTURE_TRANSPORT: 'http', RIVET_DEN_URL: DEN }, noConfig),
  ).toEqual({ kind: 'den', denUrl: DEN })
})

it('treats a launcher-cleared den URL as pg fallback', () => {
  expect(
    resolveCaptureTransport(
      { RIVET_DEN_CA: '/missing-ca.pem', RIVETOS_PG_URL: PG },
      noConfig,
    ),
  ).toEqual({ kind: 'pg', pgUrl: PG })
  expect(
    resolveCaptureTransport({ RIVETOS_CAPTURE_TRANSPORT: 'den', RIVET_DEN_CA: '/missing-ca.pem' }, noConfig),
  ).toEqual({
    kind: 'none',
    reason: 'RIVETOS_CAPTURE_TRANSPORT=den but RIVET_DEN_URL is not set',
  })
})
