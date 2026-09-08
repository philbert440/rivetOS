/**
 * Local-mode CA: wrap `scripts/rivet-ca.sh` so a laptop mesh-of-one has a
 * Rivet root, intermediate, node leaf (re-issued every run — DHCP SANs),
 * and a desktop client leaf.
 *
 * Writes both `intermediate/chain.pem` (den) and `intermediate/ca-chain.pem`
 * (CLI helpers). Never spawnSync — a running local node hosts PGlite in-process.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFailed, execFileAsync, type ExecResult } from './harness-detect.js'
import { findRoot } from '../commands/plugins-sync.js'

export interface LocalCaSans {
  hostname: string
  lanAddrs: string[]
}

export interface LocalCaStep {
  argv: string[]
  skip: boolean
  reason?: string
}

export interface LocalCaPlan {
  rootDir: string
  sharedDir: string
  script: string
  steps: LocalCaStep[]
  chainPem: string
  caChainPem: string
  nodeCert: string
  nodeKey: string
  desktopId: string
  desktopCert: string
  desktopKey: string
}

export interface EnsureLocalCaOpts {
  home?: string
  hostname: string
  sans?: string[]
  lanAddrs?: string[]
  exec?: typeof execFileAsync
  scriptPath?: string
  exists?: (path: string) => boolean
  root?: string | null
}

/** Virtual/container/VPN ifaces — keep in cert SANs, omit from the LAN URL banner. */
const LAN_BANNER_SKIP_PREFIXES = [
  'br-',
  'docker',
  'veth',
  'tailscale',
  'tun',
  'wg',
  'virbr',
  'lo',
] as const

function skipLanBannerIface(name: string): boolean {
  const n = name.toLowerCase()
  return LAN_BANNER_SKIP_PREFIXES.some((p) => n.startsWith(p))
}

function collectLanIpv4(nics: ReturnType<typeof networkInterfaces>, forBanner: boolean): string[] {
  const out: string[] = []
  for (const [name, addrs] of Object.entries(nics ?? {})) {
    if (forBanner && skipLanBannerIface(name)) continue
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4') continue
      if (a.internal) continue
      if (a.address.startsWith('169.254.')) continue
      out.push(a.address)
    }
  }
  return out
}

export function listLanIpv4(
  nics: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  return collectLanIpv4(nics, false)
}

/** Real LAN addresses only — no bridge/VPN/docker/loopback ifaces. */
export function listBannerLanIpv4(
  nics: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  return collectLanIpv4(nics, true)
}

/** SANs for `issue-node <hostname>` — extras must be `IP:` / `DNS:` prefixed. */
export function localNodeSans(opts: LocalCaSans): string[] {
  const sans = ['IP:127.0.0.1', 'DNS:localhost']
  for (const ip of opts.lanAddrs) {
    if (!ip) continue
    sans.push(`IP:${ip}`)
  }
  const host = opts.hostname.trim()
  if (host) sans.push(`DNS:${host}.local`)
  return sans
}

export function localCaPaths(
  home: string,
  nodeName = 'local',
): {
  rootDir: string
  sharedDir: string
  chainPem: string
  caChainPem: string
  nodeCert: string
  nodeKey: string
} {
  const rootDir = join(home, '.rivetos', 'ca', 'root')
  const sharedDir = join(home, '.rivetos', 'shared', 'rivet-ca')
  return {
    rootDir,
    sharedDir,
    chainPem: join(sharedDir, 'intermediate', 'chain.pem'),
    caChainPem: join(sharedDir, 'intermediate', 'ca-chain.pem'),
    nodeCert: join(sharedDir, 'issued', `${nodeName}.crt`),
    nodeKey: join(sharedDir, 'issued', `${nodeName}.key`),
  }
}

export function desktopClientId(hostname: string): string {
  return `desktop-${hostname}`
}

export function findRivetCaScript(explicitRoot?: string | null): string | null {
  const roots: string[] = []
  if (explicitRoot) roots.push(explicitRoot)
  const found = findRoot()
  if (found) roots.push(found)
  for (const root of roots) {
    const candidate = join(root, 'scripts', 'rivet-ca.sh')
    if (existsSync(candidate)) return candidate
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'scripts', 'rivet-ca.sh')
    if (existsSync(candidate)) return candidate
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return null
}

export function planLocalCa(opts: {
  home: string
  hostname: string
  sans: string[]
  exists?: (path: string) => boolean
  scriptPath: string
}): LocalCaPlan {
  const exists = opts.exists ?? existsSync
  const paths = localCaPaths(opts.home, opts.hostname)
  const desktopId = desktopClientId(opts.hostname)
  const desktopCert = join(paths.sharedDir, 'issued', `device-${desktopId}.crt`)
  const desktopKey = join(paths.sharedDir, 'issued', `device-${desktopId}.key`)
  const caKey = join(paths.rootDir, 'ca.key')
  const caCrt = join(paths.rootDir, 'ca.crt')
  const intKey = join(paths.sharedDir, 'intermediate', 'int.key')
  const intCrt = join(paths.sharedDir, 'intermediate', 'int.crt')

  const rootComplete = pairComplete(exists, caKey, caCrt, 'root CA')
  const intComplete = pairComplete(exists, intKey, intCrt, 'intermediate CA')
  const desktopComplete = pairComplete(
    exists,
    desktopKey,
    desktopCert,
    `desktop client ${desktopId}`,
  )

  const steps: LocalCaStep[] = [
    {
      argv: ['init'],
      skip: rootComplete,
      reason: rootComplete ? 'root already exists' : undefined,
    },
    {
      argv: ['issue-intermediate'],
      skip: intComplete,
      reason: intComplete ? 'intermediate already exists' : undefined,
    },
    {
      argv: ['issue-node', opts.hostname, ...opts.sans],
      skip: false,
      reason: 're-issue every run (DHCP SANs)',
    },
    {
      argv: ['issue-client', desktopId],
      skip: desktopComplete,
      reason: desktopComplete ? 'desktop client already issued' : undefined,
    },
  ]

  return {
    rootDir: paths.rootDir,
    sharedDir: paths.sharedDir,
    script: opts.scriptPath,
    steps,
    chainPem: paths.chainPem,
    caChainPem: paths.caChainPem,
    nodeCert: paths.nodeCert,
    nodeKey: paths.nodeKey,
    desktopId,
    desktopCert,
    desktopKey,
  }
}

