import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  allocateAddress,
  createDevicesRoutes,
  isCidr,
  deviceRoleName,
  type DatahubAdminDriver,
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
  relayForwardSrc: '192.0.2.0/24',
  relayForwardDest: '198.51.100.0/24',
  sharedHost: 'hub.example',
  sharedExport: '/rivet-shared',
  pgUrl: 'postgres://u:p@hub.example:5432/db',
  embedUrl: 'http://hub.example:9402',
  pgAdminUrl: '',
  pgDeviceGroup: 'rivet_device',
}

const PUBKEY = 'A'.repeat(43) + '='

function fakeDriver(): RelayDriver & {
  added: string[]
  removed: string[]
  forwards: string[]
  seq: string[]
} {
  const added: string[] = []
  const removed: string[] = []
  const forwards: string[] = []
  const seq: string[] = [] // ordered op log across all methods
  return {
    added,
    removed,
    forwards,
    seq,
    async addPeer(pk, addr) {
      added.push(`${pk} ${addr}`)
      seq.push('addPeer')
    },
    async removePeer(pk) {
      removed.push(pk)
      seq.push('removePeer')
    },
    async handshakes() {
      return { [PUBKEY]: 1_700_000_000_000 }
    },
    async ensureForward(src, dest) {
      forwards.push(`${src} -> ${dest}`)
      seq.push('ensureForward')
    },
  }
}

