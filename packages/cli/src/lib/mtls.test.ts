import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meshFetch } from './mtls.js'

/**
 * Real mTLS round-trip. Guards the 2026-09-04 fleet outage: the CLI built an
 * undici (node_modules) Agent and handed it to Node's GLOBAL fetch, whose
 * bundled undici has a different dispatcher interface — every mesh call died
 * with "fetch failed" (UND_ERR_INVALID_ARG) while the certs were fine.
 * meshFetch uses undici's own fetch with the same Agent, so it works; the old
 * pairing is asserted to keep failing so nobody reintroduces it.
 */

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'ignore' })
}

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Majors of Node's bundled undici (behind global fetch) vs the npm undici the CLI imports. */
const bundledUndiciMajor = Number(
  (process.versions as { undici?: string }).undici?.split('.')[0] ?? '0',
)
const npmUndiciMajor = Number(
  (
    JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve('undici/package.json'), 'utf-8'),
    ) as { version: string }
  ).version.split('.')[0],
)

describe.skipIf(!hasOpenssl())('meshFetch — undici Agent + undici fetch over real mTLS', () => {
  let dir: string
  let server: Server
  let port: number
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mtls-test-'))
    // Tiny CA + server cert (SAN 127.0.0.1) + client cert, all signed by the CA.
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=test-ca',
        '-keyout',
        'ca.key',
        '-out',
        'ca.crt',
      ],
      dir,
    )
    writeFileSync(join(dir, 'san.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n')
    openssl(
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=server',
        '-keyout',
        'server.key',
        '-out',
        'server.csr',
      ],
      dir,
    )
    openssl(
      [
        'x509',
        '-req',
        '-in',
        'server.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-days',
        '2',
        '-extfile',
        'san.cnf',
        '-out',
        'server.crt',
      ],
      dir,
    )
    openssl(
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=client.mesh',
        '-keyout',
        'client.key',
        '-out',
        'client.csr',
      ],
      dir,
    )
    openssl(
      [
        'x509',
        '-req',
        '-in',
        'client.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-days',
        '2',
        '-out',
        'client.crt',
      ],
      dir,
    )

    server = createServer(
      {
        cert: readFileSync(join(dir, 'server.crt')),
        key: readFileSync(join(dir, 'server.key')),
        ca: readFileSync(join(dir, 'ca.crt')),
        requestCert: true,
        rejectUnauthorized: true, // client cert REQUIRED — exactly like the agent channel
      },
      (req, res) => {
        const peer = req.socket as unknown as {
          getPeerCertificate(): { subject?: { CN?: string } }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ ok: true, tls: true, client: peer.getPeerCertificate().subject?.CN }),
        )
      },
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port

    for (const k of ['RIVETOS_TLS_CA', 'RIVETOS_TLS_CERT', 'RIVETOS_TLS_KEY'])
      savedEnv[k] = process.env[k]
    process.env.RIVETOS_TLS_CA = join(dir, 'ca.crt')
    process.env.RIVETOS_TLS_CERT = join(dir, 'client.crt')
    process.env.RIVETOS_TLS_KEY = join(dir, 'client.key')
  })

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    // meshFetch's undici Agent keeps connections alive; close them or server.close() hangs.
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('meshFetch authenticates with the client cert and gets tls:true back', async () => {
    const res = await meshFetch(`https://127.0.0.1:${String(port)}/api/mesh/ping`, {
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { ok: boolean; tls: boolean; client?: string }
    expect(body).toMatchObject({ ok: true, tls: true, client: 'client.mesh' })
  })

  it('the server really requires a client cert (plain undici fetch is rejected)', async () => {
    const { fetch: undiciFetch, Agent } = await import('undici')
    const noClientCert = new Agent({ connect: { ca: readFileSync(join(dir, 'ca.crt')) } })
    await expect(
      undiciFetch(`https://127.0.0.1:${String(port)}/api/mesh/ping`, { dispatcher: noClientCert }),
    ).rejects.toThrow()
  })

  it.skipIf(bundledUndiciMajor === npmUndiciMajor)(
    'the buggy pairing — node_modules undici Agent + GLOBAL fetch — still fails (regression guard)',
    async () => {
      const { Agent } = await import('undici')
      const agent = new Agent({
        connect: {
          ca: readFileSync(join(dir, 'ca.crt')),
          cert: readFileSync(join(dir, 'client.crt')),
          key: readFileSync(join(dir, 'client.key')),
        },
      })
      await expect(
        // @ts-expect-error — the exact call the CLI used to make
        fetch(`https://127.0.0.1:${String(port)}/api/mesh/ping`, { dispatcher: agent }),
      ).rejects.toThrow()
    },
  )
})
