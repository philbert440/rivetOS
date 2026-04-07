/**
 * Validation utilities — run nx affected targets and report results.
 */

import { execSync } from 'node:child_process'
import { logger } from '@nx/devkit'

export interface ValidationResult {
  lint: boolean
  build: boolean
  test: boolean
}

function runTarget(target: string): boolean {
  try {
    logger.info(`  Running nx affected -t ${target}...`)
    execSync(`npx nx affected -t ${target} --parallel=5`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    logger.info(`  ✅ ${target} passed`)
    return true
  } catch {
    logger.error(`  ❌ ${target} failed`)
    return false
  }
}

/** Run lint, build, test on affected packages */
export function runValidation(): ValidationResult {
  logger.info('')
  logger.info('🔍 Running quality gates...')
  logger.info('')

  return {
    lint: runTarget('lint'),
    build: runTarget('build'),
    test: runTarget('test'),
  }
}

/** Detect affected packages from the Nx project graph */
export function getAffectedPackages(): string[] {
  try {
    const output = execSync('npx nx show projects --affected', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return output ? output.split('\n').map((s) => s.trim()) : []
  } catch {
    return []
  }
}
