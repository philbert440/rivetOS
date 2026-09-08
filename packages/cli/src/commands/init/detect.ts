/**
 * Phase 1: Environment detection — runs before any prompts.
 */

import { execSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import type { EnvDetection } from './types.js'

export async function detectEnvironment(
  opts: { quiet?: boolean; minNodeMajor?: number } = {},
): Promise<EnvDetection> {
  const rivetDir = resolve(homedir(), '.rivetos')
  const configPath = resolve(rivetDir, 'config.yaml')
  const minNodeMajor = opts.minNodeMajor ?? 24

  // Node version
  const nodeVersion = process.versions.node
  const [major] = nodeVersion.split('.').map(Number)
  const nodeOk = major >= minNodeMajor

  // Docker
  let dockerAvailable = false
  let dockerVersion: string | undefined
  try {
    const out = execSync('docker --version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    dockerAvailable = true
    dockerVersion = out
      .replace(/^Docker version\s*/i, '')
      .replace(/,.*/, '')
      .trim()
  } catch {
    // Docker not available
  }

  // Existing config
  let configExists = false
  try {
    await access(configPath)
    configExists = true
  } catch {
    // No existing config
  }

  const env: EnvDetection = {
    nodeVersion,
    nodeOk,
    dockerAvailable,
    dockerVersion,
    configExists,
    configPath,
    rivetDir,
  }

  if (!opts.quiet) {
    const lines = [
      `${env.nodeOk ? '✓' : '✗'} Node.js ${env.nodeVersion}${env.nodeOk ? '' : ` (requires >= ${String(minNodeMajor)})`}`,
      `${env.dockerAvailable ? '✓' : '✗'} Docker${env.dockerVersion ? ` ${env.dockerVersion}` : ' not found'}`,
      `${env.configExists ? '●' : '○'} Existing config${env.configExists ? ` at ${env.configPath}` : ''}`,
    ]
    p.note(lines.join('\n'), 'Environment')
  }

  if (!env.nodeOk) {
    const msg = `Node.js ${String(minNodeMajor)}+ is required. Please upgrade and try again.`
    if (opts.quiet) {
      console.error(msg)
    } else {
      p.cancel(msg)
    }
    process.exit(1)
  }

  return env
}
