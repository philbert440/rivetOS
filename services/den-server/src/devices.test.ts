import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  allocateAddress,
  createDevicesRoutes,
  type DevicesConfig,
  type RelayDriver,
} from './devices.js'
import type {
  MeshDevice as MeshDeviceWire,
  DeviceEnrollConfig as DeviceEnrollConfigWire,
  DeviceEnrollQr as DeviceEnrollQrWire,
} from '@rivetos/types'
import type { MeshDevice, DeviceEnrollConfig, DeviceEnrollQr } from './devices.js'

// Compile-time lock: den-server's local device shapes must stay mutually
// assignable with the canonical wire contracts in @rivetos/types (same idiom
// as mesh.test.ts — types is a devDependency, den-server ships dep-free).
const _devicesWireLock: [
  (d: MeshDevice) => MeshDeviceWire,
  (d: MeshDeviceWire) => MeshDevice,
  (c: DeviceEnrollConfig) => DeviceEnrollConfigWire,
  (c: DeviceEnrollConfigWire) => DeviceEnrollConfig,
  (q: DeviceEnrollQr) => DeviceEnrollQrWire,
  (q: DeviceEnrollQrWire) => DeviceEnrollQr,
] = [(d) => d, (d) => d, (c) => c, (c) => c, (q) => q, (q) => q]
void _devicesWireLock

const CONFIG: DevicesConfig = {
  enabled: true,
  relaySsh: '',
  relaySudo: false,
  wgInterface: 'wg0',
  pool: '192.0.2.10-192.0.2.12',
  wgEndpoint: 'relay.example:51820',
  wgPublicKey: 'r'.repeat(43) + '=',
  allowedIps: '198.51.100.0/24',
  homeSubnet: '198.51.100.',
  sharedHost: 'hub.example',
  sharedExport: '/rivet-shared',
  pgUrl: 'postgres://u:p@hub.example:5432/db',
  embedUrl: 'http://hub.example:9402',
  gatewayUrl: 'http://node.example:5174',
}

const PUBKEY = 'A'.repeat(43) + '='

function fakeDriver(): RelayDriver & { added: string[]; removed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  return {
    added,
    removed,
    async addPeer(pk, addr) {
      added.push(`${pk} ${addr}`)
    },
    async removePeer(pk) {
      removed.push(pk)
    },
    async handshakes() {
      return { [PUBKEY]: 1_700_000_000_000 }
    },
  }
}

/** Drive a routes handler without a real HTTP server. */
async function call(
  routes: ReturnType<typeof createDevicesRoutes>,
  method: string,
  path: string,
  body?: unknown,
  pre = false,
): Promise<{ status: number; body: any }> {
  const req = Readable.from(
    body === undefined ? [] : [JSON.stringify(body)],
  ) as unknown as IncomingMessage
  req.method = method
  req.headers = {}
  let status = 0
  let raw = ''
  const res = {
    writeHead(s: number) {
      status = s
      return this
    },
    end(chunk?: string) {
      raw = chunk ?? ''
    },
    setHeader() {},
  } as unknown as ServerResponse
  const url = new URL(`http://x${path}`)
  const handled = pre
    ? await routes.handleEnroll(req, res, url)
    : await routes.handle(req, res, url)
  expect(handled).toBe(true)
  return { status, body: raw ? JSON.parse(raw) : null }
}

function makeRoutes(driver: RelayDriver | null = fakeDriver(), nowRef = { t: 1_000_000 }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'devices-test-'))
  const routes = createDevicesRoutes({
    config: CONFIG,
    stateDir,
    gatewayUrl: CONFIG.gatewayUrl,
    driver,
    now: () => nowRef.t,
  })
  return { routes, stateDir }
}

describe('allocateAddress', () => {
  it('allocates the first free address in the range', () => {
    expect(allocateAddress('10.0.0.1-10.0.0.3', new Set())).toBe('10.0.0.1')
    expect(allocateAddress('10.0.0.1-10.0.0.3', new Set(['10.0.0.1']))).toBe('10.0.0.2')
    expect(
      allocateAddress('10.0.0.1-10.0.0.3', new Set(['10.0.0.1', '10.0.0.2', '10.0.0.3'])),
    ).toBeNull()
  })
  it('rejects malformed pools', () => {
    expect(allocateAddress('', new Set())).toBeNull()
    expect(allocateAddress('10.0.0.0/24', new Set())).toBeNull()
  })
})

