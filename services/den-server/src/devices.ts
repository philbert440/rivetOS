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
const isIpv4 = (s: string): boolean => {
  const parts = s.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

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
      if (!isIpv4(address)) throw new Error('bad address')
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
  // Registry holds live enrollment tokens in the clear; keep it owner-only.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Serialize every registry read-modify-write. den-server is single-process,
 * so a promise-chain mutex closes the TOCTOU races an unlocked load→mutate→
 * save exposes: concurrent Add-device dual-claiming a free address, and an
 * enroll redemption interleaving with a revoke of the same pending. Each
 * critical section re-reads the registry under the lock, so no caller acts on
 * a stale snapshot. The lock is held across the (slow) relay ssh calls too —
 * enrollment is a rare, operator-driven action, and serializing it is far
 * cheaper than reconciling a half-applied relay + registry state.
 */
function makeMutex(): <T>(fn: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }
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
  const withLock = makeMutex()
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
        // Allocate + persist the pending under the lock so two concurrent Adds
        // can't hand out the same free address in their QRs.
        const result = await withLock(() => {
          const reg = loadRegistry(file)
          sweep(reg)
          const taken = new Set([
            ...reg.devices.map((d) => d.address),
            ...reg.pending.map((p) => p.address),
          ])
          const address = allocateAddress(config.pool, taken)
          if (!address) return null
          const pending: PendingEnroll = {
            id: randomUUID(),
            name,
            token: randomBytes(24).toString('base64url'),
            address,
            expiresAt: now() + ENROLL_TTL_MS,
          }
          reg.pending.push(pending)
          saveRegistry(file, reg)
          return pending
        })
        if (!result) {
          json(res, 409, { error: 'address pool exhausted (or RIVETOS_DEN_DEVICES_POOL unset)' })
          return true
        }
        const qr: DeviceEnrollQr = {
          v: 1,
          kind: 'rivet-mesh-enroll',
          gateway: opts.gatewayUrl,
          token: result.token,
          config: enrollConfig(result.address),
        }
        log(`[devices] enrollment opened for "${name}" (${result.address}, expires in 10m)`)
        json(res, 200, {
          id: result.id,
          name,
          address: result.address,
          expiresAt: result.expiresAt,
          qr,
        })
        return true
      }

      const idMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)$/)
      if (req.method === 'DELETE' && idMatch) {
        const id = idMatch[1]
        const outcome = await withLock(async () => {
          const reg = loadRegistry(file)
          sweep(reg)
          const dev = reg.devices.find((d) => d.id === id)
          const pend = reg.pending.find((p) => p.id === id)
          if (!dev && !pend) return { status: 404 as const, error: 'unknown device' }
          // Pull the relay peer BEFORE dropping the registry row, still under
          // the lock so an in-flight enroll of the same pending can't re-land
          // the device after we've revoked it.
          if (dev?.publicKey && driver) {
            try {
              await driver.removePeer(dev.publicKey)
            } catch (e) {
              return { status: 502 as const, error: `relay revoke failed: ${(e as Error).message}` }
            }
          }
          reg.devices = reg.devices.filter((d) => d.id !== id)
          reg.pending = reg.pending.filter((p) => p.id !== id)
          saveRegistry(file, reg)
          log(`[devices] revoked ${dev?.name ?? pend?.name ?? id}`)
          return { status: 200 as const }
        })
        json(res, outcome.status, outcome.status === 200 ? { ok: true } : { error: outcome.error })
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
      const name =
        typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : null

      // Whole redemption runs under the lock: match token → burn pending
      // (single-use holds even against a simultaneous replay) → register the
      // relay peer → record the device. On relay failure the pending is
      // restored so the same QR can be retried.
      const outcome = await withLock(async () => {
        const reg = loadRegistry(file)
        sweep(reg)
        const pending = reg.pending.find((p) => tokenEqual(p.token, token))
        if (!pending) return { status: 403 as const, error: 'invalid or expired enrollment token' }
        if (reg.devices.some((d) => d.publicKey === publicKey))
          return { status: 409 as const, error: 'this device is already enrolled' }

        // Burn first so a concurrent replay of the same token 403s.
        reg.pending = reg.pending.filter((p) => p !== pending)
        saveRegistry(file, reg)

        if (driver) {
          try {
            await driver.addPeer(publicKey, pending.address)
          } catch (e) {
            reg.pending.push(pending) // restore for retry with the same QR
            saveRegistry(file, reg)
            return {
              status: 502 as const,
              error: `relay registration failed: ${(e as Error).message}`,
            }
          }
        }
        const device: MeshDevice = {
          id: pending.id,
          name: name ?? pending.name,
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
        return {
          status: 200 as const,
          device: { id: device.id, name: device.name, address: device.address },
          config: enrollConfig(pending.address),
        }
      })

      if (outcome.status === 200)
        json(res, 200, { ok: true, device: outcome.device, config: outcome.config })
      else json(res, outcome.status, { error: outcome.error })
      return true
    },
  }
}
