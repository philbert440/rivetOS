import { describe, expect, it } from 'vitest'
import { resolveSidecarTransport, sidecarTransportLog } from './transport.js'

const DEN = 'https://127.0.0.1:5174'
const PG = 'postgres://localhost/rivet'

describe('resolveSidecarTransport', () => {
  it('forces den when RIVET_DEN_URL is set', () => {
    const transport = resolveSidecarTransport({
      RIVETOS_MCP_TRANSPORT: 'den',
      RIVET_DEN_URL: DEN,
      RIVETOS_PG_URL: PG,
    })
    expect(transport).toEqual({ kind: 'den', denUrl: DEN })
    expect(sidecarTransportLog(transport, { RIVET_DEN_URL: DEN })).toBe(
      `[rivetos-mcp-sidecar] transport=den ${DEN}`,
    )
  })

  it('forced den without a URL is none', () => {
    const transport = resolveSidecarTransport({
      RIVETOS_MCP_TRANSPORT: 'den',
      RIVETOS_PG_URL: PG,
    })
    expect(transport).toEqual({
      kind: 'none',
      reason: 'RIVETOS_MCP_TRANSPORT=den but RIVET_DEN_URL is not set',
    })
    expect(sidecarTransportLog(transport, {})).toBe(
      '[rivetos-mcp-sidecar] transport=none — RIVETOS_MCP_TRANSPORT=den but RIVET_DEN_URL is not set',
    )
  })

  it('trims a forced den URL', () => {
    expect(
      resolveSidecarTransport({ RIVETOS_MCP_TRANSPORT: ' den ', RIVET_DEN_URL: `  ${DEN}  ` }),
    ).toEqual({ kind: 'den', denUrl: DEN })
  })

  it('forces pg when RIVETOS_PG_URL is set', () => {
    const transport = resolveSidecarTransport({
      RIVETOS_MCP_TRANSPORT: 'pg',
      RIVET_DEN_URL: DEN,
      RIVETOS_PG_URL: PG,
    })
    expect(transport).toEqual({ kind: 'pg', pgUrl: PG })
    expect(sidecarTransportLog(transport, { RIVET_DEN_URL: DEN, RIVETOS_PG_URL: PG })).toBe(
      '[rivetos-mcp-sidecar] transport=pg',
    )
  })

  it('forced pg without a URL is none', () => {
    expect(
      resolveSidecarTransport({ RIVETOS_MCP_TRANSPORT: 'pg', RIVET_DEN_URL: DEN }),
    ).toEqual({
      kind: 'none',
      reason: 'RIVETOS_MCP_TRANSPORT=pg but RIVETOS_PG_URL is not set',
    })
  })

  it('defaults to den when the URL is set and the user id is empty', () => {
    expect(resolveSidecarTransport({ RIVET_DEN_URL: DEN, RIVETOS_PG_URL: PG })).toEqual({
      kind: 'den',
      denUrl: DEN,
    })
    expect(resolveSidecarTransport({ RIVET_DEN_URL: DEN, RIVETOS_USER_ID: '   ' })).toEqual({
      kind: 'den',
      denUrl: DEN,
    })
  })

  it('keeps pg for a routed user even when den is forced', () => {
    const env = {
      RIVETOS_MCP_TRANSPORT: 'den',
      RIVET_DEN_URL: DEN,
      RIVETOS_PG_URL: PG,
      RIVETOS_USER_ID: 'alice',
    }
    const transport = resolveSidecarTransport(env)
    expect(transport).toEqual({ kind: 'pg', pgUrl: PG })
    expect(sidecarTransportLog(transport, env)).toBe(
      '[rivetos-mcp-sidecar] transport=pg — RIVETOS_USER_ID is set; den transport would hit the owner pool on loopback',
    )
  })

  it('defaults to pg when a routed user has a den URL', () => {
    expect(
      resolveSidecarTransport({
        RIVET_DEN_URL: DEN,
        RIVETOS_PG_URL: PG,
        RIVETOS_USER_ID: 'alice',
      }),
    ).toEqual({ kind: 'pg', pgUrl: PG })
  })

  it('is none when a routed user has a den URL but no Postgres URL', () => {
    expect(
      resolveSidecarTransport({ RIVET_DEN_URL: DEN, RIVETOS_USER_ID: 'alice' }),
    ).toEqual({
      kind: 'none',
      reason:
        'RIVETOS_USER_ID is set — den transport would hit the owner pool on loopback — and RIVETOS_PG_URL is not set',
    })
  })

  it('defaults to pg when only RIVETOS_PG_URL is set', () => {
    const transport = resolveSidecarTransport({ RIVETOS_PG_URL: PG, RIVETOS_USER_ID: 'alice' })
    expect(transport).toEqual({ kind: 'pg', pgUrl: PG })
    expect(sidecarTransportLog(transport, { RIVETOS_PG_URL: PG, RIVETOS_USER_ID: 'alice' })).toBe(
      '[rivetos-mcp-sidecar] transport=pg',
    )
  })

  it('is none when neither den nor pg is configured', () => {
    expect(resolveSidecarTransport({})).toEqual({
      kind: 'none',
      reason: 'RIVET_DEN_URL and RIVETOS_PG_URL are not set',
    })
  })

  it('ignores an unknown transport value and uses the default', () => {
    expect(
      resolveSidecarTransport({ RIVETOS_MCP_TRANSPORT: 'http', RIVET_DEN_URL: DEN }),
    ).toEqual({ kind: 'den', denUrl: DEN })
  })
})