describe('devices routes', () => {
  it('full lifecycle: open → enroll → list → revoke', async () => {
    const driver = fakeDriver()
    const { routes, stateDir } = makeRoutes(driver)

    const open = await call(routes, 'POST', '/api/devices', { name: 'pixel' })
    expect(open.status).toBe(200)
    expect(open.body.address).toBe('192.0.2.10')
    expect(open.body.qr.kind).toBe('rivet-mesh-enroll')
    expect(open.body.qr.config.wgAddress).toBe('192.0.2.10/32')
    expect(open.body.qr.config.pgUrl).toBe(CONFIG.pgUrl)
    // token never appears in the bearer-gated list
    const list0 = await call(routes, 'GET', '/api/devices')
    expect(JSON.stringify(list0.body)).not.toContain(open.body.qr.token)

    const enroll = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(enroll.status).toBe(200)
    expect(enroll.body.device.address).toBe('192.0.2.10')
    expect(enroll.body.config.wgPeerPublicKey).toBe(CONFIG.wgPublicKey)
    expect(driver.added).toEqual([`${PUBKEY} 192.0.2.10`])

    // registry persisted
    const reg = JSON.parse(readFileSync(join(stateDir, 'mesh-devices.json'), 'utf8'))
    expect(reg.devices).toHaveLength(1)
    expect(reg.pending).toHaveLength(0)

    // token is single-use
    const replay = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(replay.status).toBe(403)

    const list = await call(routes, 'GET', '/api/devices')
    expect(list.body.devices[0].lastHandshake).toBe(1_700_000_000_000)

    const revoke = await call(routes, 'DELETE', `/api/devices/${list.body.devices[0].id}`)
    expect(revoke.status).toBe(200)
    expect(driver.removed).toEqual([PUBKEY])
    const after = await call(routes, 'GET', '/api/devices')
    expect(after.body.devices).toHaveLength(0)
  })

  it('rejects bad enroll payloads and expired tokens', async () => {
    const nowRef = { t: 1_000_000 }
    const { routes } = makeRoutes(fakeDriver(), nowRef)
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })

    const badKey = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: 'nope' },
      true,
    )
    expect(badKey.status).toBe(400)
    const badToken = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: 'wrong', publicKey: PUBKEY },
      true,
    )
    expect(badToken.status).toBe(403)

    nowRef.t += 11 * 60 * 1000 // past the 10-minute TTL
    const expired = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(expired.status).toBe(403)
  })

  it('exhausts the pool and reports 409', async () => {
    const { routes } = makeRoutes()
    for (let i = 0; i < 3; i++) {
      const r = await call(routes, 'POST', '/api/devices', { name: `d${i}` })
      expect(r.status).toBe(200)
    }
    const r = await call(routes, 'POST', '/api/devices', { name: 'overflow' })
    expect(r.status).toBe(409)
  })

  it('enrollment succeeds without a relay driver (manual peer add)', async () => {
    const { routes } = makeRoutes(null)
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })
    const enroll = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(enroll.status).toBe(200)
    const list = await call(routes, 'GET', '/api/devices')
    expect(list.body.relayConfigured).toBe(false)
  })

  it('rejects a second enroll with an already-registered public key', async () => {
    const { routes } = makeRoutes()
    const a = await call(routes, 'POST', '/api/devices', { name: 'a' })
    await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: a.body.qr.token, publicKey: PUBKEY },
      true,
    )
    const b = await call(routes, 'POST', '/api/devices', { name: 'b' })
    const dup = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: b.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(dup.status).toBe(409)
  })

  it('concurrent Add-device calls never hand out the same address', async () => {
    // Pool is 3 wide (.10-.12); fire 5 at once — the extra two must 409, and
    // no address may be handed out twice (the point of the allocation lock).
    const { routes } = makeRoutes()
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call(routes, 'POST', '/api/devices', { name: `d${i}` })),
    )
    const addrs = results.filter((r) => r.status === 200).map((r) => r.body.address)
    expect(addrs).toHaveLength(3)
    expect(new Set(addrs).size).toBe(3) // all distinct
    expect(results.filter((r) => r.status === 409)).toHaveLength(2)
  })

  it('restores the pending token when relay registration fails (retry works)', async () => {
    const driver = fakeDriver()
    let fail = true
    driver.addPeer = async (pk, addr) => {
      if (fail) throw new Error('relay down')
      driver.added.push(`${pk} ${addr}`)
    }
    const { routes } = makeRoutes(driver)
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })
    const firstTry = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(firstTry.status).toBe(502)
    fail = false
    const retry = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(retry.status).toBe(200) // same QR still valid after the failure
  })

  it('revoke surfaces relay failure as 502 and keeps the device', async () => {
    const driver = fakeDriver()
    driver.removePeer = async () => {
      throw new Error('ssh down')
    }
    const { routes } = makeRoutes(driver)
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })
    await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    const list = await call(routes, 'GET', '/api/devices')
    const revoke = await call(routes, 'DELETE', `/api/devices/${list.body.devices[0].id}`)
    expect(revoke.status).toBe(502)
    const after = await call(routes, 'GET', '/api/devices')
    expect(after.body.devices).toHaveLength(1)
  })
})
