/**
 * Gateway registrar — G0 (Appendix F): the den server runs INSIDE the
 * rivetos process and becomes the per-node gateway. Later PRs mount /api/*
 * route families through `extraRoutes` (G1 tasks, G2 events, …) — this file
 * owns config mapping, the bearer token, lifecycle, and the port.
 *
 * Cutover: `rivetos update` retires the standalone rivet-den.service before
 * restarting rivetos (the embedded gateway binds the same port). If the old
 * unit is somehow still holding the port, we log loudly and skip — the den
 * routes keep being served by the old unit until the next update pass.
 *
 * Auth: Rivet CA device client certificates (mTLS). den.token / bearer
 * tokens are removed. Off-loopback requires RIVETOS_DEN_TLS_CERT/KEY (node
 * leaf from issue-node) + clients enrolled via issue-client.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { logger, createGatewayChannel, createOpenAICompatRoute, type Runtime } from '@rivetos/core'
import type { GatewayRoute, HarnessDriver, SessionWsFrame } from '@rivetos/types'

/** WS upgrade handler shape den-server accepts (same as the channel's). */
interface GatewayUpgrade {
  path: string
  handle: (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void
}
import type { RivetConfig } from '../config.js'

const log = logger('Boot:Gateway')

/** @deprecated Bearer gateway tokens removed — use rivet-ca issue-client. */
export const GATEWAY_TOKEN_FILE = join(homedir(), '.rivetos', 'gateway.token')

/**
 * @deprecated No longer mints or reads bearer tokens. Throws so callers that
 * still invoke `rivetos gateway token` fail loudly instead of inventing secrets.
 */
export function ensureGatewayToken(_file: string = GATEWAY_TOKEN_FILE): string {
  throw new Error(
    'Gateway bearer tokens are removed. Enroll devices with: rivet-ca.sh issue-client <device-id> ' +
      'and configure den TLS (RIVETOS_DEN_TLS_CERT/KEY). See docs/GATEWAY-MTLS.md',
  )
}

/**
 * Shared export mount used for mesh.json / filestore elsewhere in boot.
 * Prefer devices.shared_export, then den.files_root, then mesh.storage_dir
 * (default /rivet-shared when mesh is enabled). Empty = no shared mount.
 */
function resolveSharedExport(
  config: RivetConfig,
  devices: NonNullable<NonNullable<RivetConfig['den']>['devices']>,
): string {
  const den = config.den ?? {}
  if (devices.shared_export?.trim()) return devices.shared_export.trim()
  if (typeof den.files_root === 'string' && den.files_root.trim() !== '') {
    return den.files_root.trim()
  }
  if (config.mesh?.storage_dir?.trim()) return config.mesh.storage_dir.trim()
  if (config.mesh?.enabled === true) return '/rivet-shared'
  return ''
}

/**
 * Roster path for mesh device add/revoke. Explicit devices.roster_path wins;
 * else `<sharedExport>/mesh/mesh-devices.json` when a shared mount is known;
 * else undefined so den-server keeps per-node stateDir (single-node default).
 */
export function resolveDevicesRosterPath(
  config: RivetConfig,
  devices: NonNullable<NonNullable<RivetConfig['den']>['devices']>,
): string | undefined {
  if (devices.roster_path?.trim()) return devices.roster_path.trim()
  const shared = resolveSharedExport(config, devices)
  if (!shared) return undefined
  return join(shared, 'mesh', 'mesh-devices.json')
}

/**
 * Map the config's den: section onto the den server's env contract and let
 * its own loadConfig apply defaults — one source of truth for defaults
 * (mirrors the retired den.env generation in the update CLI).
 */
export function buildGatewayEnv(config: RivetConfig, installRoot: string): Record<string, string> {
  const den = config.den ?? {}
  const terminal = den.terminal
  const env: Record<string, string> = {
    RIVETOS_DEN_HOST: den.host?.trim() || '127.0.0.1',
    RIVETOS_DEN_PORT: String(den.port ?? 5174),
    RIVETOS_DEN_STATIC_DIR: den.static_dir?.trim() || defaultStaticDir(installRoot),
    RIVETOS_DEN_PACKS_DIR:
      den.packs_dir?.trim() || join(installRoot, 'packages', 'den-packs', 'packs'),
  }
  if (den.root_redirect?.trim()) env.RIVETOS_DEN_ROOT_REDIRECT = den.root_redirect.trim()
  if (den.files_root !== undefined) env.RIVETOS_DEN_FILES_ROOT = den.files_root.trim()
  // files_open defaults to the terminal posture: a node the operator already
  // opted into tokenless trusted-LAN terminals gets the files browser too.
  if (den.files_open === true || (den.files_open === undefined && terminal?.open === true))
    env.RIVETOS_DEN_FILES_OPEN = '1'
  if (terminal?.enabled === true) env.RIVETOS_DEN_TERM = '1'
  if (terminal?.open === true) env.RIVETOS_DEN_TERM_OPEN = '1'
  if (typeof terminal?.idle_ttl_ms === 'number' && Number.isFinite(terminal.idle_ttl_ms))
    env.RIVETOS_DEN_TERM_IDLE_TTL_MS = String(Math.max(0, Math.floor(terminal.idle_ttl_ms)))
  // MicBridge (docs/MICBRIDGE.md): den-server only sees this built env map
  // (not the full process env), so wire RIVETOS_DEN_AUDIO here. Follow the
  // terminal posture — same trust domain as shell/TUI on the node.
  if (terminal?.enabled === true) env.RIVETOS_DEN_AUDIO = '1'
  if (terminal?.open === true) env.RIVETOS_DEN_AUDIO_OPEN = '1'
  // Mesh device enrollment (Settings → Devices). pgUrl/embedUrl for the QR
  // come from the runtime's own RIVETOS_PG_URL/EMBED_URL (den-server reads
  // those directly), so they aren't repeated here.
  const devices = den.devices
  if (devices?.enabled === true) {
    env.RIVETOS_DEN_DEVICES = '1'
    // den-server's loadConfig only sees the env we build here (not the whole
    // process env), so forward the runtime's own datahub coords for the QR.
    const pg = process.env.RIVETOS_PG_URL?.trim()
    const embed = process.env.RIVETOS_EMBED_URL?.trim()
    if (pg) env.RIVETOS_PG_URL = pg
    if (embed) env.RIVETOS_EMBED_URL = embed
    if (devices.relay_ssh?.trim()) env.RIVETOS_DEN_DEVICES_RELAY_SSH = devices.relay_ssh.trim()
    if (devices.relay_sudo === true) env.RIVETOS_DEN_DEVICES_RELAY_SUDO = '1'
    if (devices.wg_interface?.trim()) env.RIVETOS_DEN_DEVICES_WG_IFACE = devices.wg_interface.trim()
    if (devices.pool?.trim()) env.RIVETOS_DEN_DEVICES_POOL = devices.pool.trim()
    if (devices.wg_endpoint?.trim())
      env.RIVETOS_DEN_DEVICES_WG_ENDPOINT = devices.wg_endpoint.trim()
    if (devices.wg_public_key?.trim())
      env.RIVETOS_DEN_DEVICES_WG_PUBKEY = devices.wg_public_key.trim()
    if (devices.allowed_ips?.trim())
      env.RIVETOS_DEN_DEVICES_ALLOWED_IPS = devices.allowed_ips.trim()
    if (devices.home_subnet?.trim())
      env.RIVETOS_DEN_DEVICES_HOME_SUBNET = devices.home_subnet.trim()
    if (devices.relay_forward_src?.trim())
      env.RIVETOS_DEN_DEVICES_FWD_SRC = devices.relay_forward_src.trim()
    if (devices.relay_forward_dest?.trim())
      env.RIVETOS_DEN_DEVICES_FWD_DEST = devices.relay_forward_dest.trim()
    if (devices.shared_host?.trim())
      env.RIVETOS_DEN_DEVICES_SHARED_HOST = devices.shared_host.trim()
    if (devices.shared_export?.trim())
      env.RIVETOS_DEN_DEVICES_SHARED_EXPORT = devices.shared_export.trim()
    if (devices.gateway_url?.trim())
      env.RIVETOS_DEN_DEVICES_GATEWAY_URL = devices.gateway_url.trim()
    // Shared roster so any mesh node can add/revoke against one file.
    // Explicit roster_path wins; else default under the shared export mount.
    const rosterPath = resolveDevicesRosterPath(config, devices)
    if (rosterPath) {
      try {
        mkdirSync(dirname(rosterPath), { recursive: true })
      } catch {
        // Mount may not be ready at boot; den-server mkdir's again on write.
      }
      env.RIVETOS_DEN_DEVICES_ROSTER = rosterPath
    }
    // Per-device datahub roles: prefer config, else process env (so ops can
    // inject the secret without putting it in config.yaml).
    const pgAdmin =
      devices.pg_admin_url?.trim() || process.env.RIVETOS_DEN_DEVICES_PG_ADMIN_URL?.trim()
    if (pgAdmin) env.RIVETOS_DEN_DEVICES_PG_ADMIN_URL = pgAdmin
    if (devices.pg_device_group?.trim())
      env.RIVETOS_DEN_DEVICES_PG_DEVICE_GROUP = devices.pg_device_group.trim()
  }
  // Harness attachment staging (POST /api/uploads). The defaults suit every
  // node we run, so there is no config.yaml surface — but den-server sees
  // only this map, never the process env, so without a passthrough the
  // documented cap/TTL/dir knobs would be silently inert on an embedded
  // gateway. Same reasoning as RIVETOS_DEN_DEVICES_PG_ADMIN_URL above.
  for (const key of [
    'RIVETOS_DEN_UPLOAD_DIR',
    'RIVETOS_DEN_UPLOAD_MAX_BYTES',
    'RIVETOS_DEN_UPLOAD_TTL_MS',
  ] as const) {
    const value = process.env[key]?.trim()
    if (value) env[key] = value
  }

  // Gateway mTLS — node leaf + CA chain for verifying device client certs.
  // Prefer explicit den.tls_* config; fall back to mesh issue-node paths.
  const nodeName = config.mesh?.node_name?.trim()
  const defaultCert = nodeName ? `/rivet-shared/rivet-ca/issued/${nodeName}.crt` : ''
  const defaultKey = nodeName ? `/rivet-shared/rivet-ca/issued/${nodeName}.key` : ''
  const cert =
    (den as { tls_cert?: string }).tls_cert?.trim() ||
    process.env.RIVETOS_DEN_TLS_CERT?.trim() ||
    (existsSync(defaultCert) ? defaultCert : '')
  const key =
    (den as { tls_key?: string }).tls_key?.trim() ||
    process.env.RIVETOS_DEN_TLS_KEY?.trim() ||
    (existsSync(defaultKey) ? defaultKey : '')
  const ca =
    (den as { tls_ca?: string }).tls_ca?.trim() ||
    process.env.RIVETOS_DEN_TLS_CA?.trim() ||
    '/rivet-shared/rivet-ca/intermediate/chain.pem'
  if (cert) env.RIVETOS_DEN_TLS_CERT = cert
  if (key) env.RIVETOS_DEN_TLS_KEY = key
  if (ca) env.RIVETOS_DEN_TLS_CA = ca
  if ((den as { tls_require_client?: boolean }).tls_require_client === false) {
    env.RIVETOS_DEN_TLS_REQUIRE_CLIENT = '0'
  }

  return env
}

/**
 * Hub-first static default: when the node has a built RivetHub, serve it at
 * / (the den viewer rides nested at /den/ via copy-den.mjs). The bare den
 * viewer is only the root when no hub dist exists. Before this, nodes
 * without an explicit static_dir served the den viewer full-screen — a
 * node-switch from another hub landed there with no way back into the hub.
 */
function defaultStaticDir(installRoot: string): string {
  const hub = join(installRoot, 'apps', 'rivethub-web', 'dist')
  if (existsSync(join(hub, 'index.html'))) return hub
  return join(installRoot, 'apps', 'den', 'dist')
}

export interface GatewayStart {
  port: number
  close(): Promise<void>
}

export async function registerGateway(
  runtime: Runtime,
  config: RivetConfig,
  installRoot: string,
  extraRoutes: GatewayRoute[] = [],
  extraUpgrades: GatewayUpgrade[] = [],
  /**
   * Harness control plane (docs/plans/harness-control-plane.md): drivers to
   * register on the node's HarnessDriver registry at boot, alongside the four
   * built-in drivers (`claude-code`, `grok-build`, `hermes`, `kimi-code`) the
   * gateway registers itself. A node with a harness of its own plugs in here.
   */
  harnessDrivers: HarnessDriver[] = [],
): Promise<GatewayStart | undefined> {
  if (config.den?.enabled !== true) return undefined

  // Dynamic import: boot compiles to CJS, den-server is ESM (same pattern as
  // the claude-cli executor registration).
  const { createDenServer, createTranscriptWatcher } = await import('@rivetos/den-server/server')
  const { loadConfig: loadDenConfig } = await import('@rivetos/den-server/config')

  // G5: the gateway channel — RivetHub chat into the normal turn pipeline.
  // Registered like any other channel; its routes + WS ride the gateway.
  // Seamless modes v2: the transcript hooks close over the watcher declared
  // just below (safe — they only run once the server is listening); the
  // watcher's frames flow back out through this same channel's WS.
  const gatewayChannel = createGatewayChannel({
    defaultAgent: config.runtime.default_agent,
    // Seamless modes (5e): durable chat backfill reads the memory transcript;
    // memory registers on the runtime after this, so pass a lazy accessor.
    getMemory: () => runtime.getMemory(),
    transcript: {
      watch: (sid) => transcriptWatcher.watch(sid),
      unwatch: (sid) => transcriptWatcher.unwatch(sid),
      sync: (sid) => transcriptWatcher.sync(sid),
    },
  })
  const transcriptWatcher = createTranscriptWatcher((frame: SessionWsFrame) =>
    gatewayChannel.emitFrame(frame),
  )
  runtime.registerChannel(gatewayChannel.channel)
  runtime.addShutdownHook(async () => {
    transcriptWatcher.close()
    await gatewayChannel.close()
  })

  // OpenAI-compatible /v1/* — same host/port/auth/CORS as /api/* so Android
  // (and any OpenAI client) can treat this node as a drop-in backend. Model
  // ids are agent ids from the local router (same registry catalog/agents uses).
  const openaiRoute = createOpenAICompatRoute({
    listAgents: () =>
      Promise.resolve(
        runtime
          .getRouter()
          .getAgents()
          .map((a) => ({ id: a.id })),
      ),
    gateway: gatewayChannel,
    defaultAgent: config.runtime.default_agent,
  })

  const env = buildGatewayEnv(config, installRoot)
  const denConfig = loadDenConfig({ ...env })
  // Bearer removed: denConfig.token is always empty from loadConfig.
  // TLS paths come from den.tls_* / env in buildGatewayEnv.

  const den = createDenServer(denConfig, {
    extraRoutes: [...extraRoutes, ...gatewayChannel.routes, openaiRoute],
    extraUpgrades: [gatewayChannel.upgrade, ...extraUpgrades],
    // Seamless modes (5d): bridge live harness AgentEvents into the chat WS
    // so a PTY conversation's chat view streams (thinking/tool indicators +
    // the coalesced assistant message per turn). Terminal + den views are
    // unaffected; `task:` sessions are skipped inside the bridge.
    onAgentEvent: (ev) => gatewayChannel.bridgeAgentEvent(ev),
    harnessDrivers,
  })

  const listening = await new Promise<boolean>((resolve) => {
    den.server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.warn(
          `Gateway port ${String(denConfig.port)} in use — is the retired rivet-den.service ` +
            `still running? (systemctl disable --now rivet-den) Gateway NOT started.`,
        )
        resolve(false)
      } else if (err.code === 'EACCES' && denConfig.port < 1024) {
        log.warn(
          `Gateway cannot bind :${String(denConfig.port)} without CAP_NET_BIND_SERVICE — ` +
            `run \`rivetos gateway caps\` then restart (Appendix F G7). Gateway NOT started.`,
        )
        resolve(false)
      } else {
        log.error(`Gateway failed to bind: ${err.message}`)
        resolve(false)
      }
    })
    den.server.listen(denConfig.port, denConfig.host, () => resolve(true))
  })
  if (!listening) return undefined

  runtime.addShutdownHook(async () => {
    await den.close()
  })
  log.info(
    `Gateway (den) embedded on ${denConfig.host}:${String(denConfig.port)}` +
      (denConfig.token ? ' [auth on]' : ' [auth off]') +
      (extraRoutes.length ? ` — ${String(extraRoutes.length)} API route mount(s)` : ''),
  )
  return {
    port: denConfig.port,
    close: () => den.close(),
  }
}
