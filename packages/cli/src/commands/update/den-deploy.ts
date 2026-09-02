/**
 * Gateway stage for `rivetos update` — G0 (Appendix F).
 *
 * The den server is embedded in the rivetos process (the gateway). This
 * stage probes /healthz on the configured den port when den.enabled, so a
 * broken embed is loud in the summary. parseDenSettings stays: the verify
 * steps still need the node's den section (port/host/enabled/tls).
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { sharedPath } from '@rivetos/types'
import { sshExecQuiet, isSafeArg } from '../../lib/ssh.js'

/** Total budget for the post-restart /healthz poll. */
const DEN_HEALTH_TIMEOUT_MS = 15_000
const DEN_HEALTH_INTERVAL_MS = 2_000
/** Default CA bundle for verifying a TLS den — matches boot resolveDenTls. */
const defaultTlsCa = (): string => sharedPath('rivet-ca', 'intermediate', 'chain.pem')

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
  /** Resolved node cert path — non-empty means the den serves https (#491). */
  tlsCert: string
  /** CA bundle the probe verifies the server against. */
  tlsCa: string
}

export type DenDeployOutcome = 'deployed' | 'skipped' | 'failed'

/**
 * Extract the den: section from a raw config.yaml string and apply deploy
 * defaults. Missing/unparseable config → disabled.
 *
 * Deliberately lenient: hard validation is the config validator's job
 * (packages/boot validateDen); the deploy stage just needs safe values.
 */
export function parseDenSettings(rawYaml: string | null | undefined): DenDeploySettings {
  const defaults: DenDeploySettings = {
    enabled: false,
    host: '127.0.0.1',
    port: 5174,
    token: '',
    termEnabled: false,
    termOpen: false,
    tlsCert: '',
    tlsCa: defaultTlsCa(),
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

  // Gateway TLS (#491): mirror packages/boot resolveDenTls's config + auto
  // path branches — cert AND key must both resolve, same as denTlsConfigured,
  // or the probe scheme diverges from what the gateway actually serves.
  // (The RIVETOS_DEN_TLS_* env branch cannot be mirrored: the orchestrator
  // can't see a remote node's unit environment. Nodes doing env-only TLS
  // must set den.tls_* in config.yaml for the deploy probe to follow.)
  // existsSync runs on the orchestrating host, but /rivet-shared is the same
  // NFS view on every node, so the auto-path answer holds for remote targets.
  const mesh = (parsed as Record<string, unknown>).mesh
  const rawNodeName =
    mesh && typeof mesh === 'object' && !Array.isArray(mesh)
      ? (mesh as Record<string, unknown>).node_name
      : undefined
  const nodeName = typeof rawNodeName === 'string' ? rawNodeName.trim() : ''
  const autoCert = nodeName ? sharedPath('rivet-ca', 'issued', `${nodeName}.crt`) : ''
  const autoKey = nodeName ? sharedPath('rivet-ca', 'issued', `${nodeName}.key`) : ''
  const confCert = typeof d.tls_cert === 'string' ? d.tls_cert.trim() : ''
  const confKey = typeof d.tls_key === 'string' ? d.tls_key.trim() : ''
  const cert = confCert || (autoCert && existsSync(autoCert) ? autoCert : '')
  const key = confKey || (autoKey && existsSync(autoKey) ? autoKey : '')
  const tlsCert = cert && key ? cert : ''

  return {
    enabled: d.enabled === true,
    host: typeof d.host === 'string' && d.host.trim() !== '' ? d.host.trim() : defaults.host,
    port,
    token: typeof d.token === 'string' ? d.token : '',
    tlsCert,
    tlsCa:
      typeof d.tls_ca === 'string' && d.tls_ca.trim() !== '' ? d.tls_ca.trim() : defaults.tlsCa,
    termEnabled: terminal?.enabled === true,
    termOpen: terminal?.open === true,
  }
}

/** Host to curl for the health probe — wildcard binds answer on loopback. */
export function denProbeHost(bindHost: string): string {
  return bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost
}

/**
 * The /healthz probe command for this den. With gateway TLS (#491) the den
 * answers https only, verified against the Rivet CA chain — node leaves must
 * carry an IP:127.0.0.1 SAN (rivet-ca.sh issue-node ... IP:127.0.0.1) for
 * the loopback probe to pass hostname verification.
 */
export function denProbeCmd(den: DenDeploySettings): string {
  const target = `${denProbeHost(den.host)}:${String(den.port)}/healthz`
  if (!den.tlsCert) return `curl -fsS -m 3 http://${target}`
  return `curl -fsS -m 3 --cacert ${den.tlsCa} https://${target}`
}

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
 * Post-restart gateway health: probe /healthz on the configured den port
 * when den.enabled. Same contract as the old deploy stage: never throws,
 * logs its own outcome.
 */
export async function verifyGatewayLocal(restart: boolean): Promise<DenDeployOutcome> {
  const tag = '[local]'
  const rivetHome = existsSync('/home/rivet') ? '/home/rivet' : (process.env.HOME ?? '/root')
  const rawConfig = await readLocalConfig([rivetHome, process.env.HOME ?? '/root'])
  const den = parseDenSettings(rawConfig)
  if (!den.enabled) return 'skipped'
  if (den.tlsCert && !isSafeArg(den.tlsCa)) {
    console.error(`    ${tag} ❌ den.tls_ca "${den.tlsCa}" contains shell-unsafe characters`)
    return 'failed'
  }
  if (!restart) {
    console.log(`    ${tag} ℹ️  gateway not verified (no restart requested)`)
    return 'skipped'
  }

  const probe = denProbeCmd(den)
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
// Remote (ssh) — same verify step, driven from the mesh update
// ---------------------------------------------------------------------------

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
  const den = parseDenSettings(rawConfig || null)
  if (!den.enabled) return 'skipped'
  if (!isSafeArg(den.host)) {
    console.error(`    ${tag} ❌ den.host "${den.host}" contains shell-unsafe characters`)
    return 'failed'
  }
  if (den.tlsCert && !isSafeArg(den.tlsCa)) {
    console.error(`    ${tag} ❌ den.tls_ca "${den.tlsCa}" contains shell-unsafe characters`)
    return 'failed'
  }

  const probe = denProbeCmd(den)
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
