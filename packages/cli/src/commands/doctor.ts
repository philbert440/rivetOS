/**
 * rivetos doctor
 *
 * Validates config schema, checks workspace files, environment variables,
 * OAuth tokens, and tests provider connectivity.
 */

import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateConfig } from '../validate.js'

const VERSION = '0.1.4'

export default async function doctor(): Promise<void> {
  console.log(`RivetOS Doctor v${VERSION}\n`)
  let issues = 0

  // 1. Config file — exists?
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  let rawConfig: string | null = null
  try {
    rawConfig = await readFile(configPath, 'utf-8')
    console.log(`✅ Config file: ${configPath}`)
  } catch {
    console.log(`❌ Config file: ${configPath} not found`)
    console.log('   Run: rivetos config init')
    issues++
  }

  // 2. Config schema validation
  console.log('')
  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as Record<string, unknown>
      const result = validateConfig(parsed)

      if (result.valid && result.warnings.length === 0) {
        console.log('✅ Config schema: valid')
      } else if (result.valid) {
        console.log(`⚠️  Config schema: valid with ${result.warnings.length} warning(s)`)
        for (const warn of result.warnings) {
          console.log(`   ⚠️  [${warn.path}] ${warn.message}`)
        }
      } else {
        console.log(`❌ Config schema: ${result.errors.length} error(s)`)
        for (const err of result.errors) {
          console.log(`   ❌ [${err.path}] ${(err as Error).message}`)
        }
        for (const warn of result.warnings) {
          console.log(`   ⚠️  [${warn.path}] ${warn.message}`)
        }
        issues += result.errors.length
      }
    } catch (err: unknown) {
      console.log(`❌ Config schema: failed to parse YAML — ${(err as Error).message}`)
      issues++
    }
  } else {
    console.log('⏭️  Config schema: skipped (no config file)')
  }

  // 3. Workspace directory
  console.log('')
  const workspacePath = resolve(process.env.HOME ?? '.', '.rivetos', 'workspace')
  const requiredFiles = ['SOUL.md', 'AGENTS.md']
  const optionalFiles = ['IDENTITY.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'HEARTBEAT.md']

  for (const file of requiredFiles) {
    try {
      await access(resolve(workspacePath, file))
      console.log(`✅ Workspace: ${file}`)
    } catch {
      console.log(`❌ Workspace: ${file} missing (required)`)
      issues++
    }
  }

  for (const file of optionalFiles) {
    try {
      await access(resolve(workspacePath, file))
      console.log(`✅ Workspace: ${file}`)
    } catch {
      console.log(`⚠️  Workspace: ${file} missing (optional)`)
    }
  }

  // 4. Environment variables
  // Build the list dynamically from config if available
  const envChecks: Array<{ name: string; context: string }> = []

  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as Record<string, unknown>
      const providers = (parsed.providers ?? {}) as Partial<Record<string, Record<string, unknown>>>
      const channels = (parsed.channels ?? {}) as Partial<Record<string, Record<string, unknown>>>
      const memory = (parsed.memory ?? {}) as Partial<Record<string, Record<string, unknown>>>

      // Provider API keys
      if (providers.anthropic && !providers.anthropic.api_key) {
        envChecks.push({ name: 'ANTHROPIC_API_KEY', context: 'provider: anthropic' })
      }
      if (providers.xai && !providers.xai.api_key) {
        envChecks.push({ name: 'XAI_API_KEY', context: 'provider: xai' })
      }
      if (providers.google && !providers.google.api_key) {
        envChecks.push({ name: 'GOOGLE_API_KEY', context: 'provider: google' })
      }

      // Channel tokens
      if (channels.telegram && !channels.telegram.bot_token) {
        envChecks.push({ name: 'TELEGRAM_BOT_TOKEN', context: 'channel: telegram' })
      }
      if (
        (channels.discord || channels.voice || channels['voice-discord']) &&
        !(
          channels.discord?.bot_token ||
          channels.voice?.bot_token ||
          channels['voice-discord']?.bot_token
        )
      ) {
        envChecks.push({ name: 'DISCORD_BOT_TOKEN', context: 'channel: discord' })
      }

      // Memory
      if (memory.postgres && !memory.postgres.connection_string) {
        envChecks.push({ name: 'RIVETOS_PG_URL', context: 'memory: postgres' })
      }
    } catch {
      /* expected */
    }
  }

  // Fallback if no config
  if (envChecks.length === 0) {
    envChecks.push(
      { name: 'ANTHROPIC_API_KEY', context: 'provider' },
      { name: 'RIVETOS_PG_URL', context: 'memory' },
    )
  }

  console.log('')
  for (const { name, context } of envChecks) {
    const value = process.env[name]
    if (value) {
      console.log(`✅ Env: ${name} = ${value.slice(0, 8)}... (${context})`)
    } else {
      console.log(`⚠️  Env: ${name} not set (needed for ${context})`)
    }
  }

  // 5. OAuth tokens
  console.log('')
  const tokenPath = resolve(process.env.HOME ?? '.', '.rivetos', 'anthropic-tokens.json')
  try {
    const raw = await readFile(tokenPath, 'utf-8')
    const tokens = JSON.parse(raw) as {
      expiresAt: number
      refreshToken?: string
      accessToken?: string
    } as { expiresAt: number; refreshToken?: string; accessToken?: string }
    const expired = Date.now() >= tokens.expiresAt
    const hasRefresh = !!tokens.refreshToken
    if (hasRefresh) {
      console.log(
        `✅ Anthropic OAuth: tokens stored ${expired ? '(access expired, will auto-refresh)' : '(valid)'}`,
      )
    } else if (!expired) {
      console.log(`⚠️  Anthropic OAuth: access token only (no refresh — will expire)`)
    } else {
      console.log(`❌ Anthropic OAuth: expired, no refresh token`)
      console.log('   Run: rivetos login anthropic')
      issues++
    }
  } catch {
    console.log(`⚠️  Anthropic OAuth: not configured (run: rivetos login anthropic)`)
  }

  // 6. Provider connectivity
  console.log('')
  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as Record<string, unknown>
      const providers = (parsed.providers ?? {}) as Partial<Record<string, Record<string, unknown>>>

      for (const [name, providerCfg] of Object.entries(providers)) {
        try {
          const ok = await checkProviderConnectivity(name, providerCfg)
          if (ok) {
            console.log(`✅ Provider ${name}: reachable`)
          } else {
            console.log(`❌ Provider ${name}: unreachable`)
            issues++
          }
        } catch (err: unknown) {
          console.log(`❌ Provider ${name}: ${(err as Error).message}`)
          issues++
        }
      }
    } catch {
      /* expected */
    }
  }

  // Summary
  console.log('')
  if (issues === 0) {
    console.log('✅ All checks passed.')
  } else {
    console.log(`⚠️  ${issues} issue(s) found.`)
  }
}

