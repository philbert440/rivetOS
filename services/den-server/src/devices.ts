/**
 * Mesh device enrollment (/api/devices/*) — the desktop Settings → Devices
 * surface. Enroll a phone by QR: the operator mints a one-time token +
 * address allocation (POST /api/devices), the phone scans the QR the client
 * renders from that response, applies the embedded mesh config, and redeems
 * the token with its WireGuard public key (POST /api/devices/enroll). The
 * server registers the peer on the relay and the device is on the mesh.
 * Revocation (DELETE /api/devices/:id) removes the relay peer.
 *
 *   GET    /api/devices              list devices (+ last handshake)
 *   POST   /api/devices              {name} → {id, enrollToken, address,
 *                                    expiresAt, qr: <full QR payload>}
 *   POST   /api/devices/enroll      {token, publicKey, name?} → mesh config
 *                                    ONE-TIME-TOKEN AUTH — the only route in
 *                                    this family outside the bearer gate (the
 *                                    enrolling device has no bearer yet).
 *   DELETE /api/devices/<id>         revoke (remove relay peer + registry)
 *
 * The relay driver is `wg set` over ssh to the operator-configured relay
 * host; a save command persists the peer set across relay restarts. Tests
 * inject a fake driver.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// config

export interface DevicesConfig {
  /** Master switch (RIVETOS_DEN_DEVICES=1). */
  enabled: boolean
  /** Relay ssh target, e.g. "rivet@relay-host". Empty = driver disabled
   *  (enrollment still records devices; peers must be added by hand). */
  relaySsh: string
  /** WireGuard interface name on the relay. */
  wgInterface: string
  /** Device address pool, "A.B.C.D-A.B.C.E" inclusive range. */
  pool: string
  /** Relay public endpoint (host:port) — goes into the QR. */
  wgEndpoint: string
  /** Relay WireGuard public key — goes into the QR. */
  wgPublicKey: string
  /** AllowedIPs the DEVICE should route into the tunnel (mesh subnet). */
  allowedIps: string
  /** Home-LAN IPv4 prefix hint for the device (tunnel auto-idle). */
  homeSubnet: string
  /** Mesh coordinates embedded in the QR for the device's own settings. */
  sharedHost: string
  sharedExport: string
  pgUrl: string
  embedUrl: string
}

// ---------------------------------------------------------------------------
// wire shapes (mirrored in @rivetos/types gateway-api.ts; locked by test)

export interface MeshDevice {
  id: string
  name: string
  publicKey: string
  address: string
  createdAt: number
  enrolledAt: number | null
  /** Unix ms of the peer's last WireGuard handshake; null = never/unknown. */
  lastHandshake: number | null
}

export interface DeviceEnrollConfig {
  sharedHost: string
  sharedExport: string
  pgUrl: string
  embedUrl: string
  wgEndpoint: string
  wgPeerPublicKey: string
  wgAddress: string
  wgAllowedIps: string
  homeSubnet: string
}

/** What the desktop renders as a QR (v1). `config.wgAddress` is this
 *  device's allocation; `gateway` is where the phone redeems `token`. */
export interface DeviceEnrollQr {
  v: 1
  kind: 'rivet-mesh-enroll'
  gateway: string
  token: string
  config: DeviceEnrollConfig
}

// ---------------------------------------------------------------------------
// relay driver

export interface RelayDriver {
  addPeer(publicKey: string, address: string): Promise<void>
  removePeer(publicKey: string): Promise<void>
  /** pubkey → unix-ms of latest handshake (0/absent = never). */
  handshakes(): Promise<Record<string, number>>
}

const WG_KEY = /^[A-Za-z0-9+/]{42,44}=$/
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

const sshExec = (target: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, ...args],
      { timeout: 30_000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
    )
  })

/** wg-over-ssh driver. Inputs are validated (WG key / IPv4 shapes) before
 *  they reach a command line, so the ssh argv carries no caller-controlled
 *  shell metacharacters. */
