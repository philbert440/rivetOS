// Environment-driven configuration for the den server.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  mergeUserDbs,
  parseUserDbs,
  parseUsersRegistry,
  registryFromEnv,
  type UserDbEntry,
  type UsersRegistry,
} from '@rivetos/types'
import { join } from 'node:path'
import { DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_TTL_MS } from './harness/uploads.js'

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  // Read from the PASSED env — loadConfig(env) callers (the embedded
  // gateway) build a synthetic env object; reading process.env here made
  // den.port (and the TTLs) silently ignore config on every embedded node.
  const raw = env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function truthyEnv(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  return v === '1' || v === 'on'
}

export interface DenTermConfig {
  /** Opt-in master switch — terminals are OFF unless RIVETOS_DEN_TERM=1/on.
   *  Spawning a shell as the service user is a deliberate act, never a default. */
  enabled: boolean
  /** Ignored: terminals require gateway mTLS (or loopback). Kept for config parse. */
  open: boolean
  /** Operator-owned command roster (see term/roster.ts). Re-read lazily, so
   *  edits don't need a restart. */
  configFile: string
  /** Max concurrently running PTYs. */
  maxPtys: number
  /** Per-PTY scrollback ring cap (bytes). */
  scrollbackBytes: number
  /** How long a PTY with no attached viewers survives before SIGHUP (ms). */
  detachedTtlMs: number
  /** How long a PTY may sit with no activity (output / inject / write)
   *  before SIGHUP. Suspended while a viewer is attached (restarts on the last
   *  detach). 0 disables. Resets on every activity bump so long-running turns
   *  stay alive. */
  idleTtlMs: number
  /** How long an exited PTY record lingers (scrollback inspectable) before
   *  it is reaped (ms). */
  exitLingerMs: number
  /** Grace after a fresh PTY's first output before buffered chat injects are
   *  flushed — lets the harness TUI settle so the first turn isn't dropped. */
  injectReadyMs: number
  /** Delay between writing a chat inject's text and its submit CR. The two
   *  must be separate PTY writes: harness TUIs (claude/grok) run paste
   *  detection, and a CR fused onto multi-line/long text is absorbed as a
   *  literal newline in the composer instead of submitting the turn. */
  injectSubmitDelayMs?: number
}

/** Host→node microphone bridge (MicBridge). See docs/MICBRIDGE.md. */
export interface DenAudioConfig {
  /** Opt-in master switch — OFF unless RIVETOS_DEN_AUDIO=1/on. */
  enabled: boolean
  /** Ignored; MicBridge uses gateway mTLS. Kept for config parse. */
  open: boolean
  /** Runtime dir for FIFO + audit (default: $stateDir/audio). Empty = derive. */
  dir: string
  /** Logical device name reported in status / ready frames. */
  deviceName: string
  /** PCM sample rate Hz (s16le mono). */
  sampleRate: number
}

/** TLS for the gateway. When set, den listens with HTTPS and (by default)
 *  requires a Rivet CA device client certificate for non-loopback clients.
 *  Bearer tokens are not supported — enroll devices with `rivet-ca.sh issue-client`. */
export interface DenTlsFileConfig {
  /** Path to the node server certificate (PEM). */
  certPath: string
  /** Path to the matching private key (PEM). */
  keyPath: string
  /** Path to the CA chain used to verify client certs (default: Rivet intermediate chain). */
  caPath: string
  /** Require a verified device client cert off-loopback (default true). */
  requireClientCert: boolean
}

