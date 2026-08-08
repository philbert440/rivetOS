// Environment-driven configuration for the den server.

import { homedir } from 'node:os'
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
  /** RIVETOS_DEN_TERM_OPEN=1: explicit operator opt-out of the tokenless
   *  security gate — terminals stay enabled with no token off-loopback.
   *  For trusted private networks; anything that can reach the port can
   *  then spawn a shell as the service user. Loudly logged, never default. */
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
   *  before SIGHUP — even if a viewer is still attached. 0 disables.
   *  Resets on every activity bump so long-running turns stay alive. */
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
  /** RIVETOS_DEN_AUDIO_OPEN=1: allow tokenless off-loopback (trusted LAN). */
  open: boolean
  /** Runtime dir for FIFO + audit (default: $stateDir/audio). Empty = derive. */
  dir: string
  /** Logical device name reported in status / ready frames. */
  deviceName: string
  /** PCM sample rate Hz (s16le mono). */
  sampleRate: number
}

export interface DenConfig {
  port: number
  host: string
  /** Bearer token required on every non-health endpoint when set. Mesh nodes
   *  behind the LAN can leave it empty; the hosted tier must not. */
  token: string
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
  /** RIVETOS_DEN_FILES_OPEN=1: explicit opt-out of the tokenless security
   *  gate for /api/files/* — same trusted-LAN posture as term.open. Without
   *  it, tokenless non-loopback nodes get files routes refused, not exposed. */
  filesOpen: boolean
  /** Mesh device enrollment (/api/devices/*, Settings → Devices). Optional
   *  so hand-built test configs predating the feature stay valid. */
  devices?: DenDevicesConfig
  /** Harness attachment staging (POST /api/uploads). Optional for the same
   *  reason as `devices`. */
  uploads?: DenUploadsConfig
}

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
  return {
    port: intEnv(env, 'RIVETOS_DEN_PORT', 5174),
    // fail safe: loopback unless explicitly exposed — the default token is
    // empty, so 0.0.0.0 out of the box would be unauthenticated on all
    // interfaces. Mesh deployments set RIVETOS_DEN_HOST=0.0.0.0.
    host: env.RIVETOS_DEN_HOST ?? '127.0.0.1',
    token: env.RIVETOS_DEN_TOKEN ?? '',
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
      // 30 min default — auto-close harness sessions that go quiet (chat or
      // terminal). 0 disables. Distinct from detachedTtlMs (unattached only).
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
  }
}