export function createSshRelayDriver(cfg: { relaySsh: string; wgInterface: string }): RelayDriver {
  const iface = cfg.wgInterface
  if (!/^[\w.-]+$/.test(iface)) throw new Error(`bad wg interface name: ${iface}`)
  return {
    async addPeer(publicKey, address) {
      if (!WG_KEY.test(publicKey)) throw new Error('bad public key')
      if (!IPV4.test(address)) throw new Error('bad address')
      await sshExec(cfg.relaySsh, [
        'wg',
        'set',
        iface,
        'peer',
        publicKey,
        'allowed-ips',
        `${address}/32`,
      ])
      await sshExec(cfg.relaySsh, ['wg-quick', 'save', iface])
    },
    async removePeer(publicKey) {
      if (!WG_KEY.test(publicKey)) throw new Error('bad public key')
      await sshExec(cfg.relaySsh, ['wg', 'set', iface, 'peer', publicKey, 'remove'])
      await sshExec(cfg.relaySsh, ['wg-quick', 'save', iface])
    },
    async handshakes() {
      const out = await sshExec(cfg.relaySsh, ['wg', 'show', iface, 'latest-handshakes'])
      const map: Record<string, number> = {}
      for (const line of out.split('\n')) {
        const [key, ts] = line.trim().split(/\s+/)
        if (key && WG_KEY.test(key)) map[key] = Number(ts) * 1000
      }
      return map
    },
  }
}

// ---------------------------------------------------------------------------
// registry (JSON file in stateDir; small, rewrite-on-change)

interface PendingEnroll {
  id: string
  name: string
  /** sha-256 unnecessary at this trust level; store the token, file is 0600-ish
   *  under the service user's state dir and single-use with a short TTL. */
  token: string
  address: string
  expiresAt: number
}

interface Registry {
  devices: MeshDevice[]
  pending: PendingEnroll[]
}

const ENROLL_TTL_MS = 10 * 60 * 1000

function loadRegistry(file: string): Registry {
  if (!existsSync(file)) return { devices: [], pending: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Registry>
    return { devices: raw.devices ?? [], pending: raw.pending ?? [] }
  } catch {
    return { devices: [], pending: [] }
  }
}

function saveRegistry(file: string, reg: Registry): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2))
  renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// address pool: "A.B.C.D-A.B.C.E" inclusive; skip taken

const ip2n = (ip: string): number => ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0)
const n2ip = (n: number): string => [24, 16, 8, 0].map((s) => (n >> s) & 255).join('.')

export function allocateAddress(pool: string, taken: Set<string>): string | null {
  const m = pool.match(/^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/)
  if (!m) return null
  for (let n = ip2n(m[1]); n <= ip2n(m[2]); n++) {
    const ip = n2ip(n)
    if (!taken.has(ip)) return ip
  }
  return null
}

// ---------------------------------------------------------------------------
// routes

const tokenEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const readJson = (req: IncomingMessage, limit = 16 * 1024): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer | string) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += buf.length
      if (size > limit) reject(new Error('body too large'))
      else chunks.push(buf)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })

