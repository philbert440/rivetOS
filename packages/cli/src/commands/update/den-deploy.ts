/**
 * Gateway stage for `rivetos update` — G0 (Appendix F).
 *
 * The den server is embedded in the rivetos process now (the gateway), so
 * this stage no longer deploys rivet-den.service. It does two things:
 *
 *   1. retireDenUnit*  — BEFORE the rivetos restart: disable --now any
 *      installed rivet-den.service so the embedded gateway can bind the port.
 *      Idempotent, never fails the update.
 *   2. verifyGateway*  — AFTER the restart: probe /healthz on the configured
 *      den port when den.enabled, so a broken embed is loud in the summary.
 *
 * parseDenSettings stays: the retire/verify steps and the remote update
 * summary still need the node's den section (port/host/enabled).
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { sshExec, sshExecQuiet, isSafeArg } from '../../lib/ssh.js'

/** Matches remote-nodes.ts — systemctl restart blocks until the unit is up. */
const DEN_RESTART_TIMEOUT_MS = 90_000
/** Total budget for the post-restart /healthz poll. */
const DEN_HEALTH_TIMEOUT_MS = 15_000
const DEN_HEALTH_INTERVAL_MS = 2_000

// ---------------------------------------------------------------------------
// Config → deploy settings
// ---------------------------------------------------------------------------

export interface DenDeploySettings {
  enabled: boolean
  host: string
  port: number
  token: string
  termEnabled: boolean
  termOpen: boolean
  staticDir: string
  packsDir: string
}

export type DenDeployOutcome = 'deployed' | 'skipped' | 'failed' | 'unmanaged-active'

/**
 * Extract the den: section from a raw config.yaml string and apply deploy
 * defaults. `root` is the install root the static/packs defaults derive from
 * (/opt/rivetos on managed nodes). Missing/unparseable config → disabled.
 *
 * Deliberately lenient: hard validation is the config validator's job
 * (packages/boot validateDen); the deploy stage just needs safe values.
 */
