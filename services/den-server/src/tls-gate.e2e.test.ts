/**
 * Real-TLS gate behavior — the class of bug fake PeerCertificate objects
 * cannot catch (found live on the first canary: TLS 1.3 rejectUnauthorized
 * sent `certificate required` to every certless client, killing /healthz and
 * loopback callers before the app layer ran).
 *
 * Certs are generated at runtime with the system openssl — nothing PEM ever
 * lands in the repo (secret-scan). Suite skips if openssl is unavailable.
 * Requests use node:https directly: den-server declares no client deps.
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type RequestOptions } from 'node:https'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDenServer, type DenServer } from './server.js'
import { baseTestDenConfig } from './test-config.js'

function haveOpenssl(): boolean {
  try {
    execSync('openssl version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

interface TestPki {
  dir: string
  ca: string
  serverCert: string
  serverKey: string
  deviceCert: string
  deviceKey: string
}

/** First non-internal IPv4 of this host — lets the suite exercise the
 *  NON-loopback remote path by dialing ourselves externally. */
export function lanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

/** Throwaway CA + server leaf (loopback + LAN IP SANs) + device leaf (OU=client). */
function makePki(extraIp: string | null): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-tls-e2e-'))
  const o = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  }
  o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
     '-days', '2', '-subj', '/O=Rivet Test/CN=Rivet Test CA'])
  const sans = `IP:127.0.0.1${extraIp ? `,IP:${extraIp}` : ''}`
  writeFileSync(join(dir, 'srv.ext'), `subjectAltName=${sans}\nextendedKeyUsage=serverAuth\n`)
  o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr',
     '-subj', '/O=Rivet Test/CN=testnode.mesh'])
  o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
     '-days', '2', '-extfile', 'srv.ext', '-out', 'srv.crt'])
  writeFileSync(join(dir, 'dev.ext'), 'extendedKeyUsage=clientAuth\n')
  o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'dev.key', '-out', 'dev.csr',
     '-subj', '/O=Rivet Test/OU=client/CN=device:e2e-test'])
  o(['x509', '-req', '-in', 'dev.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
     '-days', '2', '-extfile', 'dev.ext', '-out', 'dev.crt'])
  return {
    dir,
    ca: readFileSync(join(dir, 'ca.crt'), 'utf8'),
    serverCert: join(dir, 'srv.crt'),
    serverKey: join(dir, 'srv.key'),
    deviceCert: readFileSync(join(dir, 'dev.crt'), 'utf8'),
    deviceKey: readFileSync(join(dir, 'dev.key'), 'utf8'),
  }
}

function get(
  url: string,
  tls: { ca: string; cert?: string; key?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = { ca: tls.ca, cert: tls.cert, key: tls.key }
    const req = request(url, opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

describe.skipIf(!haveOpenssl())('gateway TLS gate (real sockets)', () => {
  let pki: TestPki
  let den: DenServer
  let base: string
  let remoteBase: string
  let stateDir: string

  const remoteIp = lanIp()

  beforeAll(async () => {
    pki = makePki(remoteIp)
    stateDir = mkdtempSync(join(tmpdir(), 'rivet-tls-e2e-state-'))
    den = createDenServer(
      baseTestDenConfig(stateDir, {
        host: '0.0.0.0',
        tls: {
          certPath: pki.serverCert,
          keyPath: pki.serverKey,
          caPath: join(pki.dir, 'ca.crt'),
          requireClientCert: true,
        },
      }),
    )
    // Wildcard bind so the same server is reachable via 127.0.0.1 (loopback
    // remoteAddress) AND the host's own LAN IP (a genuine non-loopback
    // remoteAddress — the path the loopback shortcut cannot exercise).
    await new Promise<void>((resolve) => den.server.listen(0, '0.0.0.0', resolve))
    const addr = den.server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no address')
    base = `https://127.0.0.1:${String(addr.port)}`
    remoteBase = remoteIp ? `https://${remoteIp}:${String(addr.port)}` : ''
  })

  afterAll(async () => {
    await new Promise((resolve) => den.server.close(resolve))
    rmSync(pki.dir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('serves /healthz to a certless client — the deploy probe and mesh peer probes', async () => {
    const res = await get(`${base}/healthz`, { ca: pki.ca })
    expect(res.status).toBe(200)
    expect((JSON.parse(res.body) as { ok?: boolean }).ok).toBe(true)
  })

  it('serves the API to a verified device leaf', async () => {
    const res = await get(`${base}/sessions`, {
      ca: pki.ca,
      cert: pki.deviceCert,
      key: pki.deviceKey,
    })
    expect(res.status).toBe(200)
  })

  it('lets a certless LOOPBACK client through (hooks post from the node itself)', async () => {
    // Loopback-over-TLS is local operator traffic per isGatewayAuthorized.
    const res = await get(`${base}/sessions`, { ca: pki.ca })
    expect(res.status).toBe(200)
  })

  describe.skipIf(!lanIp())('non-loopback remotes', () => {
    it('denies a certless REMOTE everything but liveness — API and the static shell', async () => {
      expect((await get(`${remoteBase}/healthz`, { ca: pki.ca })).status).toBe(200)
      expect((await get(`${remoteBase}/sessions`, { ca: pki.ca })).status).toBe(401)
      expect((await get(`${remoteBase}/`, { ca: pki.ca })).status).toBe(401)
      expect((await get(`${remoteBase}/packs/anything.png`, { ca: pki.ca })).status).toBe(401)
    })

    it('admits a verified device leaf from a non-loopback remote', async () => {
      const res = await get(`${remoteBase}/sessions`, {
        ca: pki.ca,
        cert: pki.deviceCert,
        key: pki.deviceKey,
      })
      expect(res.status).toBe(200)
    })
  })
})