/**
 * Light connectivity check per provider — just verifies the endpoint is reachable.
 * Does NOT burn tokens by sending actual completions.
 */
async function checkProviderConnectivity(
  name: string,
  config: Record<string, unknown>,
): Promise<boolean> {
  const timeout = 5000

  switch (name) {
    case 'anthropic': {
      const apiKey = (config.api_key as string | undefined) ?? process.env.ANTHROPIC_API_KEY ?? ''
      if (!apiKey) {
        // Try OAuth
        try {
          const tokenPath = resolve(process.env.HOME ?? '.', '.rivetos', 'anthropic-tokens.json')
          const raw = await readFile(tokenPath, 'utf-8')
          const tokens = JSON.parse(raw) as {
            expiresAt: number
            refreshToken?: string
            accessToken?: string
          } as { expiresAt: number; refreshToken?: string; accessToken?: string }
          if (tokens.accessToken) {
            const resp = await fetch('https://api.anthropic.com/v1/models', {
              headers: {
                'x-api-key': tokens.accessToken,
                'anthropic-version': '2023-06-01',
              },
              signal: AbortSignal.timeout(timeout),
            })
            return resp.ok || resp.status === 401 // 401 = reachable, just bad key
          }
        } catch {
          /* expected */
        }
        return false
      }
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok || resp.status === 401
    }

    case 'xai': {
      const apiKey = (config.api_key as string | undefined) ?? process.env.XAI_API_KEY ?? ''
      if (!apiKey) return false
      const resp = await fetch('https://api.x.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok || resp.status === 401
    }

    case 'google': {
      const apiKey = (config.api_key as string | undefined) ?? process.env.GOOGLE_API_KEY ?? ''
      if (!apiKey) return false
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        {
          signal: AbortSignal.timeout(timeout),
        },
      )
      return resp.ok || resp.status === 401 || resp.status === 403
    }

    case 'ollama': {
      const baseUrl = (config.base_url as string | undefined) ?? 'http://localhost:11434'
      const resp = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok
    }

    case 'openai-compat':
    case 'llama-server': {
      const baseUrl = config.base_url as string
      if (!baseUrl) return false
      const resp = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok
    }

    default:
      return false
  }
}
