/**
 * Mesh device enrollment (/api/devices/*) — the desktop Settings → Devices
 * surface. Enroll a phone by QR: the operator mints a one-time token +
 * address allocation (POST /api/devices), the phone scans the QR the client
 * renders from that response, applies the embedded mesh config, and redeems
 * the token with its WireGuard public key (POST /api/devices/enroll). The
 * server registers the peer on the relay and the device is on the mesh.
 * Revocation (DELETE /api/devices/:id) removes the relay peer and, when
 * configured, the device's datahub Postgres role.
 *
 *   GET    /api/devices              list devices (+ last handshake)
 *   POST   /api/devices              {name} → {id, enrollToken, address,
 *                                    expiresAt, qr: <full QR payload>}
 *   POST   /api/devices/enroll      {token, publicKey, name?} → mesh config
 *                                    ONE-TIME-TOKEN AUTH — the only route in
 *                                    this family outside the bearer gate (the
 *                                    enrolling device has no bearer yet).
 *   DELETE /api/devices/<id>         revoke (remove relay peer + registry
 *                                    + datahub role when present)
 *
 * The relay driver is `wg set` over ssh to the operator-configured relay
 * host; a save command persists the peer set across relay restarts. Tests
 * inject a fake driver.
 *
 * Per-device datahub credentials (opt-in): when `pgAdminUrl` is set, enroll
 * mints a `rivet_dev_<id>` role (member of group `rivet_device`) and embeds
 * that URL in the QR instead of the shared `pgUrl`. Empty admin URL leaves
 * the shared-credential path unchanged. See `DEVICE_GROUP_GRANTS_SQL`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import pg from 'pg'

// ---------------------------------------------------------------------------
// config

export interface DevicesConfig {
  /** Master switch (RIVETOS_DEN_DEVICES=1). */
  enabled: boolean
  /** Relay ssh target, e.g. "rivet@relay-host". Empty = driver disabled
   *  (enrollment still records devices; peers must be added by hand). */
  relaySsh: string
  /** Prefix relay `wg`/`wg-quick` commands with `sudo -n` — the ssh user
   *  usually isn't root but has passwordless sudo (wg needs CAP_NET_ADMIN). */
  relaySudo: boolean
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
  /** Device pool as a CIDR for the relay's forwarding allow rule. Empty =
   *  don't manage forwarding (operator does it by hand). Paired with
   *  relayForwardDest. */
  relayForwardSrc: string
  /** Home-LAN CIDR the pool is allowed to reach through the relay. Empty =
   *  don't manage forwarding. */
  relayForwardDest: string
  /** Mesh coordinates embedded in the QR for the device's own settings. */
  sharedHost: string
  sharedExport: string
  /**
   * Absolute path to the shared mesh-devices roster. Empty = per-node
   * `<stateDir>/mesh-devices.json`. Env: RIVETOS_DEN_DEVICES_ROSTER.
   */
  rosterPath: string
  pgUrl: string
  embedUrl: string
  /**
   * CREATEROLE (not superuser) datahub admin URL for minting/dropping
   * per-device roles. Empty = feature off (shared `pgUrl` in QR unchanged).
   * Env: RIVETOS_DEN_DEVICES_PG_ADMIN_URL. Never ships in builds or QRs.
   */
  pgAdminUrl: string
  /** Group role device roles inherit (default `rivet_device`). */
  pgDeviceGroup: string
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
  /**
   * Per-device datahub Postgres role (`rivet_dev_<id>`), when minted.
   * Stored so revoke can DROP ROLE; password is never persisted.
   */
  pgRole?: string
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
  /** Ensure the relay forwards the device pool (src CIDR) to the home LAN
   *  (dest CIDR). Cryptokey routing lets an enrolled device onto the relay,
   *  but the relay's own firewall still has to forward its TCP into the LAN —
   *  without this a device can ping home hosts but reach no service. Idempotent;
   *  optional so test/fake drivers can omit it. */
  ensureForward?(src: string, dest: string): Promise<void>
}

