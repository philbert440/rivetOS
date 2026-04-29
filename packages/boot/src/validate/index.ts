/**
 * Config Validation — schema validation with helpful error messages.
 *
 * Zero external dependencies. Validates the parsed YAML config object
 * and returns structured errors/warnings before anything tries to boot.
 *
 * Design:
 * - Errors = fatal, won't boot
 * - Warnings = suspicious but not blocking
 * - Each issue includes a path (e.g., "agents.grok.provider") and a human-readable message
 */

export type { Severity, ValidationIssue, ValidationResult } from './types.js'
import {
  KNOWN_TOP_LEVEL_KEYS,
  toResult,
  type ValidationIssue,
  type ValidationResult,
} from './types.js'
import {
  validateRuntime,
  validateAgents,
  validateProviders,
  validateChannels,
  validateMemory,
  validateMesh,
} from './sections.js'
import { validateDeployment } from './deployment.js'
import { validateCrossReferences } from './cross-refs.js'

/**
 * Validate a parsed config object. Returns structured errors and warnings.
 */
export function validateConfig(config: unknown): ValidationResult {
  const issues: ValidationIssue[] = []

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    issues.push({
      severity: 'error',
      path: '',
      message: 'Config must be a YAML object (got ' + typeof config + ')',
    })
    return toResult(issues)
  }

  const cfg = config as Record<string, unknown>

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: key,
        message: `Unknown top-level key "${key}" — will be ignored`,
      })
    }
  }

  // === runtime (required) ===
  if (!cfg.runtime) {
    issues.push({
      severity: 'error',
      path: 'runtime',
      message: 'Missing required section "runtime"',
    })
  } else if (typeof cfg.runtime !== 'object' || Array.isArray(cfg.runtime)) {
    issues.push({ severity: 'error', path: 'runtime', message: '"runtime" must be an object' })
  } else {
    validateRuntime(cfg.runtime as Record<string, unknown>, issues)
  }

  // === agents (required) ===
  if (!cfg.agents) {
    issues.push({
      severity: 'error',
      path: 'agents',
      message: 'Missing required section "agents" — define at least one agent',
    })
  } else if (typeof cfg.agents !== 'object' || Array.isArray(cfg.agents)) {
    issues.push({
      severity: 'error',
      path: 'agents',
      message: '"agents" must be an object mapping agent names to their config',
    })
  } else {
    validateAgents(cfg.agents as Record<string, unknown>, cfg, issues)
  }

  // === providers (required) ===
  if (!cfg.providers) {
    issues.push({
      severity: 'error',
      path: 'providers',
      message: 'Missing required section "providers" — define at least one provider',
    })
  } else if (typeof cfg.providers !== 'object' || Array.isArray(cfg.providers)) {
    issues.push({
      severity: 'error',
      path: 'providers',
      message: '"providers" must be an object mapping provider names to their config',
    })
  } else {
    validateProviders(cfg.providers as Record<string, unknown>, issues)
  }

  // === channels (optional but common) ===
  if (cfg.channels) {
    if (typeof cfg.channels !== 'object' || Array.isArray(cfg.channels)) {
      issues.push({ severity: 'error', path: 'channels', message: '"channels" must be an object' })
    } else {
      validateChannels(cfg.channels as Record<string, unknown>, issues)
    }
  }

  // === memory (optional) ===
  if (cfg.memory) {
    if (typeof cfg.memory !== 'object' || Array.isArray(cfg.memory)) {
      issues.push({ severity: 'error', path: 'memory', message: '"memory" must be an object' })
    } else {
      validateMemory(cfg.memory as Record<string, unknown>, issues)
    }
  }

  // === transports (optional) ===
  if (cfg.transports) {
    if (typeof cfg.transports !== 'object' || Array.isArray(cfg.transports)) {
      issues.push({
        severity: 'error',
        path: 'transports',
        message: '"transports" must be an object mapping transport names to their config',
      })
    }
  }

  // === deployment (optional) ===
  if (cfg.deployment) {
    if (typeof cfg.deployment !== 'object' || Array.isArray(cfg.deployment)) {
      issues.push({
        severity: 'error',
        path: 'deployment',
        message: '"deployment" must be an object',
      })
    } else {
      validateDeployment(cfg.deployment as Record<string, unknown>, issues)
    }
  }

  // === plugins (optional, authoritative in production) ===
  if (cfg.plugins !== undefined) {
    if (!Array.isArray(cfg.plugins)) {
      issues.push({
        severity: 'error',
        path: 'plugins',
        message: '"plugins" must be an array of npm package names',
      })
    } else {
      const list = cfg.plugins as unknown[]
      const seen = new Set<string>()
      for (let i = 0; i < list.length; i++) {
        const entry: unknown = list[i]
        if (typeof entry !== 'string' || entry.trim() === '') {
          issues.push({
            severity: 'error',
            path: `plugins[${i}]`,
            message: 'Each plugins entry must be a non-empty package name string',
          })
        } else if (seen.has(entry)) {
          issues.push({
            severity: 'error',
            path: `plugins[${i}]`,
            message: `Duplicate plugin entry "${entry}"`,
          })
        } else {
          seen.add(entry)
        }
      }
    }
  }

  // === mesh (optional but strict when enabled) ===
  if (cfg.mesh) {
    if (typeof cfg.mesh !== 'object' || Array.isArray(cfg.mesh)) {
      issues.push({ severity: 'error', path: 'mesh', message: '"mesh" must be an object' })
    } else {
      validateMesh(cfg.mesh as Record<string, unknown>, issues)
    }
  }

  // === Cross-references ===
  validateCrossReferences(cfg, issues)

  return toResult(issues)
}

/**
 * Format validation result as a human-readable string for CLI output.
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = []

  if (result.errors.length > 0) {
    lines.push('Errors:')
    for (const err of result.errors) {
      lines.push(`  ❌ ${err.path ? `[${err.path}] ` : ''}${err.message}`)
    }
  }

  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Warnings:')
    for (const warn of result.warnings) {
      lines.push(`  ⚠️  ${warn.path ? `[${warn.path}] ` : ''}${warn.message}`)
    }
  }

  if (result.valid && result.warnings.length === 0) {
    lines.push('✅ Config is valid.')
  } else if (result.valid) {
    lines.push('')
    lines.push(
      `✅ Config is valid (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}).`,
    )
  } else {
    lines.push('')
    lines.push(
      `❌ Config has ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}${result.warnings.length > 0 ? ` and ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}` : ''}.`,
    )
  }

  return lines.join('\n')
}