function caEnv(plan: LocalCaPlan): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RIVET_CA_ROOT_DIR: plan.rootDir,
    RIVET_CA_SHARED_DIR: plan.sharedDir,
  }
}

async function runCa(
  exec: typeof execFileAsync,
  plan: LocalCaPlan,
  argv: string[],
): Promise<ExecResult> {
  mkdirSync(plan.rootDir, { recursive: true })
  mkdirSync(plan.sharedDir, { recursive: true })
  return exec('bash', [plan.script, ...argv], {
    timeoutMs: 60_000,
    env: caEnv(plan),
  })
}

/**
 * Skip only when both halves of a key/cert pair exist. A lone key (or lone
 * cert) is an interrupted run — `rivet-ca.sh init` / `issue-intermediate`
 * refuse existing keys, so we fail with a recovery hint instead of skipping.
 */
function pairComplete(
  exists: (path: string) => boolean,
  keyPath: string,
  crtPath: string,
  label: string,
): boolean {
  const hasKey = exists(keyPath)
  const hasCrt = exists(crtPath)
  if (hasKey && hasCrt) return true
  if (!hasKey && !hasCrt) return false
  throw new Error(
    `incomplete ${label}: ${hasKey ? keyPath : crtPath} exists without its pair — delete ${keyPath} and ${crtPath} and re-run rivetos local init`,
  )
}

export function writeBothChains(plan: LocalCaPlan): void {
  if (!existsSync(plan.chainPem)) return
  if (!existsSync(plan.caChainPem)) {
    mkdirSync(dirname(plan.caChainPem), { recursive: true })
    copyFileSync(plan.chainPem, plan.caChainPem)
    return
  }
  // Keep CLI helpers in sync with den's chain after a first-time init.
  copyFileSync(plan.chainPem, plan.caChainPem)
}

/**
 * Mint (or refresh) the local Rivet CA. Idempotent except `issue-node`,
 * which always re-issues so DHCP LAN SANs stay current.
 */
export async function ensureLocalCa(opts: EnsureLocalCaOpts): Promise<LocalCaPlan> {
  const home = opts.home ?? homedir()
  const script = opts.scriptPath ?? findRivetCaScript(opts.root)
  if (!script) {
    throw new Error(
      'cannot locate scripts/rivet-ca.sh — run from a rivetOS checkout or set RIVETOS_ROOT',
    )
  }
  const lanAddrs = opts.lanAddrs ?? listLanIpv4()
  const sans = opts.sans ?? localNodeSans({ hostname: opts.hostname, lanAddrs })
  const plan = planLocalCa({
    home,
    hostname: opts.hostname,
    sans,
    exists: opts.exists,
    scriptPath: script,
  })
  const exec = opts.exec ?? execFileAsync

  for (const step of plan.steps) {
    if (step.skip) continue
    const result = await runCa(exec, plan, step.argv)
    if (execFailed(result)) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 400)
      throw new Error(
        `rivet-ca.sh ${step.argv.join(' ')} failed (exit ${String(result.code)}${result.timedOut ? ', timed out' : ''}): ${detail}`,
      )
    }
  }

  writeBothChains(plan)
  return plan
}

/**
 * Issue an extra device client cert (`issue-client <name>`). Skips when the
 * leaf already exists.
 */
export async function issueClientDevice(opts: {
  home?: string
  name: string
  exec?: typeof execFileAsync
  scriptPath?: string
  root?: string | null
}): Promise<{ cert: string; key: string; id: string }> {
  const home = opts.home ?? homedir()
  const script = opts.scriptPath ?? findRivetCaScript(opts.root)
  if (!script) {
    throw new Error(
      'cannot locate scripts/rivet-ca.sh — run from a rivetOS checkout or set RIVETOS_ROOT',
    )
  }
  const plan = planLocalCa({
    home,
    hostname: 'unused',
    sans: [],
    scriptPath: script,
  })
  const id = opts.name
  const cert = join(plan.sharedDir, 'issued', `device-${id}.crt`)
  const key = join(plan.sharedDir, 'issued', `device-${id}.key`)
  if (existsSync(cert) && existsSync(key)) return { cert, key, id }
  if (existsSync(cert) || existsSync(key)) {
    throw new Error(
      `incomplete client ${id}: ${cert} / ${key} exist without a pair — delete both and re-run`,
    )
  }
  const exec = opts.exec ?? execFileAsync
  const result = await runCa(exec, plan, ['issue-client', id])
  if (execFailed(result)) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 400)
    throw new Error(`rivet-ca.sh issue-client ${id} failed: ${detail}`)
  }
  return { cert, key, id }
}