// ---------------------------------------------------------------------------
// datahub admin driver (per-device Postgres roles)
//
// Group role `rivet_device` is an ops one-time setup. Device roles inherit it.
// Exact grants — derived from ON-DEVICE capture + recall only (phone code):
//
// CAPTURE (integrations/grok/rivet-memory/capture/src/grok-memory-capture.ts
//   is the sole memory code that runs on the phone):
//   - SELECT/INSERT ros_conversations (find-or-create)
//   - SELECT/INSERT ros_messages (append transcript rows)
//   - UPDATE ros_conversations ONLY (touch updated_at; finalize active=false)
//     — the only `UPDATE ros_*` the phone issues (~lines 677 / 684)
//
// RECALL (on-device SELECT paths):
//   - SELECT ros_messages, ros_summaries (FTS / trigram / vector)
//   - SELECT ros_summary_sources (expand joins)
//   - SELECT ros_conversations (browse/stats joins)
//
// access_count / last_accessed_at bumps on ros_messages and ros_summaries are
// maintained SERVER-SIDE by RivetOS workers (see integrations/hermes/rivet-
// memory/recall.py and schema.py: "counters maintained by RivetOS") — never
// by the device. Do NOT grant the device group UPDATE on those tables.
//
// No sequences: PKs are UUID DEFAULT gen_random_uuid() (0001_baseline.sql).
// No DDL, no DELETE/TRUNCATE, no other schemas/DBs.
//
// Trigger note: AFTER INSERT on ros_messages runs notify_embedding_queue()
// which calls graphile_worker.add_job (invoker rights). Ops may need
// EXECUTE on that function (or SECURITY DEFINER) for capture INSERT to
// succeed — confirm on non-prod before enabling on the live datahub.
//
// Tables (public schema): ros_conversations, ros_messages, ros_summaries,
// ros_summary_sources.

/** Ops bootstrap SQL for the `rivet_device` group (run once as table owner). */
export const DEVICE_GROUP_GRANTS_SQL = `
-- Per-device least-privilege group. Device roles: GRANT rivet_device TO rivet_dev_*.
-- Validate against a NON-PROD role before enabling on the live datahub.
CREATE ROLE rivet_device NOLOGIN;

GRANT CONNECT ON DATABASE :dbname TO rivet_device;  -- replace :dbname with the datahub database (e.g. phil_memory)
GRANT USAGE ON SCHEMA public TO rivet_device;

-- Capture + recall tables (on-device SQL only — see devices.ts header).
GRANT SELECT, INSERT ON
  ros_conversations,
  ros_messages
  TO rivet_device;
GRANT SELECT ON
  ros_summaries,
  ros_summary_sources
  TO rivet_device;

-- Sole on-device UPDATE: grok-memory-capture.ts touch/finalize on ros_conversations.
-- No UPDATE on ros_messages / ros_summaries (access counters are server-side).
GRANT UPDATE ON
  ros_conversations
  TO rivet_device;
`.trim()

export interface DatahubAdminDriver {
  /**
   * Idempotent: create (or rotate password of) `rivet_dev_<deviceId>`, grant
   * group membership, return a per-device postgres URL with a fresh password.
   */
  ensureDeviceRole(deviceId: string): Promise<{ url: string; role: string }>
  /**
   * NOLOGIN → terminate backends → DROP OWNED BY → DROP ROLE IF EXISTS.
   * Idempotent when the role is already gone.
   */
  dropDeviceRole(deviceId: string): Promise<void>
}

/** Strict role-identifier allowlist: starts with a letter, then [a-z0-9_]. */
const PG_IDENT = /^[a-z][a-z0-9_]*$/

/**
 * Map a device UUID to a Postgres role name. Only [a-z0-9_] survive;
 * rejects inputs that would produce an unsafe or empty identifier.
 */
export function deviceRoleName(deviceId: string): string {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new Error('deviceId required for role name')
  }
  const sanitized = deviceId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!sanitized || !/^[a-z0-9_]+$/.test(sanitized)) {
    throw new Error(`deviceId yields unsafe role suffix: ${deviceId}`)
  }
  const role = `rivet_dev_${sanitized}`
  if (!PG_IDENT.test(role) || role.length > 63) {
    throw new Error(`role name rejected by allowlist: ${role}`)
  }
  return role
}

