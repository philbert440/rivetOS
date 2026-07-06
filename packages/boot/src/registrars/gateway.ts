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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger, createGatewayChannel, type Runtime } from '@rivetos/core'
import type { GatewayRoute } from '@rivetos/types'
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
    RIVETOS_DEN_STATIC_DIR: den.static_dir?.trim() || join(installRoot, 'apps', 'den', 'dist'),
    RIVETOS_DEN_PACKS_DIR:
      den.packs_dir?.trim() || join(installRoot, 'packages', 'den-packs', 'packs'),
  }
  if (terminal?.enabled === true) env.RIVETOS_DEN_TERM = '1'
  if (terminal?.open === true) env.RIVETOS_DEN_TERM_OPEN = '1'
  return env
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
): Promise<GatewayStart | undefined> {
  if (config.den?.enabled !== true) return undefined

  // Dynamic import: boot compiles to CJS, den-server is ESM (same pattern as
  // the claude-cli executor registration).
  const { createDenServer } = await import('@rivetos/den-server/server')
  const { loadConfig: loadDenConfig } = await import('@rivetos/den-server/config')

  // G5: the gateway channel — RivetHub chat into the normal turn pipeline.
  // Registered like any other channel; its routes + WS ride the gateway.
  const gatewayChannel = createGatewayChannel()
  runtime.registerChannel(gatewayChannel.channel)
  runtime.addShutdownHook(async () => {
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
    extraUpgrades: [gatewayChannel.upgrade],
  })

  const listening = await new Promise<boolean>((resolve) => {
    den.server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.warn(
          `Gateway port ${String(denConfig.port)} in use — is the retired rivet-den.service ` +
            `still running? (systemctl disable --now rivet-den) Gateway NOT started.`,
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
