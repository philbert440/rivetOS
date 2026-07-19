/**
 * Deployment-mode detection for `rivetos update`.
 *
 * Historical footgun (2026-05-23 mesh recovery): the presence of the in-repo
 * Compose file alone caused silent Docker mode even on bare-metal nodes where
 * docker was not installed. `exec()` then swallowed docker failures and the
 * CLI printed a false success. Detection must prove Docker is actually usable
 * before choosing that path.
 */

import { statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'

export type DeploymentMode = 'docker' | 'bare-metal' | 'manual'

export interface DetectDeploymentInput {
  /** Force bare-metal via --bare-metal / RIVETOS_BARE_METAL */
  forceBareMetal: boolean
  /** Repo root (contains infra/docker/rivetos/docker-compose.yml) */
  root: string
  /** Override HOME for unit tests */
  home?: string
  /** Optional overrides for tests */
  probes?: DetectDeploymentProbes
}

export interface DetectDeploymentProbes {
  readConfigTarget?: () => Promise<string | undefined>
  hasSystemdUnit?: () => Promise<boolean>
  isDockerUsable?: () => boolean
  hasComposeFile?: () => Promise<boolean>
}

export interface DetectDeploymentResult {
  mode: DeploymentMode
  /** Human-readable reason printed to the operator */
  reason: string
}

/**
 * Resolve update deployment mode. Prefer explicit signals (flag, config,
 * systemd) over the in-repo Compose file. Never choose docker unless the
 * daemon answers.
 */
export async function detectDeployment(
  input: DetectDeploymentInput,
): Promise<DetectDeploymentResult> {
  const probes = input.probes ?? {}

  if (input.forceBareMetal) {
    return { mode: 'bare-metal', reason: 'forced via --bare-metal / RIVETOS_BARE_METAL=1' }
  }

  const configTarget = probes.readConfigTarget
    ? await probes.readConfigTarget()
    : await readConfigTarget(input.home)
  if (configTarget === 'docker' || configTarget === 'bare-metal' || configTarget === 'manual') {
    if (configTarget === 'docker') {
      const dockerOk = probes.isDockerUsable ? probes.isDockerUsable() : isDockerUsable()
      if (!dockerOk) {
        return {
          mode: 'bare-metal',
          reason:
            'config.deployment.target=docker but docker is unavailable — falling back to bare-metal (use --bare-metal to silence)',
        }
      }
    }
    return { mode: configTarget, reason: `config.deployment.target=${configTarget}` }
  }

  const systemd = probes.hasSystemdUnit
    ? await probes.hasSystemdUnit()
    : await hasSystemdUnit(input.home)
  if (systemd) {
    return { mode: 'bare-metal', reason: 'systemd unit rivetos detected' }
  }

  const hasCompose = probes.hasComposeFile
    ? await probes.hasComposeFile()
    : await fileExists(resolve(input.root, 'infra/docker/rivetos/docker-compose.yml'))
  if (hasCompose) {
    const dockerOk = probes.isDockerUsable ? probes.isDockerUsable() : isDockerUsable()
    if (dockerOk) {
      return {
        mode: 'docker',
        reason: 'compose file present and docker daemon reachable',
      }
    }
    // Compose ships in every bare-metal checkout — do NOT treat that as docker.
    return {
      mode: 'bare-metal',
      reason:
        'compose file present but docker unavailable — bare-metal (pass --bare-metal to make this explicit)',
    }
  }

  return { mode: 'bare-metal', reason: 'default (no systemd unit, no usable docker)' }
}

async function readConfigTarget(home?: string): Promise<string | undefined> {
  const configPath = resolve(home ?? process.env.HOME ?? homedir(), '.rivetos', 'config.yaml')
  try {
    const { parse: parseYaml } = await import('yaml')
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(configPath, 'utf-8')
    const config = parseYaml(raw) as { deployment?: { target?: string } }
    return config.deployment?.target
  } catch {
    return undefined
  }
}

/**
 * True if a system or user rivetos unit exists, or systemctl reports the unit.
 */
export async function hasSystemdUnit(home?: string): Promise<boolean> {
  const homeDir = home ?? process.env.HOME ?? homedir()
  const candidates = [
    '/etc/systemd/system/rivetos.service',
    '/usr/lib/systemd/system/rivetos.service',
    '/lib/systemd/system/rivetos.service',
    resolve(homeDir, '.config/systemd/user/rivetos.service'),
  ]
  for (const path of candidates) {
    if (await fileExists(path)) return true
  }

  // Live probe — covers units installed under other paths / generators.
  for (const cmd of [
    'systemctl is-enabled rivetos 2>/dev/null',
    'systemctl --user is-enabled rivetos 2>/dev/null',
    'systemctl cat rivetos 2>/dev/null',
    'systemctl --user cat rivetos 2>/dev/null',
  ]) {
    try {
      const out = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      if (out.length > 0) return true
    } catch {
      // try next
    }
  }
  return false
}

/** Docker CLI + daemon must both answer. Compose file alone is not enough. */
export function isDockerUsable(): boolean {
  try {
    execSync('docker info', {
      encoding: 'utf-8',
      timeout: 8000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Warn when the install tree is root-owned while running as a non-root user.
 * Root-owned leftovers from old installs break npm/nx updates (third footgun).
 */
export function findRootOwnedBlockers(
  root: string,
  paths: string[] = ['node_modules', 'dist', 'packages', '.nx'],
): string[] {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return []
  }
  const blockers: string[] = []
  for (const rel of paths) {
    const full = resolve(root, rel)
    try {
      const st = statSync(full)
      if (st.uid === 0) blockers.push(rel)
    } catch {
      // missing path is fine
    }
  }
  return blockers
}
