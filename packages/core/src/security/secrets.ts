/**
 * Secret Management for RivetOS.
 *
 * Rules:
 *   1. Secrets live in .env files, NEVER in rivet.config.yaml
 *   2. All RivetOS env vars use RIVETOS_ prefix (except provider standard vars like ANTHROPIC_API_KEY)
 *   3. .env files get strict permissions (0600) on creation
 *   4. Secrets are redacted in logs (any value matching known secret patterns)
 *
 * Provides:
 *   - redactSecrets(): Replace secret values in strings for safe logging
 *   - ensureEnvPermissions(): Fix .env file permissions
 *   - validateNoSecretsInConfig(): Warn if rivet.config.yaml contains API keys
 *   - getSecretEnvVars(): List of known secret env var names
 *   - resolveOpReferences(): Resolve 1Password op:// references
 */

import { readFile, chmod, stat } from 'node:fs/promises'
import { logger } from '../logger.js'

const log = logger('Secrets')

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Patterns that look like API keys / secrets */
const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]+/g, // Anthropic
  /sk-[a-zA-Z0-9]{48,}/g, // OpenAI
  /xai-[a-zA-Z0-9_-]+/g, // xAI
  /AIza[a-zA-Z0-9_-]{35}/g, // Google
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub PAT
  /ghs_[a-zA-Z0-9]{36}/g, // GitHub App
  /op:\/\/[^\s]+/g, // 1Password references
]

/** Known env var names that contain secrets */
const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'DISCORD_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'RIVETOS_PG_URL',
  'GITHUB_TOKEN',
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact any secret-looking values in a string.
 * Safe for logging — replaces API keys, tokens, etc. with [REDACTED].
 */
export function redactSecrets(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, '[REDACTED]')
  }
  return redacted
}

/**
 * Ensure .env file has strict permissions (0600).
 * On Windows this is a no-op (chmod doesn't apply).
 */
export async function ensureEnvPermissions(
  envPath: string,
): Promise<{ fixed: boolean; message: string }> {
  try {
    const stats = await stat(envPath)
    const mode = stats.mode & 0o777
    if (mode !== 0o600) {
      await chmod(envPath, 0o600)
      log.info(`Fixed .env permissions: ${mode.toString(8)} → 600`)
      return { fixed: true, message: `Fixed .env permissions: ${mode.toString(8)} → 600` }
    }
    return { fixed: false, message: '.env permissions OK (600)' }
  } catch (err) {
    return {
      fixed: false,
      message: `Cannot check .env permissions: ${(err as Error).message}`,
    }
  }
}

/**
 * Check if rivet.config.yaml contains anything that looks like a secret.
 * Returns a list of warnings.
 */
export async function validateNoSecretsInConfig(configPath: string): Promise<string[]> {
  const warnings: string[] = []
  try {
    const content = await readFile(configPath, 'utf-8')

    // Check for known secret patterns
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(content)) {
        warnings.push('rivet.config.yaml appears to contain secrets. Move them to .env')
        break
      }
    }

    // Check for inline key/token values
    const keyPatterns = [
      /api_key:\s*["']?[a-zA-Z0-9_-]{20,}/g,
      /bot_token:\s*["']?[a-zA-Z0-9._-]{20,}/g,
    ]
    for (const kp of keyPatterns) {
      if (kp.test(content)) {
        warnings.push('rivet.config.yaml contains inline API keys/tokens. Move them to .env')
        break
      }
    }
  } catch {
    // Config doesn't exist — that's fine
  }
  return warnings
}

/**
 * Get the list of known env var names that contain secrets.
 */
export function getSecretEnvVars(): string[] {
  return [...SECRET_ENV_VARS]
}

/**
 * Resolve env vars that are 1Password references (op://vault/item/field).
 * Requires 1Password CLI (`op`) to be installed and authenticated.
 */
export async function resolveOpReferences(
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const resolved = { ...env }
  const opRefs = Object.entries(env).filter(([, v]) => v.startsWith('op://'))

  if (opRefs.length === 0) return resolved

  // Check if 1Password CLI is available
  const { execSync } = await import('node:child_process')
  try {
    execSync('op --version', { timeout: 3000, stdio: 'ignore' })
  } catch {
    log.warn('1Password CLI not found — op:// references will not be resolved')
    return resolved
  }

  for (const [key, ref] of opRefs) {
    try {
      const value = execSync(`op read "${ref}"`, {
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim()
      resolved[key] = value
      log.debug(`Resolved 1Password reference for ${key}`)
    } catch (err) {
      log.warn(`Failed to resolve 1Password reference for ${key}: ${(err as Error).message}`)
    }
  }

  return resolved
}