export function parseDenSettings(
  rawYaml: string | null | undefined,
  root: string,
): DenDeploySettings {
  const defaults: DenDeploySettings = {
    enabled: false,
    host: '127.0.0.1',
    port: 5174,
    token: '',
    termEnabled: false,
    termOpen: false,
    staticDir: join(root, 'apps', 'den', 'dist'),
    packsDir: join(root, 'packages', 'den-packs', 'packs'),
  }

  if (!rawYaml) return defaults

  let parsed: unknown
  try {
    parsed = parseYaml(rawYaml)
  } catch {
    return defaults
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults

  const den = (parsed as Record<string, unknown>).den
  if (!den || typeof den !== 'object' || Array.isArray(den)) return defaults
  const d = den as Record<string, unknown>

  const terminal =
    d.terminal && typeof d.terminal === 'object' && !Array.isArray(d.terminal)
      ? (d.terminal as Record<string, unknown>)
      : undefined

  const port =
    typeof d.port === 'number' && Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535
      ? d.port
      : defaults.port

  return {
    enabled: d.enabled === true,
    host: typeof d.host === 'string' && d.host.trim() !== '' ? d.host.trim() : defaults.host,
    port,
    token: typeof d.token === 'string' ? d.token : '',
    termEnabled: terminal?.enabled === true,
    termOpen: terminal?.open === true,
    staticDir:
      typeof d.static_dir === 'string' && d.static_dir.trim() !== ''
        ? d.static_dir.trim()
        : defaults.staticDir,
    packsDir:
      typeof d.packs_dir === 'string' && d.packs_dir.trim() !== ''
        ? d.packs_dir.trim()
        : defaults.packsDir,
  }
}

/** Host to curl for the health probe — wildcard binds answer on loopback. */
export function denProbeHost(bindHost: string): string {
  return bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost
}

// ---------------------------------------------------------------------------
// Remote deploy (over SSH — mirrors remote-nodes.ts patterns)
// ---------------------------------------------------------------------------

/**
 * Deploy/refresh den-server on a remote node according to that node's own
 * config. Reads the remote ~/.rivetos/config.yaml, so per-node den settings
 * are honored without any central roster of den nodes.
 *
 * Never throws; failures are logged and reported via the outcome so a broken
 * den doesn't fail the node's rivetos update (den is auxiliary).
 */

// ---------------------------------------------------------------------------
// Local (this node)
// ---------------------------------------------------------------------------

function execLocalQuiet(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

/** First readable ~/.rivetos/config.yaml among the candidate home dirs. */
async function readLocalConfig(homes: string[]): Promise<string | null> {
  for (const home of homes) {
    try {
      return await readFile(join(home, '.rivetos', 'config.yaml'), 'utf-8')
    } catch {
      // try next
    }
  }
  return null
}

/**
 * Disable any installed rivet-den.service so the embedded gateway can bind
 * its port on the next rivetos start. Idempotent; never throws.
 */
export function retireDenUnitLocal(): void {
  const sudo = typeof process.getuid === 'function' && process.getuid() === 0 ? '' : 'sudo '
  const state = execLocalQuiet('systemctl is-enabled rivet-den 2>/dev/null || true')
  const active = execLocalQuiet('systemctl is-active rivet-den 2>/dev/null || true')
  if (state !== 'enabled' && active !== 'active') return
  console.log('  Retiring rivet-den.service (den is embedded in rivetos now)...')
  const out = execLocalQuiet(`${sudo}systemctl disable --now rivet-den 2>&1 || true`)
  if (execLocalQuiet('systemctl is-active rivet-den 2>/dev/null || true') === 'active') {
    console.log(
      `  ⚠️  rivet-den.service still active (${out.slice(0, 120)}) — the embedded gateway ` +
        'will not bind its port until the unit is stopped manually',
    )
  } else {
    console.log('  ✅ rivet-den.service retired')
  }
}

/**
 * Post-restart gateway health: probe /healthz on the configured den port
 * when den.enabled. Same contract as the old deploy stage: never throws,
 * logs its own outcome.
 */
export async function verifyGatewayLocal(restart: boolean): Promise<DenDeployOutcome> {
  const tag = '[local]'
  const rivetHome = existsSync('/home/rivet') ? '/home/rivet' : (process.env.HOME ?? '/root')
  const rawConfig = await readLocalConfig([rivetHome, process.env.HOME ?? '/root'])
  const den = parseDenSettings(rawConfig, '/opt/rivetos')
  if (!den.enabled) return 'skipped'
  if (!restart) {
    console.log(`    ${tag} ℹ️  gateway not verified (no restart requested)`)
    return 'skipped'
  }

  // False-green guard — see verifyGatewayRemote.
  if (execLocalQuiet('systemctl is-active rivet-den 2>/dev/null || true') === 'active') {
    console.error(
      `    ${tag} ❌ rivet-den.service is STILL ACTIVE — the embedded gateway could not bind; ` +
        'stop the unit (sudo systemctl disable --now rivet-den) and restart rivetos',
    )
    return 'failed'
  }

  const probe = `curl -fsS -m 3 http://${denProbeHost(den.host)}:${String(den.port)}/healthz`
  const deadline = Date.now() + DEN_HEALTH_TIMEOUT_MS
  for (;;) {
    const out = execLocalQuiet(probe)
    if (out) {
      console.log(`    ${tag} ✅ gateway healthy — /healthz ok on :${String(den.port)}`)
      return 'deployed'
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, DEN_HEALTH_INTERVAL_MS))
  }
  console.error(
    `    ${tag} ❌ gateway /healthz did not answer within ` +
      `${String(DEN_HEALTH_TIMEOUT_MS / 1000)}s of restart — check: journalctl -u rivetos`,
  )
  return 'failed'
}

// ---------------------------------------------------------------------------
// Remote (ssh) — same two steps, driven from the mesh update
// ---------------------------------------------------------------------------

export async function retireDenUnitRemote(
  host: string,
  nodeName: string,
  sshUser: string,
): Promise<void> {
  const tag = `[${nodeName}]`
  const sudo = sshUser === 'root' ? '' : 'sudo '
  const active = sshExecQuiet(
    host,
    `${sudo}systemctl is-active rivet-den 2>/dev/null || true`,
    sshUser,
  )
  const enabled = sshExecQuiet(
    host,
    `${sudo}systemctl is-enabled rivet-den 2>/dev/null || true`,
    sshUser,
  )
  if (active !== 'active' && enabled !== 'enabled') return
  console.log(`    ${tag} Retiring rivet-den.service (den embedded in rivetos now)...`)
  try {
    await sshExec(
      host,
      `${sudo}systemctl disable --now rivet-den`,
      `${tag} den retire`,
      DEN_RESTART_TIMEOUT_MS,
      sshUser,
    )
    console.log(`    ${tag} ✅ rivet-den.service retired`)
  } catch (err: unknown) {
    console.error(
      `    ${tag} ⚠️  could not retire rivet-den.service: ${(err as Error).message} — ` +
        `the embedded gateway will not bind its port until the unit is stopped`,
    )
  }
}

export async function verifyGatewayRemote(
  host: string,
  nodeName: string,
  sshUser: string,
): Promise<DenDeployOutcome> {
  const tag = `[${nodeName}]`
  const rawConfig = sshExecQuiet(
    host,
    'cat /home/rivet/.rivetos/config.yaml 2>/dev/null || cat \\$HOME/.rivetos/config.yaml 2>/dev/null',
    sshUser,
  )
  const den = parseDenSettings(rawConfig || null, '/opt/rivetos')
  if (!den.enabled) return 'skipped'
  if (!isSafeArg(den.host)) {
    console.error(`    ${tag} ❌ den.host "${den.host}" contains shell-unsafe characters`)
    return 'failed'
  }

  // False-green guard: /healthz answering while the RETIRED unit is still
  // active means the old standalone server is serving — the embed never cut
  // over (e.g. sudo-less retire failed and rivetos hit EADDRINUSE).
  const sudo = sshUser === 'root' ? '' : 'sudo '
  const staleUnit = sshExecQuiet(
    host,
    `${sudo}systemctl is-active rivet-den 2>/dev/null || true`,
    sshUser,
  )
  if (staleUnit === 'active') {
    console.error(
      `    ${tag} ❌ rivet-den.service is STILL ACTIVE — the embedded gateway could not bind; ` +
        `stop the unit (${sudo}systemctl disable --now rivet-den) and restart rivetos`,
    )
    return 'failed'
  }

  const probe = `curl -fsS -m 3 http://${denProbeHost(den.host)}:${String(den.port)}/healthz`
  const deadline = Date.now() + DEN_HEALTH_TIMEOUT_MS
  for (;;) {
    const out = sshExecQuiet(host, probe, sshUser)
    if (out) {
      console.log(`    ${tag} ✅ gateway healthy — /healthz ok on :${String(den.port)}`)
      return 'deployed'
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, DEN_HEALTH_INTERVAL_MS))
  }
  console.error(
    `    ${tag} ❌ gateway /healthz did not answer within ` +
      `${String(DEN_HEALTH_TIMEOUT_MS / 1000)}s — check: journalctl -u rivetos`,
  )
  return 'failed'
}
