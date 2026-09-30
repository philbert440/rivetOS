import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPairingRoutes,
  PAIR_PATH,
  parsePairingRecord,
  type PairingRecord,
} from './pairing.js'

const TOKEN = 'a'.repeat(43)
const P12 = Buffer.from([0x30, 0x82, 0x01, 0x02, 0xff])

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

function setup(nowRef = { t: 1_000_000 }, record: Partial<PairingRecord> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-'))
  const p12Path = join(dir, 'pixel.p12')
  writeFileSync(p12Path, P12)
  const rec: PairingRecord = {
    v: 1,
    deviceId: 'pixel',
    token: TOKEN,
    passphrase: 'pass-123',
    p12Path,
    expiresAt: nowRef.t + 60_000,
    ...record,
  }
  const recordPath = join(dir, 'pixel.json')
  writeFileSync(recordPath, JSON.stringify(rec))
  const routes = createPairingRoutes({ dir, now: () => nowRef.t })
  return { dir, p12Path, recordPath, routes, nowRef }
}

async function listen(routes: ReturnType<typeof createPairingRoutes>): Promise<string> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    void routes.handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${String((server?.address() as AddressInfo).port)}`
}

const pair = (base: string, body: unknown, method = 'POST') =>
  fetch(`${base}${PAIR_PATH}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })

describe('pairing redemption', () => {
  it('hands out the p12 + passphrase once, then deletes both files', async () => {
    const { routes, p12Path, dir } = setup()
    const base = await listen(routes)

    const res = await pair(base, { token: TOKEN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deviceId: string; p12: string; passphrase: string }
    expect(body.deviceId).toBe('pixel')
    expect(body.passphrase).toBe('pass-123')
    expect(Buffer.from(body.p12, 'base64').equals(P12)).toBe(true)

    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(p12Path)).toBe(false)
    expect(readdirSync(dir)).toEqual([])

    const again = await pair(base, { token: TOKEN })
    expect(again.status).toBe(403)
  })

  it('refuses a wrong token and leaves the record in place', async () => {
    const { routes, recordPath, p12Path } = setup()
    const base = await listen(routes)
    const res = await pair(base, { token: 'b'.repeat(43) })
    expect(res.status).toBe(403)
    expect(existsSync(recordPath)).toBe(true)
    expect(existsSync(p12Path)).toBe(true)
  })

  it('refuses an empty or missing token', async () => {
    const { routes } = setup()
    const base = await listen(routes)
    expect((await pair(base, {})).status).toBe(403)
    expect((await pair(base, { token: '' })).status).toBe(403)
  })

  it('refuses and sweeps an expired record', async () => {
    const nowRef = { t: 1_000_000 }
    const { routes, recordPath, p12Path } = setup(nowRef)
    const base = await listen(routes)
    nowRef.t += 60_001
    const res = await pair(base, { token: TOKEN })
    expect(res.status).toBe(403)
    expect(existsSync(recordPath)).toBe(false)
    expect(existsSync(p12Path)).toBe(false)
  })

  it('answers 410 when the p12 was removed out from under the record', async () => {
    const { routes, p12Path, dir } = setup()
    const base = await listen(routes)
    const { unlinkSync } = await import('node:fs')
    unlinkSync(p12Path)
    const res = await pair(base, { token: TOKEN })
    expect(res.status).toBe(410)
    expect(readdirSync(dir)).toEqual([])
  })

  it('rejects non-POST and malformed bodies', async () => {
    const { routes } = setup()
    const base = await listen(routes)
    expect((await pair(base, null, 'GET')).status).toBe(405)
    const bad = await fetch(`${base}${PAIR_PATH}`, { method: 'POST', body: '{nope' })
    expect(bad.status).toBe(400)
  })

  it('ignores other paths', async () => {
    const { routes } = setup()
    const base = await listen(routes)
    const res = await fetch(`${base}/api/devices/other`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })
})

describe('parsePairingRecord', () => {
  const ok = {
    v: 1,
    deviceId: 'pixel',
    token: TOKEN,
    passphrase: 'p',
    p12Path: '/x.p12',
    expiresAt: 1,
  }
  it('accepts a well-formed record', () => {
    expect(parsePairingRecord(JSON.stringify(ok))).toEqual(ok)
  })
  it('rejects short tokens, wrong versions and junk', () => {
    expect(parsePairingRecord(JSON.stringify({ ...ok, token: 'short' }))).toBeNull()
    expect(parsePairingRecord(JSON.stringify({ ...ok, v: 2 }))).toBeNull()
    expect(parsePairingRecord(JSON.stringify({ ...ok, expiresAt: '1' }))).toBeNull()
    expect(parsePairingRecord('not json')).toBeNull()
  })
})
