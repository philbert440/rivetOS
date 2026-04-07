/**
 * rivetos doctor
 *
 * Comprehensive health check for a RivetOS installation.
 *
 * Checks:
 *   1. System — Node.js version, memory, disk space
 *   2. Config — file exists, schema validates
 *   3. Workspace — required/optional files present
 *   4. Environment — API keys, tokens, secrets
 *   5. Secrets — .env permissions, no secrets in config YAML
 *   6. OAuth — Anthropic token validity
 *   7. Containers — Docker health (if applicable)
 *   8. Memory backend — Postgres connectivity
 *   9. Shared storage — /shared/ mount writable
 *  10. Provider connectivity — API endpoint reachability
 *  11. DNS — can resolve provider hostnames
 *  12. Peer reachability — health check other agents in mesh
 *
 * Usage:
 *   rivetos doctor               Run all checks
 *   rivetos doctor --json        Output results as JSON
 *   rivetos doctor --help        Show help
 */

import { readFile, access, writeFile, unlink, stat as fsStat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'
import { validateConfig } from '@rivetos/boot'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string
  category: string
  status: 'pass' | 'warn' | 'fail'
  message: string
  detail?: string
}

interface DoctorReport {
  version: string
  timestamp: string
  checks: CheckResult[]
  summary: { pass: number; warn: number; fail: number }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface DoctorOptions {
  json: boolean
}

function parseArgs(): DoctorOptions {
  const args = process.argv.slice(3)
  const opts: DoctorOptions = { json: false }

  for (const arg of args) {
    switch (arg) {
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        showHelp()
        process.exit(0)
        break
    }
  }

  return opts
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERSION = '0.2.0'

function check(
  category: string,
  name: string,
  status: 'pass' | 'warn' | 'fail',
  message: string,
  detail?: string,
): CheckResult {
  return { category, name, status, message, detail }
}

function printCheck(r: CheckResult): void {
  const icon = r.status === 'pass' ? '✅' : r.status === 'warn' ? '⚠️ ' : '❌'
  console.log(`${icon} ${r.message}`)
  if (r.detail) {
    console.log(`   ${r.detail}`)
  }
}

// ---------------------------------------------------------------------------
// Check: System
// ---------------------------------------------------------------------------

async function checkSystem(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // Node.js version
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10)
  if (major >= 20) {
    results.push(check('system', 'node', 'pass', `Node.js: ${nodeVersion}`))
  } else {
    results.push(
      check(
        'system',
        'node',
        'fail',
        `Node.js: ${nodeVersion} (requires >=20)`,
        'Install Node.js 20 or later',
      ),
    )
  }

  // Memory
  const os = await import('node:os')
  const totalMem = Math.round(os.totalmem() / 1024 / 1024)
  const freeMem = Math.round(os.freemem() / 1024 / 1024)
  if (freeMem > 512) {
    results.push(
      check('system', 'memory', 'pass', `Memory: ${freeMem}MB free / ${totalMem}MB total`),
    )
  } else if (freeMem > 256) {
    results.push(
      check('system', 'memory', 'warn', `Memory: ${freeMem}MB free / ${totalMem}MB total (low)`),
    )
  } else {
    results.push(
      check(
        'system',
        'memory',
        'fail',
        `Memory: ${freeMem}MB free / ${totalMem}MB total (critical)`,
      ),
    )
  }

  // Disk space on workspace
  const workspaceDir = resolve(process.env.HOME ?? '.', '.rivetos')
  try {
    const df = execSync(`df -m "${workspaceDir}" 2>/dev/null | tail -1`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    const parts = df.split(/\s+/)
    if (parts.length >= 4) {
      const availMB = parseInt(parts[3], 10)
      if (availMB > 1024) {
        results.push(
          check('system', 'disk', 'pass', `Disk: ${Math.round(availMB / 1024)}GB available`),
        )
      } else if (availMB > 256) {
        results.push(check('system', 'disk', 'warn', `Disk: ${availMB}MB available (low)`))
      } else {
        results.push(check('system', 'disk', 'fail', `Disk: ${availMB}MB available (critical)`))
      }
    }
  } catch {
    results.push(check('system', 'disk', 'warn', 'Disk: unable to check disk space'))
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Config
// ---------------------------------------------------------------------------

async function checkConfig(): Promise<{ results: CheckResult[]; rawConfig: string | null }> {
  const results: CheckResult[] = []
  let rawConfig: string | null = null

  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  try {
    rawConfig = await readFile(configPath, 'utf-8')
    results.push(check('config', 'file', 'pass', `Config file: ${configPath}`))
  } catch {
    results.push(check('config', 'file', 'fail', `Config file: not found`, 'Run: rivetos init'))
    return { results, rawConfig }
  }

  // Schema validation
  try {
    const parsed = parseYaml(rawConfig) as Record<string, unknown>
    const result = validateConfig(parsed)

    if (result.valid && result.warnings.length === 0) {
      results.push(check('config', 'schema', 'pass', 'Config schema: valid'))
    } else if (result.valid) {
      results.push(
        check(
          'config',
          'schema',
          'warn',
          `Config schema: valid with ${result.warnings.length} warning(s)`,
          result.warnings.map((w) => `[${w.path}] ${w.message}`).join('; '),
        ),
      )
    } else {
      results.push(
        check(
          'config',
          'schema',
          'fail',
          `Config schema: ${result.errors.length} error(s)`,
          result.errors.map((e) => `[${e.path}] ${e.message}`).join('; '),
        ),
      )
    }
  } catch (err) {
    results.push(
      check('config', 'schema', 'fail', `Config schema: parse error`, (err as Error).message),
    )
  }

  return { results, rawConfig }
}

// ---------------------------------------------------------------------------
// Check: Workspace
// ---------------------------------------------------------------------------

async function checkWorkspace(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const workspacePath = resolve(process.env.HOME ?? '.', '.rivetos', 'workspace')

  const requiredFiles = ['CORE.md', 'WORKSPACE.md']
  const optionalFiles = ['USER.md', 'MEMORY.md', 'CAPABILITIES.md', 'HEARTBEAT.md']

  for (const file of requiredFiles) {
    try {
      await access(resolve(workspacePath, file))
      results.push(check('workspace', file, 'pass', `Workspace: ${file}`))
    } catch {
      results.push(check('workspace', file, 'fail', `Workspace: ${file} missing (required)`))
    }
  }

  for (const file of optionalFiles) {
    try {
      await access(resolve(workspacePath, file))
      results.push(check('workspace', file, 'pass', `Workspace: ${file}`))
    } catch {
      results.push(check('workspace', file, 'warn', `Workspace: ${file} missing (optional)`))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Environment Variables
// ---------------------------------------------------------------------------

function checkEnvVars(rawConfig: string | null): CheckResult[] {
  const results: CheckResult[] = []
  const envChecks: Array<{ name: string; context: string }> = []

  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as Record<string, unknown>
      const providers = (parsed.providers ?? {}) as Partial<Record<string, Record<string, unknown>>>
      const channels = (parsed.channels ?? {}) as Partial<Record<string, Record<string, unknown>>>
      const memory = (parsed.memory ?? {}) as Partial<Record<string, Record<string, unknown>>>

      if (providers.anthropic && !providers.anthropic.api_key) {
        envChecks.push({ name: 'ANTHROPIC_API_KEY', context: 'provider: anthropic' })
      }
      if (providers.xai && !providers.xai.api_key) {
        envChecks.push({ name: 'XAI_API_KEY', context: 'provider: xai' })
      }
      if (providers.google && !providers.google.api_key) {
        envChecks.push({ name: 'GOOGLE_API_KEY', context: 'provider: google' })
      }

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

      if (memory.postgres && !memory.postgres.connection_string) {
        envChecks.push({ name: 'RIVETOS_PG_URL', context: 'memory: postgres' })
      }
    } catch {
      /* expected */
    }
  }

  if (envChecks.length === 0) {
    envChecks.push(
      { name: 'ANTHROPIC_API_KEY', context: 'provider' },
      { name: 'RIVETOS_PG_URL', context: 'memory' },
    )
  }

  for (const { name, context } of envChecks) {
    const value = process.env[name]
    if (value) {
      results.push(
        check('env', name, 'pass', `Env: ${name} = ${value.slice(0, 8)}... (${context})`),
      )
    } else {
      results.push(check('env', name, 'warn', `Env: ${name} not set (needed for ${context})`))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Secrets
// ---------------------------------------------------------------------------

async function checkSecrets(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const envPath = resolve(process.env.HOME ?? '.', '.rivetos', '.env')
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')

  // .env permissions
  try {
    const stats = await fsStat(envPath)
    const mode = stats.mode & 0o777
    if (mode === 0o600) {
      results.push(check('secrets', 'env-perms', 'pass', '.env permissions: 600'))
    } else {
      results.push(
        check(
          'secrets',
          'env-perms',
          'warn',
          `.env permissions: ${mode.toString(8)} (should be 600)`,
          'Run: chmod 600 ~/.rivetos/.env',
        ),
      )
    }
  } catch {
    results.push(check('secrets', 'env-perms', 'warn', '.env file not found'))
  }

  // Secrets in config
  try {
    const content = await readFile(configPath, 'utf-8')
    const secretPatterns = [
      /sk-ant-[a-zA-Z0-9_-]+/,
      /sk-[a-zA-Z0-9]{48,}/,
      /xai-[a-zA-Z0-9_-]+/,
      /api_key:\s*["']?[a-zA-Z0-9_-]{20,}/,
      /bot_token:\s*["']?[a-zA-Z0-9._-]{20,}/,
    ]
    const hasSecrets = secretPatterns.some((p) => p.test(content))
    if (hasSecrets) {
      results.push(
        check('secrets', 'config-secrets', 'warn', 'Config contains secrets — move them to .env'),
      )
    } else {
      results.push(check('secrets', 'config-secrets', 'pass', 'Config: no embedded secrets'))
    }
  } catch {
    // No config — skip
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: OAuth
// ---------------------------------------------------------------------------

async function checkOAuth(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const tokenPath = resolve(process.env.HOME ?? '.', '.rivetos', 'anthropic-tokens.json')

  try {
    const raw = await readFile(tokenPath, 'utf-8')
    const tokens = JSON.parse(raw) as {
      expiresAt: number
      refreshToken?: string
      accessToken?: string
    }
    const expired = Date.now() >= tokens.expiresAt
    const hasRefresh = !!tokens.refreshToken

    if (hasRefresh) {
      results.push(
        check(
          'oauth',
          'anthropic',
          'pass',
          `Anthropic OAuth: ${expired ? 'access expired, will auto-refresh' : 'valid'}`,
        ),
      )
    } else if (!expired) {
      results.push(
        check(
          'oauth',
          'anthropic',
          'warn',
          'Anthropic OAuth: access token only (no refresh — will expire)',
        ),
      )
    } else {
      results.push(
        check(
          'oauth',
          'anthropic',
          'fail',
          'Anthropic OAuth: expired, no refresh token',
          'Run: rivetos login anthropic',
        ),
      )
    }
  } catch {
    results.push(
      check(
        'oauth',
        'anthropic',
        'warn',
        'Anthropic OAuth: not configured (run: rivetos login anthropic)',
      ),
    )
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Containers
// ---------------------------------------------------------------------------

function checkContainers(): CheckResult[] {
  const results: CheckResult[] = []

  // Only check if Docker is available
  try {
    execSync('docker compose version 2>/dev/null', { timeout: 5000, stdio: 'ignore' })
  } catch {
    return results // Docker not available — skip
  }

  try {
    const output = execSync('docker compose ps --format json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10_000,
      cwd: process.env.HOME ? resolve(process.env.HOME, '.rivetos') : undefined,
    }).trim()

    if (!output) {
      results.push(check('containers', 'docker', 'warn', 'Docker: no containers running'))
      return results
    }

    // Docker compose outputs one JSON object per line
    const containers = output
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { Name: string; State: string; Health: string }
        } catch {
          return null
        }
      })
      .filter(Boolean) as Array<{ Name: string; State: string; Health: string }>

    for (const c of containers) {
      const healthy = c.State === 'running' && (c.Health === 'healthy' || c.Health === '')
      results.push(
        check(
          'containers',
          c.Name,
          healthy ? 'pass' : 'warn',
          `Container ${c.Name}: ${c.State}${c.Health ? ` (${c.Health})` : ''}`,
        ),
      )
    }
  } catch {
    results.push(check('containers', 'docker', 'warn', 'Docker: unable to check container status'))
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Memory Backend
// ---------------------------------------------------------------------------

async function checkMemoryBackend(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const pgUrl = process.env.RIVETOS_PG_URL

  if (!pgUrl) {
    results.push(check('memory', 'postgres', 'warn', 'Memory backend: RIVETOS_PG_URL not set'))
    return results
  }

  try {
    // Dynamic import to avoid hard dependency on pg
    const { default: pg } = await import('pg')
    const client = new pg.Client({ connectionString: pgUrl })
    await client.connect()
    await client.query('SELECT 1')
    await client.end()
    results.push(check('memory', 'postgres', 'pass', 'Memory backend: PostgreSQL connected'))
  } catch (err) {
    results.push(
      check(
        'memory',
        'postgres',
        'fail',
        'Memory backend: PostgreSQL unreachable',
        (err as Error).message,
      ),
    )
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Shared Storage
// ---------------------------------------------------------------------------

async function checkSharedStorage(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const sharedDir = '/shared'

  try {
    await access(sharedDir)
  } catch {
    // /shared doesn't exist — might not be a multi-agent setup
    return results
  }

  // Check writable
  const testFile = resolve(sharedDir, '.doctor-test')
  try {
    await writeFile(testFile, 'doctor')
    await unlink(testFile)
    results.push(check('shared', 'writable', 'pass', 'Shared storage: /shared/ is writable'))
  } catch {
    results.push(check('shared', 'writable', 'fail', 'Shared storage: /shared/ is not writable'))
  }

  // Check subdirectories
  const expectedDirs = ['plans', 'docs', 'status', 'whiteboard']
  for (const dir of expectedDirs) {
    try {
      await access(resolve(sharedDir, dir))
    } catch {
      results.push(check('shared', dir, 'warn', `Shared storage: /shared/${dir}/ missing`))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: DNS
// ---------------------------------------------------------------------------

async function checkDNS(rawConfig: string | null): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const { lookup } = await import('node:dns/promises')

  const hosts: string[] = []
  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as Record<string, unknown>
      const providers = (parsed.providers ?? {}) as Record<string, unknown>
      if (providers.anthropic) hosts.push('api.anthropic.com')
      if (providers.xai) hosts.push('api.x.ai')
      if (providers.google) hosts.push('generativelanguage.googleapis.com')
      if (providers.openai) hosts.push('api.openai.com')
    } catch {
      /* expected */
    }
  }

  // Always check at least one
  if (hosts.length === 0) hosts.push('api.anthropic.com')

  for (const host of hosts) {
    try {
      await lookup(host)
      results.push(check('dns', host, 'pass', `DNS: ${host} resolves`))
    } catch {
      results.push(check('dns', host, 'fail', `DNS: ${host} failed to resolve`))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Provider Connectivity
// ---------------------------------------------------------------------------

async function checkProviders(rawConfig: string | null): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  if (!rawConfig) return results

  try {
    const parsed = parseYaml(rawConfig) as Record<string, unknown>
    const providers = (parsed.providers ?? {}) as Partial<Record<string, Record<string, unknown>>>

    for (const [name, providerCfg] of Object.entries(providers)) {
      if (!providerCfg) continue
      try {
        const ok = await checkProviderConnectivity(name, providerCfg)
        if (ok) {
          results.push(check('providers', name, 'pass', `Provider ${name}: reachable`))
        } else {
          results.push(check('providers', name, 'fail', `Provider ${name}: unreachable`))
        }
      } catch (err) {
        results.push(
          check('providers', name, 'fail', `Provider ${name}: error`, (err as Error).message),
        )
      }
    }
  } catch {
    /* expected */
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Peer Reachability
// ---------------------------------------------------------------------------

async function checkPeers(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // Check for mesh.json
  const meshPath = resolve(process.env.HOME ?? '.', '.rivetos', 'mesh.json')
  try {
    const raw = await readFile(meshPath, 'utf-8')
    const mesh = JSON.parse(raw) as Array<{ name: string; host: string; port: number }>

    for (const peer of mesh) {
      try {
        const resp = await fetch(`http://${peer.host}:${peer.port}/health/live`, {
          signal: AbortSignal.timeout(3000),
        })
        if (resp.ok) {
          results.push(check('peers', peer.name, 'pass', `Peer ${peer.name}: reachable`))
        } else {
          results.push(
            check('peers', peer.name, 'warn', `Peer ${peer.name}: responded ${resp.status}`),
          )
        }
      } catch {
        results.push(check('peers', peer.name, 'fail', `Peer ${peer.name}: unreachable`))
      }
    }
  } catch {
    // No mesh.json — not a multi-agent setup, skip
  }

  return results
}

// ---------------------------------------------------------------------------
// Provider Connectivity (kept from original)
// ---------------------------------------------------------------------------

async function checkProviderConnectivity(
  name: string,
  config: Record<string, unknown>,
): Promise<boolean> {
  const timeout = 5000

  switch (name) {
    case 'anthropic': {
      const apiKey = (config.api_key as string | undefined) ?? process.env.ANTHROPIC_API_KEY ?? ''
      if (!apiKey) {
        try {
          const tokenPath = resolve(process.env.HOME ?? '.', '.rivetos', 'anthropic-tokens.json')
          const raw = await readFile(tokenPath, 'utf-8')
          const tokens = JSON.parse(raw) as { accessToken?: string }
          if (tokens.accessToken) {
            const resp = await fetch('https://api.anthropic.com/v1/models', {
              headers: {
                'x-api-key': tokens.accessToken,
                'anthropic-version': '2023-06-01',
              },
              signal: AbortSignal.timeout(timeout),
            })
            return resp.ok || resp.status === 401
          }
        } catch {
          /* expected */
        }
        return false
      }
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
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
        { signal: AbortSignal.timeout(timeout) },
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

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`Usage: rivetos doctor [options]

Runs comprehensive health checks on your RivetOS installation.

Options:
  --json        Output results as JSON (for CI/automation)
  -h, --help    Show this help

Checks: system, config, workspace, env vars, secrets, OAuth,
        containers, memory backend, shared storage, DNS,
        provider connectivity, peer reachability
`)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default async function doctor(): Promise<void> {
  const opts = parseArgs()
  const allResults: CheckResult[] = []

  if (!opts.json) {
    console.log(`RivetOS Doctor v${VERSION}\n`)
  }

  // Run all checks
  const systemResults = await checkSystem()
  allResults.push(...systemResults)

  const { results: configResults, rawConfig } = await checkConfig()
  allResults.push(...configResults)

  const workspaceResults = await checkWorkspace()
  allResults.push(...workspaceResults)

  const envResults = checkEnvVars(rawConfig)
  allResults.push(...envResults)

  const secretResults = await checkSecrets()
  allResults.push(...secretResults)

  const oauthResults = await checkOAuth()
  allResults.push(...oauthResults)

  const containerResults = checkContainers()
  allResults.push(...containerResults)

  const memoryResults = await checkMemoryBackend()
  allResults.push(...memoryResults)

  const sharedResults = await checkSharedStorage()
  allResults.push(...sharedResults)

  const dnsResults = await checkDNS(rawConfig)
  allResults.push(...dnsResults)

  const providerResults = await checkProviders(rawConfig)
  allResults.push(...providerResults)

  const peerResults = await checkPeers()
  allResults.push(...peerResults)

  // Summary
  const summary = {
    pass: allResults.filter((r) => r.status === 'pass').length,
    warn: allResults.filter((r) => r.status === 'warn').length,
    fail: allResults.filter((r) => r.status === 'fail').length,
  }

  if (opts.json) {
    const report: DoctorReport = {
      version: VERSION,
      timestamp: new Date().toISOString(),
      checks: allResults,
      summary,
    }
    console.log(JSON.stringify(report, null, 2))
  } else {
    // Group by category
    let currentCategory = ''
    for (const r of allResults) {
      if (r.category !== currentCategory) {
        currentCategory = r.category
        console.log(`\n[${currentCategory.toUpperCase()}]`)
      }
      printCheck(r)
    }

    console.log('')
    if (summary.fail === 0 && summary.warn === 0) {
      console.log(`✅ All ${summary.pass} checks passed.`)
    } else if (summary.fail === 0) {
      console.log(`✅ ${summary.pass} passed, ⚠️  ${summary.warn} warning(s). No critical issues.`)
    } else {
      console.log(
        `❌ ${summary.fail} issue(s), ⚠️  ${summary.warn} warning(s), ✅ ${summary.pass} passed.`,
      )
    }
  }

  if (summary.fail > 0) {
    process.exit(1)
  }
}
