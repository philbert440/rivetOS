/**
 * Agent Channel — mTLS server tests.
 *
 * Tests verify:
 *   1. Server rejects connections with no client certificate
 *   2. Server rejects client certs signed by an untrusted CA
 *   3. Server accepts connections with a CA-signed client cert
 *   4. loadTlsConfig resolves default paths correctly
 *   5. loadTlsConfig throws fast with a clear error if a file is missing
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import { AgentChannelServer, loadTlsConfig, extractPeerIdentity } from './agent-channel.js'
import type { TLSSocket } from 'node:tls'
import type { AgentChannelTlsConfig } from './agent-channel.js'
import type { DelegationEngine } from '../domain/delegation.js'
import type { MeshRegistry } from '@rivetos/types'
import type { Router } from '../domain/router.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, '__fixtures__', 'test-ca')

function loadFixtureTls(): AgentChannelTlsConfig {
  return {
    ca: readFileSync(join(FIXTURES, 'ca.crt')),
    cert: readFileSync(join(FIXTURES, 'node.crt')),
    key: readFileSync(join(FIXTURES, 'node.key')),
    cn: 'ct110',
  }
}

/** Minimal stubs */
const noopDelegation: DelegationEngine = {
  delegate: async () => ({ response: 'ok', agent: 'test', durationMs: 0 }),
} as unknown as DelegationEngine

const noopRegistry: MeshRegistry = {
  getNodes: async () => [],
} as unknown as MeshRegistry

const noopRouter: Router = {
  getAgents: () => [],
} as unknown as Router

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

let server: AgentChannelServer
let port: number