export interface DevicesRoutes {
  /** Bearer-gated routes. True = handled. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  /** The unauthenticated enroll redemption; call BEFORE the bearer gate. */
  handleEnroll(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

export function createDevicesRoutes(opts: {
  config: DevicesConfig
  stateDir: string
  /** The externally reachable den base URL to embed in the QR (client can
   *  override with its own origin when it renders the QR). */
  gatewayUrl: string
  driver?: RelayDriver | null
  log?: (msg: string) => void
  now?: () => number
}): DevicesRoutes {
  const { config } = opts
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now
  const file = join(opts.stateDir, 'mesh-devices.json')
  const driver =
    opts.driver !== undefined
      ? opts.driver
      : config.relaySsh
        ? createSshRelayDriver({ relaySsh: config.relaySsh, wgInterface: config.wgInterface })
        : null

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const sweep = (reg: Registry): void => {
    reg.pending = reg.pending.filter((p) => p.expiresAt > now())
  }

  const enrollConfig = (address: string): DeviceEnrollConfig => ({
    sharedHost: config.sharedHost,
    sharedExport: config.sharedExport,
    pgUrl: config.pgUrl,
    embedUrl: config.embedUrl,
    wgEndpoint: config.wgEndpoint,
    wgPeerPublicKey: config.wgPublicKey,
    wgAddress: `${address}/32`,
    wgAllowedIps: config.allowedIps,
    homeSubnet: config.homeSubnet,
  })

  return {
    async handle(req, res, url) {
      if (url.pathname !== '/api/devices' && !url.pathname.startsWith('/api/devices/')) return false
      // enroll is handled pre-gate; if it lands here the gate already passed,
      // which is also fine — fall through to the same handler.
      if (url.pathname === '/api/devices/enroll') return this.handleEnroll(req, res, url)

      if (req.method === 'GET' && url.pathname === '/api/devices') {
        const reg = loadRegistry(file)
        sweep(reg)
        let handshakes: Record<string, number> = {}
        if (driver) {
          try {
            handshakes = await driver.handshakes()
          } catch (e) {
            log(`[devices] handshake probe failed: ${(e as Error).message}`)
          }
        }
        const devices = reg.devices.map((d) => ({
          ...d,
          lastHandshake:
            d.publicKey && handshakes[d.publicKey] ? handshakes[d.publicKey] : d.lastHandshake,
        }))
        json(res, 200, {
          devices,
          pending: reg.pending.map(({ token: _t, ...p }) => p),
          relayConfigured: !!driver,
        })
        return true
      }

      if (req.method === 'POST' && url.pathname === '/api/devices') {
        let body: { name?: unknown }
        try {
          body = (await readJson(req)) as { name?: unknown }
        } catch (e) {
          json(res, 400, { error: (e as Error).message })
          return true
        }
        const name =
          typeof body.name === 'string' && body.name.trim()
            ? body.name.trim().slice(0, 64)
            : 'device'
        const reg = loadRegistry(file)
        sweep(reg)
        const taken = new Set([
          ...reg.devices.map((d) => d.address),
          ...reg.pending.map((p) => p.address),
        ])
        const address = allocateAddress(config.pool, taken)
        if (!address) {
          json(res, 409, { error: 'address pool exhausted (or RIVETOS_DEN_DEVICES_POOL unset)' })
          return true
        }
        const pending: PendingEnroll = {
          id: randomUUID(),
          name,
          token: randomBytes(24).toString('base64url'),
          address,
          expiresAt: now() + ENROLL_TTL_MS,
        }
        reg.pending.push(pending)
        saveRegistry(file, reg)
        const qr: DeviceEnrollQr = {
          v: 1,
          kind: 'rivet-mesh-enroll',
          gateway: opts.gatewayUrl,
          token: pending.token,
          config: enrollConfig(address),
        }
        log(`[devices] enrollment opened for "${name}" (${address}, expires in 10m)`)
        json(res, 200, {
          id: pending.id,
          name,
          address,
          expiresAt: pending.expiresAt,
          qr,
        })
        return true
      }

      const idMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)$/)
      if (req.method === 'DELETE' && idMatch) {
        const reg = loadRegistry(file)
        sweep(reg)
        const dev = reg.devices.find((d) => d.id === idMatch[1])
        const pend = reg.pending.find((p) => p.id === idMatch[1])
        if (!dev && !pend) {
          json(res, 404, { error: 'unknown device' })
          return true
        }
        if (dev && dev.publicKey && driver) {
          try {
            await driver.removePeer(dev.publicKey)
          } catch (e) {
            json(res, 502, { error: `relay revoke failed: ${(e as Error).message}` })
            return true
          }
        }
        reg.devices = reg.devices.filter((d) => d.id !== idMatch[1])
        reg.pending = reg.pending.filter((p) => p.id !== idMatch[1])
        saveRegistry(file, reg)
        log(`[devices] revoked ${dev?.name ?? pend?.name ?? idMatch[1]}`)
        json(res, 200, { ok: true })
        return true
      }

      json(res, 405, { error: 'method not allowed' })
      return true
    },

    async handleEnroll(req, res, url) {
      if (url.pathname !== '/api/devices/enroll' || req.method !== 'POST') return false
      let body: { token?: unknown; publicKey?: unknown; name?: unknown }
      try {
        body = (await readJson(req)) as typeof body
      } catch (e) {
        json(res, 400, { error: (e as Error).message })
        return true
      }
      const token = typeof body.token === 'string' ? body.token : ''
      const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : ''
      if (!token || !WG_KEY.test(publicKey)) {
        json(res, 400, { error: 'token and a valid WireGuard publicKey are required' })
        return true
      }
      const reg = loadRegistry(file)
      sweep(reg)
      const pending = reg.pending.find((p) => tokenEqual(p.token, token))
      if (!pending) {
        json(res, 403, { error: 'invalid or expired enrollment token' })
        return true
      }
      if (driver) {
        try {
          await driver.addPeer(publicKey, pending.address)
        } catch (e) {
          json(res, 502, { error: `relay registration failed: ${(e as Error).message}` })
          return true
        }
      }
      reg.pending = reg.pending.filter((p) => p !== pending)
      const device: MeshDevice = {
        id: pending.id,
        name:
          typeof body.name === 'string' && body.name.trim()
            ? body.name.trim().slice(0, 64)
            : pending.name,
        publicKey,
        address: pending.address,
        createdAt: pending.expiresAt - ENROLL_TTL_MS,
        enrolledAt: now(),
        lastHandshake: null,
      }
      reg.devices.push(device)
      saveRegistry(file, reg)
      log(
        `[devices] enrolled "${device.name}" (${device.address})${driver ? '' : ' [relay driver off — add peer manually]'}`,
      )
      json(res, 200, {
        ok: true,
        device: { id: device.id, name: device.name, address: device.address },
        config: enrollConfig(pending.address),
      })
      return true
    },
  }
}