export interface DenConfig {
  port: number
  host: string
  /**
   * Always empty — gateway auth is Rivet CA client certificates only.
   * Field retained so older test configs that still pass `token: ''` typecheck.
   */
  token: string
  /** HTTPS + mTLS client auth. Empty paths = plain HTTP (loopback only). */
  tls: DenTlsFileConfig
  /** Directory for persisted state (per-viewer layouts). */
  stateDir: string
  /** Built viewer app to serve at / (optional). */
  staticDir: string
  /** SpritePack root served at /packs/ (optional). */
  packsDir: string
  /** 302 target for GET / — e.g. '/wiki' makes the wiki the landing page. */
  rootRedirect: string
  /** How long an ended session's room lingers before eviction (ms). */
  evictTtlMs: number
  /** Mesh roster for GET /mesh.json. Empty = try the canonical
   *  /rivet-shared/mesh.json, then ~/.rivetos/mesh.json. */
  meshFile: string
  /** How long one /mesh.json overview (roster read + peer probes) is served
   *  from cache (ms). */
  meshCacheMs: number
  /** Local PTY terminals (opt-in; see term/). */
  term: DenTermConfig
  /** Host mic → virtual node input (opt-in; see audio/ + docs/MICBRIDGE.md). */
  audio: DenAudioConfig
  /** Shared filestore root for /api/files/* (browse/download/upload).
   *  Empty string disables the routes entirely. */
  filesRoot: string
  /** Ignored; files use gateway mTLS. Kept for config parse. */
  filesOpen: boolean
  /** Mesh device enrollment (/api/devices/*, Settings → Devices). Optional
   *  so hand-built test configs predating the feature stay valid. */
  devices?: DenDevicesConfig
  /** Harness attachment staging (POST /api/uploads). Optional for the same
   *  reason as `devices`. */
  uploads?: DenUploadsConfig
  /**
   * Shared memory DB (`RIVETOS_PG_URL`) — the same database capture writes to.
   * den-server reads it for exactly one thing today: the post-restart alias
   * reconstructor, which reads rotation breadcrumbs back out of
   * `ros_messages` (see harness/alias-restore.ts). Empty/absent = no memory DB
   * on this node, so nothing to reconstruct from. Optional for the same reason
   * as `devices`: hand-built test configs predating the field stay valid.
   */
  pgUrl?: string
  /**
   * Per-user routing (RIVETOS_DEN_DEVICE_USERS): mTLS device id → user id.
   * A request from a mapped device gets `x-rivetos-user: <userId>` stamped
   * before gateway dispatch, and that device's PTY spawns get the user's
   * memory env (see `userDbs`). Devices not in the map are the node owner:
   * no header, no env override — existing behavior.
   */
  deviceUsers?: Record<string, string>
  /**
   * Per-user memory targets (RIVETOS_USER_DBS): user id → { pgUrl, envFile? }.
   * Shared policy (@rivetos/types parseUserDbs — pgUrl required). Read by the
   * PTY env override; the same env var also drives capture routing in
   * @rivetos/memory-postgres and provider-claude-cli.
   */
  userDbs?: Record<string, UserDbEntry>
  /**
   * First-class tenancy registry. File (`RIVETOS_USERS_FILE`) wins; otherwise
   * synthesized from the #561 env maps so live Coco routing keeps working.
   * Undefined = tenancy off (single-owner node).
   */
  usersRegistry?: UsersRegistry
}

/** Parse a JSON object env var. Malformed input logs loudly and yields
 *  undefined: routing collapses to owner behavior rather than crashing den.
 *  That trade-off (availability of the whole private mesh over hard-failing
 *  every device on a config typo) is deliberate — the parse error names the
 *  variable so the typo is caught on the first log read. */
function jsonEnv(env: NodeJS.ProcessEnv, name: string): Record<string, unknown> | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    /* fall through */
  }
  console.error(`[den] ${name} is not a JSON object — PER-USER ROUTING DISABLED, fix the env var`)
  return undefined
}

/** RIVETOS_DEN_DEVICE_USERS: values must be non-empty strings (user ids).
 *  Keys are bare device ids — the `device:` CN prefix is already stripped by
 *  deviceIdentityFromCert. Invalid entries are dropped with a warning. */
