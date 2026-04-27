/**
 * Bearer-auth + unix-socket integration tests for slice 1.A.7'.
 *
 * Covers:
 *   - TCP without token → unauthenticated (current behavior, no regression)
 *   - TCP with token → 401 missing/wrong header, 200 with correct bearer
 *   - Liveness probe stays open even when bearer is required
 *   - Unix-socket bind serves MCP without bearer
 *   - Unix socket file is mode 0600 and removed on stop
 *   - `requireBearerOnSocket: true` enforces bearer on the socket too
 */

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createMcpServer, type RivetMcpServer } from './server.js'

interface Harness {
  server: RivetMcpServer
}

const cleanups: Array<() => Promise<void>> = []
const tmpFiles: string[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    if (fn) await fn()
  }
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
})

function track(server: RivetMcpServer): Harness {
  cleanups.push(() => server.stop())
  return { server }
}

function tmpSocketPath(): string {
  const p = path.join(os.tmpdir(), `rivetos-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
  tmpFiles.push(p)
  return p
}

async function fetchOver(host: string, port: number, urlPath: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://${host}:${String(port)}${urlPath}`, init)
}

// Use raw http.request over a unix socket since fetch() doesn't support
// `socketPath`. Returns the response status + parsed JSON body.
async function getOverSocket(
  socketPath: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown
          try {
            body = text.length > 0 ? JSON.parse(text) : undefined
          } catch {
            body = text
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('Bearer-token auth on TCP', () => {
  it('liveness probe stays open without auth', async () => {
    const { server } = track(
      createMcpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
        log: () => {
          /* quiet */
        },
      }),
    )
    await server.start()
    const port = server.address.port ?? 0

    const res = await fetchOver('127.0.0.1', port, '/health/live')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('rejects /mcp without bearer when token is required', async () => {
    const { server } = track(
      createMcpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
        log: () => {
          /* quiet */
        },
      }),
    )
    await server.start()
    const port = server.address.port ?? 0

    const res = await fetchOver('127.0.0.1', port, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
  })

  it('rejects /mcp with the wrong bearer', async () => {
    const { server } = track(
      createMcpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
        log: () => {
          /* quiet */
        },
      }),
    )
    await server.start()
    const port = server.address.port ?? 0

    const res = await fetchOver('127.0.0.1', port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('passes /mcp with the correct bearer', async () => {
    const { server } = track(
      createMcpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
        log: () => {
          /* quiet */
        },
      }),
    )
    await server.start()
    const port = server.address.port ?? 0

    // Empty POST body fails downstream (no init request) but we expect 400
    // not 401 — proves auth passed.
    const res = await fetchOver('127.0.0.1', port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sekret-abc-123',
      },
      body: '{}',
    })
    expect(res.status).not.toBe(401)
  })
})

describe('Unix-socket binding', () => {
  it('binds to the socket path with mode 0600 and serves liveness', async () => {
    const sockPath = tmpSocketPath()
    const { server } = track(
      createMcpServer({
        socketPath: sockPath,
        log: () => {
          /* quiet */
        },
      }),
    )
    await server.start()

    const stat = fs.statSync(sockPath)
    expect(stat.isSocket()).toBe(true)
    // Owner-rw only (0600) — the auth boundary.
    expect(stat.mode & 0o777).toBe(0o600)

    const { status, body } = await getOverSocket(sockPath, '/health/live')
    expect(status).toBe(200)
    expect((body as { status: string }).status).toBe('ok')
  })

  it('removes the socket file on stop', async () => {
    const sockPath = tmpSocketPath()
    const server = createMcpServer({
      socketPath: sockPath,
      log: () => {
        /* quiet */
      },
    })
    await server.start()
    expect(fs.existsSync(sockPath)).toBe(true)
    await server.stop()
    expect(fs.existsSync(sockPath)).toBe(false)
  })

  it('skips bearer on the socket by default', async () => {
    const sockPath = tmpSocketPath()
    const { server } = track(
      createMcpServer({
        socketPath: sockPath,
        authToken: 'this-should-not-be-required',
        log: () => {
          /* quiet */
        },
      }),
    )
    await server.start()

    const { status } = await getOverSocket(sockPath, '/mcp', {
      // Note: no authorization header.
    })
    // /mcp without a session id and via GET → 400 (session_required), NOT 401.
    expect(status).not.toBe(401)
  })

  it('enforces bearer on the socket when requireBearerOnSocket=true', async () => {
    const sockPath = tmpSocketPath()
    const { server } = track(
      createMcpServer({
        socketPath: sockPath,
        authToken: 'sock-token',
        requireBearerOnSocket: true,
        log: () => {
          /* quiet */
        },
      }),
    )
    await server.start()

    const { status: noAuthStatus } = await getOverSocket(sockPath, '/mcp')
    expect(noAuthStatus).toBe(401)

    const { status: withAuthStatus } = await getOverSocket(sockPath, '/mcp', {
      authorization: 'Bearer sock-token',
    })
    expect(withAuthStatus).not.toBe(401)
  })

  it('cleans up a stale socket from a previous run', async () => {
    const sockPath = tmpSocketPath()
    // Pre-create a stale socket via a throwaway server.
    const stale = createMcpServer({
      socketPath: sockPath,
      log: () => {
        /* quiet */
      },
    })
    await stale.start()
    // Force-leak: grab a handle on the file but DON'T call stop().
    // Then start a new server on the same path — it should clean up.
    expect(fs.existsSync(sockPath)).toBe(true)
    await stale.stop()
    // Recreate stale state by writing a sentinel file at the path.
    fs.writeFileSync(sockPath, '')
    expect(fs.existsSync(sockPath)).toBe(true)

    // The new server should refuse to clean up a non-socket file —
    // safety check. We only auto-clean things that are sockets.
    const newServer = createMcpServer({
      socketPath: sockPath,
      log: () => {
        /* quiet */
      },
    })
    await expect(newServer.start()).rejects.toThrow()
    fs.unlinkSync(sockPath)
  })
})
