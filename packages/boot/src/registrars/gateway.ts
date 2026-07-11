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
 * Token: den.token from config when set; otherwise a per-node token is
 * generated once at ~/.rivetos/gateway.token (0600) and reused —
 * `rivetos gateway token` prints it for clients. Private-LAN posture:
 * loopback binds may run tokenless, exactly like the standalone server did.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger, createGatewayChannel, type Runtime } from '@rivetos/core'
import type { GatewayRoute, SessionWsFrame } from '@rivetos/types'

/** WS upgrade handler shape den-server accepts (same as the channel's). */
interface GatewayUpgrade {
  path: string
  handle: (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void
}
import type { RivetConfig } from '../config.js'

const log = logger('Boot:Gateway')

export const GATEWAY_TOKEN_FILE = join(homedir(), '.rivetos', 'gateway.token')

/** Read-or-mint the per-node gateway token (0600). Exported for the CLI. */
export function ensureGatewayToken(file: string = GATEWAY_TOKEN_FILE): string {
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim()
    if (token) return token
  }
  mkdirSync(join(homedir(), '.rivetos'), { recursive: true })
  const token = randomBytes(24).toString('base64url')
  writeFileSync(file, token + '\n', { mode: 0o600 })
  log.info(`Generated gateway token at ${file}`)
  return token
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
    if (devices.shared_host?.trim())
      env.RIVETOS_DEN_DEVICES_SHARED_HOST = devices.shared_host.trim()
    if (devices.shared_export?.trim())
      env.RIVETOS_DEN_DEVICES_SHARED_EXPORT = devices.shared_export.trim()
    if (devices.gateway_url?.trim())
      env.RIVETOS_DEN_DEVICES_GATEWAY_URL = devices.gateway_url.trim()
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

  const env = buildGatewayEnv(config, installRoot)
  const denConfig = loadDenConfig({ ...env })
  // Token semantics UNCHANGED from the standalone server: den.token from
  // config or tokenless. Nodes like ct112/ct114 run 0.0.0.0 + terminal.open
  // with tokenless hook ingest — auto-generating a token here would 401
  // their /event POSTs on deploy. The generated ~/.rivetos/gateway.token
  // (rivetos gateway token) is OPT-IN plumbing for RivetHub clients later;
  // the gateway only uses it when den.token is set to the literal string
  // 'gateway-token-file'.
  denConfig.token =
    config.den.token?.trim() === 'gateway-token-file'
      ? ensureGatewayToken()
      : (config.den.token?.trim() ?? '')

  const den = createDenServer(denConfig, {
    extraRoutes: [...extraRoutes, ...gatewayChannel.routes],
    extraUpgrades: [gatewayChannel.upgrade, ...extraUpgrades],
    // Seamless modes (5d): bridge live harness AgentEvents into the chat WS
    // so a PTY conversation's chat view streams (thinking/tool indicators +
    // the coalesced assistant message per turn). Terminal + den views are
    // unaffected; `task:` sessions are skipped inside the bridge.
    onAgentEvent: (ev) => gatewayChannel.bridgeAgentEvent(ev),
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
