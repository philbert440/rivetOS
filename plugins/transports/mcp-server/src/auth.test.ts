/**
 * Bearer-auth + unix-socket integration tests for the v2 mount.
 *
 * Covers:
 *   - TCP without token → unauthenticated (current behavior, no regression)
 *   - TCP with token → 401 missing/wrong header, non-401 with correct bearer
 *   - Liveness probe stays open even when bearer is required
 *   - Unix-socket bind without a token serves MCP unauthenticated
 *     (filesystem perms are the auth boundary)
 *   - Unix socket file is mode 0600 and removed on close
 *   - A token on a socket bind enforces bearer (the sidecar composes
 *     "skip bearer on socket" by omitting the token — see cli.ts)
 *   - A stale file at the socket path is replaced on start
 */

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createV2McpServer, type V2McpServer } from '@rivetos/mcp-v2'

interface Harness {
  server: V2McpServer
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

function track(server: V2McpServer): Harness {
  cleanups.push(() => server.close())
  return { server }
}

function tmpSocketPath(): string {
  const p = path.join(
    os.tmpdir(),
    `rivetos-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  )
  tmpFiles.push(p)
  return p
}

async function fetchOver(
  host: string,
  port: number,
  urlPath: string,
  init?: RequestInit,
): Promise<Response> {
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
      createV2McpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
      }),
    )
    await server.start()

    const res = await fetchOver('127.0.0.1', server.port, '/health/live')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('rejects /mcp without bearer when token is required', async () => {
    const { server } = track(
      createV2McpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
      }),
    )
    await server.start()

    const res = await fetchOver('127.0.0.1', server.port, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
  })

  it('rejects /mcp with the wrong bearer', async () => {
    const { server } = track(
      createV2McpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
      }),
    )
    await server.start()

    const res = await fetchOver('127.0.0.1', server.port, '/mcp', {
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
      createV2McpServer({
        host: '127.0.0.1',
        port: 0,
        authToken: 'sekret-abc-123',
      }),
    )
    await server.start()

    // Empty POST body fails downstream (no valid MCP request) but we expect
    // a non-401 — proves auth passed.
    const res = await fetchOver('127.0.0.1', server.port, '/mcp', {
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
    const { server } = track(createV2McpServer({ socketPath: sockPath }))
    await server.start()

    const stat = fs.statSync(sockPath)
    expect(stat.isSocket()).toBe(true)
    // Owner-rw only (0600) — the auth boundary.
    expect(stat.mode & 0o777).toBe(0o600)

    const { status, body } = await getOverSocket(sockPath, '/health/live')
    expect(status).toBe(200)
    expect((body as { ok: boolean }).ok).toBe(true)
  })

  it('removes the socket file on close', async () => {
    const sockPath = tmpSocketPath()
    const server = createV2McpServer({ socketPath: sockPath })
    await server.start()
    expect(fs.existsSync(sockPath)).toBe(true)
    await server.close()
    expect(fs.existsSync(sockPath)).toBe(false)
  })

  it('serves MCP without bearer when no token is configured', async () => {
    // The sidecar composes "skip bearer on socket" by omitting authToken
    // (filesystem perms are the boundary) — the server itself is dumb.
    const sockPath = tmpSocketPath()
    const { server } = track(createV2McpServer({ socketPath: sockPath }))
    await server.start()

    const { status } = await getOverSocket(sockPath, '/mcp', {
      // Note: no authorization header.
    })
    // GET /mcp without a valid MCP request → 4xx from the handler, NOT 401.
    expect(status).not.toBe(401)
  })

  it('enforces bearer on the socket when a token is configured', async () => {
    const sockPath = tmpSocketPath()
    const { server } = track(
      createV2McpServer({
        socketPath: sockPath,
        authToken: 'sock-token',
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

  it('replaces a stale file at the socket path', async () => {
    const sockPath = tmpSocketPath()
    // Simulate a crashed previous run leaving debris at the path.
    fs.writeFileSync(sockPath, '')
    expect(fs.existsSync(sockPath)).toBe(true)

    const { server } = track(createV2McpServer({ socketPath: sockPath }))
    await server.start()
    expect(fs.statSync(sockPath).isSocket()).toBe(true)

    const { status } = await getOverSocket(sockPath, '/health/live')
    expect(status).toBe(200)
  })
})
