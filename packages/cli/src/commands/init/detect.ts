/**
 * Phase 1: Environment detection — runs before any prompts.
 */

import { execSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import type { EnvDetection } from './types.js'

export async function detectEnvironment(): Promise<EnvDetection> {
  const rivetDir = resolve(homedir(), '.rivetos')
  const configPath = resolve(rivetDir, 'config.yaml')

  // Node version
  const nodeVersion = process.versions.node
  const [major] = nodeVersion.split('.').map(Number)
  const nodeOk = major >= 24

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

  // Display results
  const lines = [
    `${env.nodeOk ? '✓' : '✗'} Node.js ${env.nodeVersion}${env.nodeOk ? '' : ' (requires >= 24)'}`,
    `${env.dockerAvailable ? '✓' : '✗'} Docker${env.dockerVersion ? ` ${env.dockerVersion}` : ' not found'}`,
    `${env.configExists ? '●' : '○'} Existing config${env.configExists ? ` at ${env.configPath}` : ''}`,
  ]

  p.note(lines.join('\n'), 'Environment')

  if (!env.nodeOk) {
    p.cancel('Node.js 24+ is required. Please upgrade and try again.')
    process.exit(1)
  }

  return env
}
