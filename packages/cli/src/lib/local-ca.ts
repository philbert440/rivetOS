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
import { execFileAsync, type ExecResult } from './harness-detect.js'
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

export function listLanIpv4(
  nics: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = []
  for (const addrs of Object.values(nics ?? {})) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4') continue
      if (a.internal) continue
      if (a.address.startsWith('169.254.')) continue
      out.push(a.address)
    }
  }
  return out
}

/** SANs for `issue-node local` — extras must be `IP:` / `DNS:` prefixed. */
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

export function localCaPaths(home: string): {
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
    nodeCert: join(sharedDir, 'issued', 'local.crt'),
    nodeKey: join(sharedDir, 'issued', 'local.key'),
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
  const paths = localCaPaths(opts.home)
  const desktopId = desktopClientId(opts.hostname)
  const desktopCert = join(paths.sharedDir, 'issued', `device-${desktopId}.crt`)
  const desktopKey = join(paths.sharedDir, 'issued', `device-${desktopId}.key`)
  const caKey = join(paths.rootDir, 'ca.key')
  const intKey = join(paths.sharedDir, 'intermediate', 'int.key')

  const steps: LocalCaStep[] = [
    {
      argv: ['init'],
      skip: exists(caKey),
      reason: exists(caKey) ? 'root already exists' : undefined,
    },
    {
      argv: ['issue-intermediate'],
      skip: exists(intKey),
      reason: exists(intKey) ? 'intermediate already exists' : undefined,
    },
    {
      argv: ['issue-node', 'local', ...opts.sans],
      skip: false,
      reason: 're-issue every run (DHCP SANs)',
    },
    {
      argv: ['issue-client', desktopId],
      skip: exists(desktopCert),
      reason: exists(desktopCert) ? 'desktop client already issued' : undefined,
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

function writeBothChains(plan: LocalCaPlan): void {
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
    if (result.timedOut || (result.code !== 0 && result.code !== null)) {
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
  if (existsSync(cert)) return { cert, key, id }
  const exec = opts.exec ?? execFileAsync
  const result = await runCa(exec, plan, ['issue-client', id])
  if (result.timedOut || (result.code !== 0 && result.code !== null)) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 400)
    throw new Error(`rivet-ca.sh issue-client ${id} failed: ${detail}`)
  }
  return { cert, key, id }
}