function parseDeviceUsers(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const obj = jsonEnv(env, 'RIVETOS_DEN_DEVICE_USERS')
  if (!obj) return undefined
  const out: Record<string, string> = {}
  for (const [deviceId, userId] of Object.entries(obj)) {
    if (deviceId.trim() !== '' && typeof userId === 'string' && userId.trim() !== '') {
      out[deviceId.trim()] = userId.trim()
    } else {
      console.error(`[den] RIVETOS_DEN_DEVICE_USERS entry for "${deviceId}" is invalid — dropped`)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// RIVETOS_USER_DBS parsing is the SHARED policy in @rivetos/types
// (parseUserDbs): pgUrl required, envFile additive. den's stamping, the
// memory plugin's stores, and the claude-cli spawn env must agree on what a
// routable user is, or a device can be tagged with an id another layer
// cannot route.

/** Staging area for remote-client harness attachments (see harness/uploads.ts). */
export interface DenUploadsConfig {
  /** Staging directory. Empty = `<stateDir>/uploads`. */
  dir: string
  /** Per-upload byte ceiling (RIVETOS_DEN_UPLOAD_MAX_BYTES). */
  maxBytes: number
  /** How long a staged file survives before the sweep unlinks it
   *  (RIVETOS_DEN_UPLOAD_TTL_MS). 0 disables retention entirely — files then
   *  live until an operator removes them. */
  ttlMs: number
}

export interface DenDevicesConfig {
  /** RIVETOS_DEN_DEVICES=1 enables the routes. */
  enabled: boolean
  relaySsh: string
  relaySudo: boolean
  wgInterface: string
  pool: string
  wgEndpoint: string
  wgPublicKey: string
  allowedIps: string
  homeSubnet: string
  sharedHost: string
  sharedExport: string
  /**
   * Absolute path to the mesh-devices roster JSON (shared across nodes).
   * Empty = per-node `<stateDir>/mesh-devices.json`. Env:
   * RIVETOS_DEN_DEVICES_ROSTER.
   */
  rosterPath: string
  pgUrl: string
  embedUrl: string
  /** Device pool CIDR + home-LAN CIDR for the relay's pool→LAN forward rule.
   *  Both empty = relay forwarding is managed by hand. */
  relayForwardSrc: string
  relayForwardDest: string
  /** Externally reachable den base URL embedded in enrollment QRs. Empty =
   *  the web client substitutes its own origin. */
  gatewayUrl: string
  /**
   * CREATEROLE datahub admin URL for per-device role mint/drop. Empty =
   * feature off (shared pgUrl in QR). Env: RIVETOS_DEN_DEVICES_PG_ADMIN_URL.
   */
  pgAdminUrl: string
  /** Group role device roles inherit (default rivet_device). */
  pgDeviceGroup: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DenConfig {
  const defaultCa =
    env.RIVETOS_DEN_TLS_CA?.trim() ||
    env.RIVET_CA_CHAIN?.trim() ||
    '/rivet-shared/rivet-ca/intermediate/chain.pem'
  // Client cert required unless explicitly set to 0/off/false.
  const requireClientRaw = (env.RIVETOS_DEN_TLS_REQUIRE_CLIENT ?? '1').trim().toLowerCase()
  const requireClientCert = !(
    requireClientRaw === '0' ||
    requireClientRaw === 'off' ||
    requireClientRaw === 'false' ||
    requireClientRaw === 'no'
  )
  const deviceUsers = parseDeviceUsers(env)
  const userDbs = parseUserDbs(env.RIVETOS_USER_DBS)
  return {
    port: intEnv(env, 'RIVETOS_DEN_PORT', 5174),
    // fail safe: loopback unless explicitly exposed. Off-loopback needs TLS
    // + device client certs (see auth.ts) — plain 0.0.0.0 HTTP is rejected at
    // listen time when tls paths are empty.
    host: env.RIVETOS_DEN_HOST ?? '127.0.0.1',
    // Bearer removed — always empty. Old RIVETOS_DEN_TOKEN env is ignored.
    token: '',
    tls: {
      certPath: env.RIVETOS_DEN_TLS_CERT?.trim() || '',
      keyPath: env.RIVETOS_DEN_TLS_KEY?.trim() || '',
      caPath: defaultCa,
      requireClientCert,
    },
    stateDir: env.RIVETOS_DEN_STATE_DIR ?? join(homedir(), '.rivetos', 'den'),
    staticDir: env.RIVETOS_DEN_STATIC_DIR ?? '',
    rootRedirect: env.RIVETOS_DEN_ROOT_REDIRECT ?? '',
    packsDir: env.RIVETOS_DEN_PACKS_DIR ?? '',
    evictTtlMs: intEnv(env, 'RIVETOS_DEN_EVICT_TTL_MS', 24 * 60 * 60 * 1000),
    meshFile: env.RIVETOS_DEN_MESH_FILE ?? '',
    meshCacheMs: intEnv(env, 'RIVETOS_DEN_MESH_CACHE_MS', 10_000),
    term: {
      enabled: truthyEnv(env.RIVETOS_DEN_TERM),
      open: truthyEnv(env.RIVETOS_DEN_TERM_OPEN),
      configFile: env.RIVETOS_DEN_TERM_CONFIG ?? join(homedir(), '.rivetos', 'den-term.json'),
      maxPtys: intEnv(env, 'RIVETOS_DEN_TERM_MAX', 4),
      scrollbackBytes: intEnv(env, 'RIVETOS_DEN_TERM_SCROLLBACK', 262_144),
      detachedTtlMs: intEnv(env, 'RIVETOS_DEN_TERM_DETACHED_TTL_MS', 1_800_000),
      // 30 min default — auto-close harness sessions that go quiet with no
      // viewer attached. 0 disables. Distinct from detachedTtlMs (which
      // does not care about activity).
      idleTtlMs: intEnv(env, 'RIVETOS_DEN_TERM_IDLE_TTL_MS', 1_800_000),
      exitLingerMs: intEnv(env, 'RIVETOS_DEN_TERM_EXIT_LINGER_MS', 60_000),
      injectReadyMs: intEnv(env, 'RIVETOS_DEN_TERM_INJECT_READY_MS', 500),
      injectSubmitDelayMs: intEnv(env, 'RIVETOS_DEN_TERM_INJECT_SUBMIT_DELAY_MS', 80),
    },
    audio: {
      enabled: truthyEnv(env.RIVETOS_DEN_AUDIO),
      open: truthyEnv(env.RIVETOS_DEN_AUDIO_OPEN),
      dir: env.RIVETOS_DEN_AUDIO_DIR ?? '',
      deviceName: env.RIVETOS_DEN_AUDIO_DEVICE ?? 'RivetHub Mic',
      sampleRate: intEnv(env, 'RIVETOS_DEN_AUDIO_RATE', 16_000),
    },
    filesRoot: env.RIVETOS_DEN_FILES_ROOT ?? '/rivet-shared',
    filesOpen: truthyEnv(env.RIVETOS_DEN_FILES_OPEN),
    devices: {
      enabled: truthyEnv(env.RIVETOS_DEN_DEVICES),
      relaySsh: env.RIVETOS_DEN_DEVICES_RELAY_SSH ?? '',
      relaySudo: truthyEnv(env.RIVETOS_DEN_DEVICES_RELAY_SUDO),
      wgInterface: env.RIVETOS_DEN_DEVICES_WG_IFACE ?? 'wg0',
      pool: env.RIVETOS_DEN_DEVICES_POOL ?? '',
      wgEndpoint: env.RIVETOS_DEN_DEVICES_WG_ENDPOINT ?? '',
      wgPublicKey: env.RIVETOS_DEN_DEVICES_WG_PUBKEY ?? '',
      allowedIps: env.RIVETOS_DEN_DEVICES_ALLOWED_IPS ?? '',
      homeSubnet: env.RIVETOS_DEN_DEVICES_HOME_SUBNET ?? '',
      sharedHost: env.RIVETOS_DEN_DEVICES_SHARED_HOST ?? '',
      sharedExport: env.RIVETOS_DEN_DEVICES_SHARED_EXPORT ?? '/rivet-shared',
      rosterPath: env.RIVETOS_DEN_DEVICES_ROSTER ?? '',
      pgUrl: env.RIVETOS_PG_URL ?? '',
      embedUrl: env.RIVETOS_EMBED_URL ?? '',
      relayForwardSrc: env.RIVETOS_DEN_DEVICES_FWD_SRC ?? '',
      relayForwardDest: env.RIVETOS_DEN_DEVICES_FWD_DEST ?? '',
      gatewayUrl: env.RIVETOS_DEN_DEVICES_GATEWAY_URL ?? '',
      pgAdminUrl: env.RIVETOS_DEN_DEVICES_PG_ADMIN_URL ?? '',
      pgDeviceGroup: env.RIVETOS_DEN_DEVICES_PG_DEVICE_GROUP ?? 'rivet_device',
    },
    uploads: {
      dir: env.RIVETOS_DEN_UPLOAD_DIR ?? '',
      maxBytes: intEnv(env, 'RIVETOS_DEN_UPLOAD_MAX_BYTES', DEFAULT_UPLOAD_MAX_BYTES),
      ttlMs: intEnv(env, 'RIVETOS_DEN_UPLOAD_TTL_MS', DEFAULT_UPLOAD_TTL_MS),
    },
    // Same env var `devices.pgUrl` carries — one memory DB per node. Lifted to
    // the top level because it is no longer a devices-only concern: the alias
    // reconstructor reads it with no relation to device enrollment.
    pgUrl: env.RIVETOS_PG_URL ?? '',
    deviceUsers,
    userDbs,
    usersRegistry: loadUsersRegistry(env, deviceUsers, userDbs),
  }
}

function readRegistryFile(path: string | undefined): UsersRegistry | undefined {
  if (!path) return undefined
  if (!existsSync(path)) return undefined
  try {
    return parseUsersRegistry(readFileSync(path, 'utf8'))
  } catch {
    console.error(`[den] users registry "${path}" unreadable`)
    return undefined
  }
}

function loadUsersRegistry(
  env: NodeJS.ProcessEnv,
  deviceUsers: Record<string, string> | undefined,
  userDbs: Record<string, UserDbEntry> | undefined,
): UsersRegistry | undefined {
  const explicit = env.RIVETOS_USERS_FILE?.trim()
  const fileReg = explicit
    ? readRegistryFile(explicit)
    : (readRegistryFile('/rivet-shared/rivetos/users.json') ??
      readRegistryFile(join(homedir(), '.rivetos', 'users.json')))
  if (explicit && !fileReg) {
    console.error(
      `[den] RIVETOS_USERS_FILE="${explicit}" missing or invalid — falling back to env maps`,
    )
  }
  const envReg = registryFromEnv({
    deviceUsers,
    userDbs,
    ownerPgUrl: env.RIVETOS_PG_URL,
    ownerUserId: env.RIVETOS_OWNER_USER_ID,
  })
  const base = fileReg ?? envReg
  if (!base) return undefined
  return mergeUserDbs(base, userDbs, env.RIVETOS_PG_URL)
}