function fakeDatahubAdmin(
  opts: { failEnsure?: boolean; failDrop?: boolean } = {},
): DatahubAdminDriver & {
  ensured: string[]
  dropped: string[]
  seq: string[]
} {
  const ensured: string[] = []
  const dropped: string[] = []
  const seq: string[] = []
  return {
    ensured,
    dropped,
    seq,
    async ensureDeviceRole(deviceId) {
      seq.push(`ensure:${deviceId}`)
      if (opts.failEnsure) throw new Error('datahub unreachable')
      ensured.push(deviceId)
      const role = deviceRoleName(deviceId)
      return {
        url: `postgres://${role}:secret@192.0.2.50:5432/phil_memory`,
        role,
      }
    },
    async dropDeviceRole(deviceId) {
      seq.push(`drop:${deviceId}`)
      if (opts.failDrop) throw new Error('datahub drop failed')
      dropped.push(deviceId)
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

function makeRoutes(
  driver: RelayDriver | null = fakeDriver(),
  nowRef = { t: 1_000_000 },
  datahubAdmin: DatahubAdminDriver | null = null,
  config: DevicesConfig = CONFIG,
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'devices-test-'))
  const routes = createDevicesRoutes({
    config,
    stateDir,
    gatewayUrl: 'http://node.example:5174',
    driver,
    datahubAdmin,
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

describe('isCidr', () => {
  it('accepts valid IPv4 CIDRs', () => {
    expect(isCidr('10.0.0.0/24')).toBe(true)
    expect(isCidr('0.0.0.0/0')).toBe(true)
    expect(isCidr('192.0.2.0/24')).toBe(true)
  })
  it('rejects bare IPs, bad prefixes, ranges, and junk', () => {
    expect(isCidr('10.0.0.1')).toBe(false) // no prefix
    expect(isCidr('10.0.0.0/33')).toBe(false) // prefix > 32
    expect(isCidr('10.0.0.1-10.0.0.9')).toBe(false) // range, not CIDR
    expect(isCidr('10.0.0.256/24')).toBe(false) // octet > 255
    expect(isCidr('10.0.0.0/24/8')).toBe(false) // extra slash
    expect(isCidr('; rm -rf/24')).toBe(false) // injection shape
    expect(isCidr('')).toBe(false)
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

  it('ensures the relay forward rule once, before the first peer add', async () => {
    const driver = fakeDriver()
    const { routes } = makeRoutes(driver)

    // two enrollments
    for (const name of ['a', 'b']) {
      const open = await call(routes, 'POST', '/api/devices', { name })
      await call(
        routes,
        'POST',
        '/api/devices/enroll',
        { token: open.body.qr.token, publicKey: name === 'a' ? PUBKEY : 'B'.repeat(43) + '=' },
        true,
      )
    }
    // forward ensured exactly once despite two enrollments
    expect(driver.forwards).toEqual(['192.0.2.0/24 -> 198.51.100.0/24'])
    // and the very first op was the forward rule, before any peer add
    expect(driver.seq).toEqual(['ensureForward', 'addPeer', 'addPeer'])
  })

  it('a failed forward rule does not sink the enroll, and a later enroll retries', async () => {
    const driver = fakeDriver()
    let failForward = true
    driver.ensureForward = async (src, dest) => {
      driver.forwards.push(`${src} -> ${dest}`)
      driver.seq.push('ensureForward')
      if (failForward) throw new Error('ufw down')
    }
    const { routes } = makeRoutes(driver)

    const a = await call(routes, 'POST', '/api/devices', { name: 'a' })
    const enrollA = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: a.body.qr.token, publicKey: PUBKEY },
      true,
    )
    // enroll still succeeds and the peer is added despite the forward failure
    expect(enrollA.status).toBe(200)
    expect(driver.added).toHaveLength(1)

    // next enroll retries the rule (the once-guard reset on failure)
    failForward = false
    const b = await call(routes, 'POST', '/api/devices', { name: 'b' })
    await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: b.body.qr.token, publicKey: 'B'.repeat(43) + '=' },
      true,
    )
    expect(driver.forwards).toHaveLength(2) // attempted again
  })

  it('skips the forward rule when src/dest are unset', async () => {
    const driver = fakeDriver()
    const stateDir = mkdtempSync(join(tmpdir(), 'devices-test-'))
    const routes = createDevicesRoutes({
      config: { ...CONFIG, relayForwardSrc: '', relayForwardDest: '' },
      stateDir,
      gatewayUrl: CONFIG.gatewayUrl,
      driver,
      now: () => 1_000_000,
    })
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })
    await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(driver.forwards).toEqual([])
    expect(driver.added.length).toBe(1)
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

  it('enroll mints a per-device role and puts its URL in the QR', async () => {
    const admin = fakeDatahubAdmin()
    const driver = fakeDriver()
    const { routes, stateDir } = makeRoutes(driver, { t: 1_000_000 }, admin)

    const open = await call(routes, 'POST', '/api/devices', { name: 'pixel' })
    expect(open.status).toBe(200)
    expect(admin.ensured).toHaveLength(1)
    const deviceId = open.body.id as string
    expect(admin.ensured[0]).toBe(deviceId)
    const expectedRole = deviceRoleName(deviceId)
    expect(open.body.qr.config.pgUrl).toBe(
      `postgres://${expectedRole}:secret@192.0.2.50:5432/phil_memory`,
    )
    expect(open.body.qr.config.pgUrl).not.toBe(CONFIG.pgUrl)

    const enroll = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(enroll.status).toBe(200)
    // Re-ensure at redeem so the enroll response has a working password
    // (Android prefers response config over QR).
    expect(admin.ensured).toHaveLength(2)
    expect(enroll.body.config.pgUrl).toContain(expectedRole)
    expect(enroll.body.config.pgUrl).not.toBe(CONFIG.pgUrl)

    const reg = JSON.parse(readFileSync(join(stateDir, 'mesh-devices.json'), 'utf8'))
    expect(reg.devices[0].pgRole).toBe(expectedRole)
    expect(admin.seq.filter((s) => s.startsWith('ensure:'))).toHaveLength(2)
  })

  it('admin driver unset keeps shared pgUrl and makes no role calls', async () => {
    const admin = fakeDatahubAdmin()
    // Explicit null: feature off even if we pass a stub that would record calls
    // if wired — routes built without datahubAdmin.
    const { routes, stateDir } = makeRoutes(fakeDriver(), { t: 1_000_000 }, null)
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })
    expect(open.body.qr.config.pgUrl).toBe(CONFIG.pgUrl)
    const enroll = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(enroll.status).toBe(200)
    expect(enroll.body.config.pgUrl).toBe(CONFIG.pgUrl)
    expect(admin.ensured).toHaveLength(0)
    expect(admin.dropped).toHaveLength(0)
    const reg = JSON.parse(readFileSync(join(stateDir, 'mesh-devices.json'), 'utf8'))
    expect(reg.devices[0].pgRole).toBeUndefined()
  })

  it('minting failure still enrolls without pgUrl (no shared fallback)', async () => {
    const admin = fakeDatahubAdmin({ failEnsure: true })
    const { routes, stateDir } = makeRoutes(fakeDriver(), { t: 1_000_000 }, admin)
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })
    expect(open.status).toBe(200)
    expect(open.body.qr.config.pgUrl).toBe('')
    expect(open.body.qr.config.pgUrl).not.toBe(CONFIG.pgUrl)

    const enroll = await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    expect(enroll.status).toBe(200)
    expect(enroll.body.config.pgUrl).toBe('')
    const reg = JSON.parse(readFileSync(join(stateDir, 'mesh-devices.json'), 'utf8'))
    expect(reg.devices[0].pgRole).toBeUndefined()
    expect(admin.seq.some((s) => s.startsWith('ensure:'))).toBe(true)
  })

  it('revoke drops the datahub role', async () => {
    const admin = fakeDatahubAdmin()
    const driver = fakeDriver()
    const { routes } = makeRoutes(driver, { t: 1_000_000 }, admin)
    const open = await call(routes, 'POST', '/api/devices', { name: 'p' })
    await call(
      routes,
      'POST',
      '/api/devices/enroll',
      { token: open.body.qr.token, publicKey: PUBKEY },
      true,
    )
    const list = await call(routes, 'GET', '/api/devices')
    const id = list.body.devices[0].id as string
    expect(list.body.devices[0].pgRole).toBe(deviceRoleName(id))

    const revoke = await call(routes, 'DELETE', `/api/devices/${id}`)
    expect(revoke.status).toBe(200)
    expect(driver.removed).toEqual([PUBKEY])
    expect(admin.dropped).toEqual([id])
    expect(admin.seq).toContain(`drop:${id}`)
  })

  it('revoke surfaces datahub role drop failure as 502 and keeps the device', async () => {
    const admin = fakeDatahubAdmin({ failDrop: true })
    const { routes } = makeRoutes(fakeDriver(), { t: 1_000_000 }, admin)
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
    expect(revoke.body.error).toMatch(/datahub role revoke failed/)
    const after = await call(routes, 'GET', '/api/devices')
    expect(after.body.devices).toHaveLength(1)
  })
})

describe('deviceRoleName', () => {
  it('derives a stable allowlisted role from a UUID', () => {
    expect(deviceRoleName('019e5f82-f0e5-7d41-a38c-4eefced7e570')).toBe(
      'rivet_dev_019e5f82_f0e5_7d41_a38c_4eefced7e570',
    )
  })

  it('rejects junk that cannot form a safe role name', () => {
    expect(() => deviceRoleName('')).toThrow(/required|unsafe/)
    expect(() => deviceRoleName('!!!')).toThrow(/unsafe|rejected/)
    expect(() => deviceRoleName('---')).toThrow(/unsafe|rejected/)
  })

  it('strips non-allowlisted characters rather than interpolating them', () => {
    // Path / SQL metacharacters must not survive into the role identifier.
    const role = deviceRoleName('../../Etc/Passwd')
    expect(role).toBe('rivet_dev_etc_passwd')
    expect(role).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(role).not.toMatch(/[./';-]/)
  })
})