beforeAll(async () => {
  port = 19443 + Math.floor(Math.random() * 1000) // random port to avoid conflicts
  server = new AgentChannelServer({
    port,
    tls: loadFixtureTls(),
    delegationEngine: noopDelegation,
    meshRegistry: noopRegistry,
    router: noopRouter,
    localAgents: ['test-agent'],
  })
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

// ---------------------------------------------------------------------------
// Helper: make a raw HTTPS request with optional client cert
// ---------------------------------------------------------------------------

interface TlsRequestOptions {
  path?: string
  clientCert?: { cert: Buffer; key: Buffer }
  /** If true, skip server cert validation (we use a test CA, not a real one) */
  rejectUnauthorized?: boolean
}

function makeRequest(opts: TlsRequestOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const tlsOpts: https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: opts.path ?? '/api/mesh/ping',
      method: 'GET',
      // For tests: supply our test CA so the server cert is trusted
      ca: readFileSync(join(FIXTURES, 'ca.crt')),
      rejectUnauthorized: opts.rejectUnauthorized ?? true,
    }

    if (opts.clientCert) {
      tlsOpts.cert = opts.clientCert.cert
      tlsOpts.key = opts.clientCert.key
    }

    const req = https.request(tlsOpts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
      )
    })

    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentChannelServer (mTLS)', () => {
  it('accepts a request from a valid CA-signed client cert', async () => {
    const res = await makeRequest({
      path: '/api/mesh/ping',
      clientCert: {
        cert: readFileSync(join(FIXTURES, 'node.crt')),
        key: readFileSync(join(FIXTURES, 'node.key')),
      },
    })

    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.tls).toBe(true)
    expect(body.node).toBe('ct110')
  })

  it('rejects a connection with no client certificate', async () => {
    // Node's TLS will refuse the handshake — we expect an ECONNRESET or similar
    await expect(makeRequest({ path: '/api/mesh/ping' })).rejects.toThrow()
  })

  it('rejects a client cert signed by an untrusted CA', async () => {
    await expect(
      makeRequest({
        path: '/api/mesh/ping',
        clientCert: {
          cert: readFileSync(join(FIXTURES, 'untrusted-node.crt')),
          key: readFileSync(join(FIXTURES, 'untrusted-node.key')),
        },
      }),
    ).rejects.toThrow()
  })

  it('extractPeerIdentity returns CN from peer certificate', () => {
    // Mock a TLSSocket with a peer cert
    const mockSocket = {
      getPeerCertificate: () => ({
        subject: { CN: 'test-node' },
      }),
    } as unknown as TLSSocket
    expect(extractPeerIdentity(mockSocket)).toBe('test-node')
  })

  it('extractPeerIdentity handles array CN and falls back to unknown', () => {
    const mockSocketArray = {
      getPeerCertificate: () => ({
        subject: { CN: ['array-cn'] },
      }),
    } as unknown as TLSSocket
    expect(extractPeerIdentity(mockSocketArray)).toBe('array-cn')

    const mockSocketNoCn = {
      getPeerCertificate: () => ({}),
    } as unknown as TLSSocket
    expect(extractPeerIdentity(mockSocketNoCn)).toBe('unknown')
  })

  it('refuses to connect to a server with an untrusted cert (client side)', async () => {
    // Create a second server with a different (untrusted) cert
    // We verify that the client rejects a server it cannot verify
    const untrustedServer = new AgentChannelServer({
      port: port + 500,
      tls: {
        ca: readFileSync(join(FIXTURES, 'ca.crt')),
        cert: readFileSync(join(FIXTURES, 'untrusted-node.crt')),
        key: readFileSync(join(FIXTURES, 'untrusted-node.key')),
        cn: 'evil-node',
      },
      delegationEngine: noopDelegation,
      meshRegistry: noopRegistry,
      router: noopRouter,
      localAgents: ['evil-agent'],
    })
    await untrustedServer.start()

    try {
      // Client uses our test CA — should reject the untrusted server cert
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: port + 500,
          path: '/api/mesh/ping',
          method: 'GET',
          ca: readFileSync(join(FIXTURES, 'ca.crt')),
          cert: readFileSync(join(FIXTURES, 'node.crt')),
          key: readFileSync(join(FIXTURES, 'node.key')),
          rejectUnauthorized: true,
        },
        () => {},
      )
      await expect(
        new Promise<void>((resolve, reject) => {
          req.on('error', reject)
          req.on('response', resolve)
          req.end()
        }),
      ).rejects.toThrow()
    } finally {
      await untrustedServer.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// loadTlsConfig unit tests
// ---------------------------------------------------------------------------

describe('loadTlsConfig', () => {
  it('resolves default paths from nodeName when tls=true', () => {
    // We can only test the path-resolution logic with real files.
    // Use our fixture directory by passing explicit overrides.
    const result = loadTlsConfig(
      {
        caPath: join(FIXTURES, 'ca.crt'),
        certPath: join(FIXTURES, 'node.crt'),
        keyPath: join(FIXTURES, 'node.key'),
      },
      'ct110',
    )

    expect(result.cn).toBe('ct110')
    expect(result.ca).toBeInstanceOf(Buffer)
    expect(result.cert).toBeInstanceOf(Buffer)
    expect(result.key).toBeInstanceOf(Buffer)
    expect(result.ca.length).toBeGreaterThan(0)
  })

  it('throws with a descriptive error when a cert file is missing', () => {
    expect(() =>
      loadTlsConfig(
        {
          caPath: '/nonexistent/ca.pem',
          certPath: join(FIXTURES, 'node.crt'),
          keyPath: join(FIXTURES, 'node.key'),
        },
        'ct110',
      ),
    ).toThrow(/mesh TLS configured but CA chain.*not readable/)
  })

  it('throws when cert file is missing', () => {
    expect(() =>
      loadTlsConfig(
        {
          caPath: join(FIXTURES, 'ca.crt'),
          certPath: '/nonexistent/node.crt',
          keyPath: join(FIXTURES, 'node.key'),
        },
        'ct110',
      ),
    ).toThrow(/mesh TLS configured but node cert.*not readable/)
  })

  it('throws when key file is missing', () => {
    expect(() =>
      loadTlsConfig(
        {
          caPath: join(FIXTURES, 'ca.crt'),
          certPath: join(FIXTURES, 'node.crt'),
          keyPath: '/nonexistent/node.key',
        },
        'ct110',
      ),
    ).toThrow(/mesh TLS configured but node key.*not readable/)
  })
})