/** Quote a pre-validated identifier for interpolation (never raw input). */
function pgIdent(name: string): string {
  if (!PG_IDENT.test(name)) throw new Error(`refusing unsafe pg identifier: ${name}`)
  return `"${name}"`
}

/** Escape a string literal for password clauses (identifiers can't bind). */
function pgLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Build a device connection URL from the admin URL's host/db, substituting
 * the device role + password. Never returns the admin credentials.
 */
export function buildDevicePgUrl(adminUrl: string, role: string, password: string): string {
  const u = new URL(adminUrl)
  u.username = role
  u.password = password
  // URL.password encodes special chars; pg clients accept the encoded form.
  return u.toString()
}

export function createPgDatahubAdminDriver(cfg: {
  adminUrl: string
  groupRole: string
  log?: (msg: string) => void
}): DatahubAdminDriver {
  const log = cfg.log ?? (() => {})
  const group = cfg.groupRole.trim() || 'rivet_device'
  if (!PG_IDENT.test(group)) throw new Error(`bad pg device group role: ${group}`)

  const withClient = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({
      connectionString: cfg.adminUrl,
      connectionTimeoutMillis: 10_000,
    })
    await client.connect()
    try {
      return await fn(client)
    } finally {
      await client.end().catch(() => {})
    }
  }

  return {
    async ensureDeviceRole(deviceId) {
      const role = deviceRoleName(deviceId)
      const password = randomBytes(24).toString('base64url')
      const roleId = pgIdent(role)
      const groupId = pgIdent(group)
      const passLit = pgLiteral(password)

      await withClient(async (client) => {
        // CREATE ROLE / ALTER ROLE cannot bind identifiers or passwords as
        // $params; both pieces are built only from allowlisted / generated values.
        const exists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
          [role],
        )
        if (exists.rows[0]?.exists) {
          await client.query(`ALTER ROLE ${roleId} LOGIN PASSWORD ${passLit}`)
        } else {
          await client.query(`CREATE ROLE ${roleId} LOGIN PASSWORD ${passLit}`)
        }
        await client.query(`GRANT ${groupId} TO ${roleId}`)
      })

      const url = buildDevicePgUrl(cfg.adminUrl, role, password)
      log(`[devices] ensured datahub role ${role}`)
      return { url, role }
    },

    async dropDeviceRole(deviceId) {
      const role = deviceRoleName(deviceId)
      const roleId = pgIdent(role)

      await withClient(async (client) => {
        const exists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
          [role],
        )
        if (!exists.rows[0]?.exists) return

        // Sequence: NOLOGIN → terminate backends → DROP OWNED BY → DROP ROLE.
        await client.query(`ALTER ROLE ${roleId} NOLOGIN`)
        await client.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE usename = $1 AND pid <> pg_backend_pid()`,
          [role],
        )
        // DROP OWNED BY must run in each DB the role may have privileges in;
        // we only connect to the memory DB (admin URL). Expected no-op for
        // device roles that never owned objects.
        await client.query(`DROP OWNED BY ${roleId}`)
        await client.query(`DROP ROLE IF EXISTS ${roleId}`)
      })
      log(`[devices] dropped datahub role ${role}`)
    },
  }
}

const WG_KEY = /^[A-Za-z0-9+/]{42,44}=$/
const isIpv4 = (s: string): boolean => {
  const parts = s.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}
/** IPv4 CIDR: dotted-quad + /0..32. Rejects bare IPs, ranges, oversize
 *  octets, extra slashes, and non-numeric junk (so the value is safe to
 *  pass as a single ssh/ufw argv token). */
export const isCidr = (s: string): boolean => {
  const [ip, prefix, ...rest] = s.split('/')
  return (
    rest.length === 0 &&
    isIpv4(ip) &&
    typeof prefix === 'string' &&
    /^\d{1,2}$/.test(prefix) &&
    Number(prefix) <= 32
  )
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
export function createSshRelayDriver(cfg: {
  relaySsh: string
  wgInterface: string
  sudo?: boolean
}): RelayDriver {
  const iface = cfg.wgInterface
  if (!/^[\w.-]+$/.test(iface)) throw new Error(`bad wg interface name: ${iface}`)
  // `sudo -n`: fail fast rather than hang if passwordless sudo isn't granted.
  const wrap = (argv: string[]): string[] => (cfg.sudo ? ['sudo', '-n', ...argv] : argv)
  return {
    async addPeer(publicKey, address) {
      if (!WG_KEY.test(publicKey)) throw new Error('bad public key')
      if (!isIpv4(address)) throw new Error('bad address')
      await sshExec(
        cfg.relaySsh,
        wrap(['wg', 'set', iface, 'peer', publicKey, 'allowed-ips', `${address}/32`]),
      )
      await sshExec(cfg.relaySsh, wrap(['wg-quick', 'save', iface]))
    },
    async removePeer(publicKey) {
      if (!WG_KEY.test(publicKey)) throw new Error('bad public key')
      await sshExec(cfg.relaySsh, wrap(['wg', 'set', iface, 'peer', publicKey, 'remove']))
      await sshExec(cfg.relaySsh, wrap(['wg-quick', 'save', iface]))
    },
    async handshakes() {
      const out = await sshExec(cfg.relaySsh, wrap(['wg', 'show', iface, 'latest-handshakes']))
      const map: Record<string, number> = {}
      for (const line of out.split('\n')) {
        const [key, ts] = line.trim().split(/\s+/)
        if (key && WG_KEY.test(key)) map[key] = Number(ts) * 1000
      }
      return map
    },
    async ensureForward(src, dest) {
      if (!isCidr(src)) throw new Error('bad forward source CIDR')
      if (!isCidr(dest)) throw new Error('bad forward dest CIDR')
      // `ufw route allow` is idempotent — a duplicate spec is a no-op ("Skipping
      // adding existing rule"). Safe to run on every process start / first enroll.
      // NB: sshExec joins argv into a remote command string the relay's shell
      // re-splits, so every token must be a single shell word — the comment is
      // hyphenated (not "rivet mesh device pool"), else ufw sees stray args.
      await sshExec(
        cfg.relaySsh,
        wrap([
          'ufw',
          'route',
          'allow',
          'from',
          src,
          'to',
          dest,
          'comment',
          'rivet-mesh-device-pool',
        ]),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// registry (JSON file — shared roster when RIVETOS_DEN_DEVICES_ROSTER is set,
// else per-node stateDir/mesh-devices.json; small, rewrite-on-change)

interface PendingEnroll {
  id: string
  name: string
  /** sha-256 unnecessary at this trust level; store the token, file is 0600-ish
   *  under the service user's state dir and single-use with a short TTL. */
  token: string
  address: string
  expiresAt: number
  /** Set when a per-device datahub role was minted for this pending QR. */
  pgRole?: string
}

interface Registry {
  devices: MeshDevice[]
  pending: PendingEnroll[]
}

const ENROLL_TTL_MS = 10 * 60 * 1000
/** Break orphaned `<roster>.lock` files left by a crashed process (NFS-safe
 *  O_EXCL locks have no automatic release). Enroll holds the lock across
 *  relay ssh, which is rare and should finish well under a minute. */
const FILE_LOCK_STALE_MS = 60_000
const FILE_LOCK_MAX_ATTEMPTS = 200

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
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * In-process promise-chain mutex. Closes TOCTOU races for concurrent handlers
 * in one den-server process (dual Add claiming the same address, enroll vs
 * revoke of the same pending). Held across slow relay ssh — enrollment is
 * rare; serializing is cheaper than half-applied relay + registry state.
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Cross-process / cross-node advisory lock on `<rosterPath>.lock` via
 * O_CREAT|O_EXCL (works on NFS without flock). Retry with jittered backoff;
 * reclaim locks whose written timestamp is older than FILE_LOCK_STALE_MS.
 * Nested under the in-process mutex so a single process does not thrash the
 * lock file. Critical sections re-read the roster inside both locks.
 */
export async function withRosterFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < FILE_LOCK_MAX_ATTEMPTS; attempt++) {
    let fd: number | undefined
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      writeFileSync(fd, `${process.pid} ${Date.now()}\n`)
      try {
        return await fn()
      } finally {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        fd = undefined
        try {
          unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
      }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Stale-lock recovery: crashed holder left the file behind.
      try {
        const content = readFileSync(lockPath, 'utf8')
        const ts = Number(content.trim().split(/\s+/)[1])
        if (Number.isFinite(ts) && Date.now() - ts > FILE_LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // Unreadable or already gone — retry acquire.
      }
      await sleep(10 + Math.random() * 20 * Math.min(attempt + 1, 10))
    }
  }
  throw new Error(`timeout acquiring roster lock: ${lockPath}`)
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
  /**
   * Override roster file path (tests / advanced). When unset, uses
   * config.rosterPath if set, else `<stateDir>/mesh-devices.json`.
   */
  rosterPath?: string
  /** The externally reachable den base URL to embed in the QR (client can
   *  override with its own origin when it renders the QR). */
  gatewayUrl: string
  driver?: RelayDriver | null
  /** Injected in tests; production builds from config.pgAdminUrl when set. */
  datahubAdmin?: DatahubAdminDriver | null
  log?: (msg: string) => void
  now?: () => number
}): DevicesRoutes {
  const { config } = opts
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now
  const file =
    opts.rosterPath?.trim() || config.rosterPath.trim() || join(opts.stateDir, 'mesh-devices.json')
  const lockPath = `${file}.lock`
  const processMutex = makeMutex()
  /** In-process mutex, then cross-node file lock, then re-read inside fn. */
  const withLock = <T>(fn: () => T | Promise<T>): Promise<T> =>
    processMutex(() => withRosterFileLock(lockPath, fn))
  const driver =
    opts.driver !== undefined
      ? opts.driver
      : config.relaySsh
        ? createSshRelayDriver({
            relaySsh: config.relaySsh,
            wgInterface: config.wgInterface,
            sudo: config.relaySudo,
          })
        : null
  const datahubAdmin =
    opts.datahubAdmin !== undefined
      ? opts.datahubAdmin
      : config.pgAdminUrl.trim()
        ? createPgDatahubAdminDriver({
            adminUrl: config.pgAdminUrl.trim(),
            groupRole: config.pgDeviceGroup || 'rivet_device',
            log,
          })
        : null

  // Ensure the relay's pool→LAN forwarding rule exactly once per process,
  // lazily on the first enroll (the relay is reachable by then). A failure
  // here shouldn't sink the enroll — the peer add is what matters; log and
  // move on, the operator can add the ufw rule by hand.
  let forwardEnsured = false
  const ensureForwardOnce = async (): Promise<void> => {
    if (forwardEnsured || !driver?.ensureForward) return
    if (!config.relayForwardSrc || !config.relayForwardDest) return
    forwardEnsured = true // set before the await so concurrent enrolls don't double-run
    try {
      await driver.ensureForward(config.relayForwardSrc, config.relayForwardDest)
      log(
        `[devices] relay forwarding ensured: ${config.relayForwardSrc} → ${config.relayForwardDest}`,
      )
    } catch (e) {
      forwardEnsured = false // let a later enroll retry
      log(`[devices] relay forwarding rule failed (add it manually): ${(e as Error).message}`)
    }
  }

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const sweep = (reg: Registry): void => {
    reg.pending = reg.pending.filter((p) => p.expiresAt > now())
  }

  const enrollConfig = (address: string, pgUrl: string): DeviceEnrollConfig => ({
    sharedHost: config.sharedHost,
    sharedExport: config.sharedExport,
    pgUrl,
    embedUrl: config.embedUrl,
    wgEndpoint: config.wgEndpoint,
    wgPeerPublicKey: config.wgPublicKey,
    wgAddress: `${address}/32`,
    wgAllowedIps: config.allowedIps,
    homeSubnet: config.homeSubnet,
  })

  /**
   * When the admin driver is configured: mint a per-device role and return
   * its URL. On failure (datahub down, etc.) log and return empty pgUrl —
   * mesh enroll still proceeds (decision 1). Never falls back to shared creds.
   * When the driver is off: shared config.pgUrl (feature opt-in).
   */
  const resolvePgForDevice = async (
    deviceId: string,
  ): Promise<{ pgUrl: string; pgRole?: string }> => {
    if (!datahubAdmin) return { pgUrl: config.pgUrl }
    try {
      const { url, role } = await datahubAdmin.ensureDeviceRole(deviceId)
      return { pgUrl: url, pgRole: role }
    } catch (e) {
      log(
        `[devices] datahub role mint failed for ${deviceId}: ${(e as Error).message} — enrolling without pgUrl`,
      )
      return { pgUrl: '' }
    }
  }

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
        // can't hand out the same free address in their QRs. Role minting is
        // also under the lock so the registry always records pgRole with the
        // pending that carries that role's QR password.
        const result = await withLock(async () => {
          const reg = loadRegistry(file)
          sweep(reg)
          const taken = new Set([
            ...reg.devices.map((d) => d.address),
            ...reg.pending.map((p) => p.address),
          ])
          const address = allocateAddress(config.pool, taken)
          if (!address) return null
          const id = randomUUID()
          const { pgUrl, pgRole } = await resolvePgForDevice(id)
          const pending: PendingEnroll = {
            id,
            name,
            token: randomBytes(24).toString('base64url'),
            address,
            expiresAt: now() + ENROLL_TTL_MS,
            ...(pgRole ? { pgRole } : {}),
          }
          reg.pending.push(pending)
          saveRegistry(file, reg)
          return { pending, pgUrl }
        })
        if (!result) {
          json(res, 409, { error: 'address pool exhausted (or RIVETOS_DEN_DEVICES_POOL unset)' })
          return true
        }
        const qr: DeviceEnrollQr = {
          v: 1,
          kind: 'rivet-mesh-enroll',
          gateway: opts.gatewayUrl,
          token: result.pending.token,
          config: enrollConfig(result.pending.address, result.pgUrl),
        }
        log(
          `[devices] enrollment opened for "${name}" (${result.pending.address}, expires in 10m)${
            result.pending.pgRole ? ` role=${result.pending.pgRole}` : ''
          }`,
        )
        json(res, 200, {
          id: result.pending.id,
          name,
          address: result.pending.address,
          expiresAt: result.pending.expiresAt,
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
          const pgRole = dev?.pgRole ?? pend?.pgRole
          if (pgRole && datahubAdmin) {
            try {
              // drop by device id (role name is derived deterministically)
              await datahubAdmin.dropDeviceRole(id)
            } catch (e) {
              return {
                status: 502 as const,
                error: `datahub role revoke failed: ${(e as Error).message}`,
              }
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
            await ensureForwardOnce()
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

        // Re-ensure so the enroll response carries a working password. The
        // phone prefers this config over the QR (see MeshEnroll.kt). If mint
        // fails, omit pgUrl rather than shipping the shared credential.
        let pgUrl: string
        let pgRole = pending.pgRole
        if (datahubAdmin) {
          const minted = await resolvePgForDevice(pending.id)
          pgUrl = minted.pgUrl
          pgRole = minted.pgRole ?? pgRole
        } else {
          pgUrl = config.pgUrl
        }

        const device: MeshDevice = {
          id: pending.id,
          name: name ?? pending.name,
          publicKey,
          address: pending.address,
          createdAt: pending.expiresAt - ENROLL_TTL_MS,
          enrolledAt: now(),
          lastHandshake: null,
          ...(pgRole ? { pgRole } : {}),
        }
        reg.devices.push(device)
        saveRegistry(file, reg)
        log(
          `[devices] enrolled "${device.name}" (${device.address})${driver ? '' : ' [relay driver off — add peer manually]'}${
            pgRole ? ` role=${pgRole}` : ''
          }`,
        )
        return {
          status: 200 as const,
          device: { id: device.id, name: device.name, address: device.address },
          config: enrollConfig(pending.address, pgUrl),
        }
      })

      if (outcome.status === 200)
        json(res, 200, { ok: true, device: outcome.device, config: outcome.config })
      else json(res, outcome.status, { error: outcome.error })
      return true
    },
  }
}
