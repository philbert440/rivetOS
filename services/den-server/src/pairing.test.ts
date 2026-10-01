import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPairingRoutes,
  createPhonePairingAdmin,
  PAIR_PATH,
  PHONE_PAIRING_PATH,
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
  // Like ~/.rivetos/devices/pairing: den only deletes p12s under devices/.
  const dir = join(mkdtempSync(join(tmpdir(), 'pairing-')), 'devices', 'pairing')
  mkdirSync(dir, { recursive: true })
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

/** The record setup() writes, for tests that rewrite it with extra fields. */
function recordFor(dir: string, t = 1_000_000): PairingRecord {
  return {
    v: 1,
    deviceId: 'pixel',
    token: TOKEN,
    passphrase: 'pass-123',
    p12Path: join(dir, 'pixel.p12'),
    expiresAt: t + 60_000,
  }
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

  it('lets exactly one of two concurrent redemptions of one code win', async () => {
    const { routes } = setup()
    const base = await listen(routes)
    const [a, b] = await Promise.all([pair(base, { token: TOKEN }), pair(base, { token: TOKEN })])
    expect([a.status, b.status].sort()).toEqual([200, 403])
  })

  it('drops the connection on an oversized body instead of reading on', async () => {
    const { routes, recordPath } = setup()
    const base = await listen(routes)
    const huge = JSON.stringify({ token: TOKEN, pad: 'x'.repeat(64 * 1024) })
    const outcome = await fetch(`${base}${PAIR_PATH}`, { method: 'POST', body: huge }).then(
      (r) => r.status,
      () => 'dropped',
    )
    expect(outcome === 'dropped' || outcome === 400).toBe(true)
    expect(existsSync(recordPath)).toBe(true)
  })

  it('keeps the device certificate after a delivered redemption', async () => {
    const { routes, dir } = setup(undefined, {})
    const cert = join(dir, 'issued', 'device-pixel.crt')
    mkdirSync(join(dir, 'issued'))
    writeFileSync(cert, 'crt')
    writeFileSync(join(dir, 'pixel.json'), JSON.stringify({ ...recordFor(dir), certPath: cert }))
    const base = await listen(routes)
    expect((await pair(base, { token: TOKEN })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(cert)).toBe(true)
  })

  it('sweeps an expired record with its p12 and its never-used certificate', async () => {
    const nowRef = { t: 1_000_000 }
    const { routes, dir, recordPath, p12Path } = setup(nowRef)
    const cert = join(dir, 'issued', 'device-pixel.crt')
    mkdirSync(join(dir, 'issued'))
    writeFileSync(cert, 'crt')
    writeFileSync(recordPath, JSON.stringify({ ...recordFor(dir, nowRef.t), certPath: cert }))
    nowRef.t += 60_001
    expect((await pair(await listen(routes), { token: TOKEN })).status).toBe(403)
    expect(existsSync(p12Path)).toBe(false)
    expect(existsSync(cert)).toBe(false)
  })

  it('never deletes files outside the devices dir that a record names', async () => {
    const nowRef = { t: 1_000_000 }
    const { routes, recordPath } = setup(nowRef)
    const elsewhere = mkdtempSync(join(tmpdir(), 'not-devices-'))
    const victim = join(elsewhere, 'precious.p12')
    const notACert = join(elsewhere, 'issued', 'other.crt')
    mkdirSync(join(elsewhere, 'issued'))
    writeFileSync(victim, 'keep')
    writeFileSync(notACert, 'keep')
    writeFileSync(
      recordPath,
      JSON.stringify({ ...recordFor('/x', nowRef.t), p12Path: victim, certPath: notACert }),
    )
    nowRef.t += 60_001
    routes.status('pixel')
    await pair(await listen(routes), { token: TOKEN })
    expect(existsSync(victim)).toBe(true)
    expect(existsSync(notACert)).toBe(true)
  })

  it('sweeps a claim a crash left behind once it has expired', async () => {
    const nowRef = { t: 1_000_000 }
    const { routes, dir, recordPath, p12Path } = setup(nowRef)
    const { renameSync } = await import('node:fs')
    renameSync(recordPath, `${recordPath}.claimed`)
    nowRef.t += 60_001
    await pair(await listen(routes), { token: TOKEN })
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(p12Path)).toBe(false)
  })

  it('a response that never reached the phone is not paired, and frees the name', async () => {
    const { routes, dir, recordPath } = setup()
    const cert = join(dir, 'issued', 'device-pixel.crt')
    mkdirSync(join(dir, 'issued'))
    writeFileSync(cert, 'crt')
    writeFileSync(recordPath, JSON.stringify({ ...recordFor(dir), certPath: cert }))
    const req = Object.assign(Readable.from([JSON.stringify({ token: TOKEN })]), {
      method: 'POST',
    }) as unknown as IncomingMessage
    const res = Object.assign(new EventEmitter(), {
      writeHead: () => res,
      end: () => res,
    }) as unknown as ServerResponse
    expect(await routes.handle(req, res, new URL(`http://x${PAIR_PATH}`))).toBe(true)
    res.emit('close')
    expect(routes.status('pixel')).toBe('expired')
    expect(existsSync(cert)).toBe(false)
    expect(readdirSync(dir)).toEqual(['issued'])
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

describe('pairing status', () => {
  it('reads pending, then paired once redeemed, and expired otherwise', async () => {
    const { routes, nowRef } = setup()
    expect(routes.status('pixel')).toBe('pending')
    expect(routes.status('tablet')).toBe('expired')
    const base = await listen(routes)
    expect((await pair(base, { token: TOKEN })).status).toBe(200)
    // The record is claimed and removed once the response closes.
    await new Promise((r) => setTimeout(r, 20))
    expect(routes.status('pixel')).toBe('paired')
    nowRef.t += 120_000
    expect(routes.status('tablet')).toBe('expired')
  })

  it('an expired pending record reads expired', () => {
    const { routes, nowRef } = setup()
    nowRef.t += 120_000
    expect(routes.status('pixel')).toBe('expired')
  })
})

describe('createPhonePairingAdmin (Settings → Pair a phone)', () => {
  const RESULT = {
    deviceId: 'pixel-2',
    gateway: 'https://192.168.0.183:5174',
    expiresAt: 5_000,
    qrText: '{"v":1,"kind":"rivethub-pair"}',
    reshown: false,
    addedToUsers: true,
  }

  function admin(over: Partial<Parameters<typeof createPhonePairingAdmin>[0]> = {}) {
    const { routes } = setup()
    const calls: string[][] = []
    let reloads = 0
    const a = createPhonePairingAdmin({
      pairing: routes,
      cliPath: '/opt/rivetos/packages/cli/dist/index.js',
      caRootDir: '/home/user/.rivetos/ca/root',
      exists: () => true,
      run: (args) => {
        calls.push(args)
        const out = args[0] === '--check' ? { available: true, gateway: RESULT.gateway } : RESULT
        return Promise.resolve({ stdout: `noise\n${JSON.stringify(out)}\n`, code: 0 })
      },
      reloadUsers: () => {
        reloads += 1
      },
      ...over,
    })
    return { a, calls, reloads: () => reloads }
  }

  async function serve(a: ReturnType<typeof createPhonePairingAdmin>): Promise<string> {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      void a.handle(req, res, url).then((handled) => {
        if (!handled) {
          res.writeHead(404)
          res.end()
        }
      })
    })
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${String((server?.address() as AddressInfo).port)}${PHONE_PAIRING_PATH}`
  }

  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('mints through the CLI, returns its QR text, and reloads users when one was added', async () => {
    const { a, calls, reloads } = admin()
    const url = await serve(a)
    const res = await post(url, { name: ' pixel-2 ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(RESULT)
    expect(calls).toEqual([['pixel-2', '--json']])
    expect(reloads()).toBe(1)
  })

  it('passes a host from Settings to --host, and refuses a malformed one', async () => {
    const { a, calls } = admin()
    const url = await serve(a)
    expect((await post(url, { name: 'pixel-2', host: '192.0.2.7' })).status).toBe(200)
    expect(calls).toEqual([['pixel-2', '--json', '--host', '192.0.2.7']])
    expect((await post(url, { name: 'pixel-2', host: 'a b; rm' })).status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('offers pairing only when rivetos pair --check passes, and reuses the answer', async () => {
    const nowRef = { t: 0 }
    const calls: string[][] = []
    const failing = admin({
      now: () => nowRef.t,
      run: (args) => {
        calls.push(args)
        return Promise.resolve({ stdout: '{"error":"den.tls_cert is not set"}\n', code: 1 })
      },
    }).a
    const url = await serve(failing)
    expect(await (await fetch(url)).json()).toEqual({
      available: false,
      reason: 'den.tls_cert is not set',
    })
    await fetch(url)
    expect(calls).toEqual([['--check', '--json']])
    nowRef.t += 31_000
    await fetch(url)
    expect(calls).toHaveLength(2)
  })

  it('reports availability, and why not when the CA or CLI is missing', async () => {
    expect(await (await fetch(await serve(admin().a))).json()).toEqual({
      available: true,
      gateway: RESULT.gateway,
    })
    server?.close()
    const noCa = admin({ exists: (p) => !p.includes('/ca/root') }).a
    const body = (await (await fetch(await serve(noCa))).json()) as {
      available: boolean
      reason: string
    }
    expect(body.available).toBe(false)
    expect(body.reason).toMatch(/device CA/)
  })

  it('refuses a bad name without running anything', async () => {
    const { a, calls } = admin()
    const res = await post(await serve(a), { name: 'my phone' })
    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('passes the CLI refusal through as 409 and does not reload', async () => {
    const { a, reloads } = admin({
      run: () =>
        Promise.resolve({
          stdout: '{"error":"\\"phone-alex\\" already has a certificate"}\n',
          code: 1,
        }),
    })
    const res = await post(await serve(a), { name: 'phone-alex' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/already has a certificate/)
    expect(reloads()).toBe(0)
  })

  it('serves a device status', async () => {
    const url = await serve(admin().a)
    expect(await (await fetch(`${url}/pixel`)).json()).toEqual({ state: 'pending' })
    expect((await fetch(`${url}/bad%20name`)).status).toBe(404)
    expect((await fetch(`${url}/bad%E0%A4%A`)).status).toBe(400)
  })
})
