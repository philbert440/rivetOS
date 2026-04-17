/**
 * rivetos plugins <subcommand>
 *
 * Show configured plugins and their status.
 *
 * Usage:
 *   rivetos plugins list       Show all configured plugins with status
 */

import { readFile, readdir, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

// ---------------------------------------------------------------------------
// Plugin types and discovery
// ---------------------------------------------------------------------------

interface PluginInfo {
  type: 'provider' | 'channel' | 'memory' | 'tool'
  name: string
  status: 'configured' | 'available' | 'missing-key'
  detail?: string
}

/**
 * Get all available plugin directories (what's physically installed).
 */
async function getInstalledPlugins(): Promise<Map<string, Set<string>>> {
  const categories = ['providers', 'channels', 'memory', 'tools']
  const installed = new Map<string, Set<string>>()

  for (const category of categories) {
    const dir = join(ROOT, 'plugins', category)
    const set = new Set<string>()
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Verify it has a src/index.ts (actual plugin, not junk)
          try {
            await access(join(dir, entry.name, 'src', 'index.ts'))
            set.add(entry.name)
          } catch {
            /* expected */
          }
        }
      }
    } catch {
      /* expected */
    }
    installed.set(category, set)
  }

  return installed
}

/**
 * Check if the env var or config value for a provider key is set.
 */
function checkProviderAuth(
  name: string,
  config: Record<string, unknown>,
): { ok: boolean; detail: string } {
  // Check for API key in config
  if (config.api_key) return { ok: true, detail: 'api_key in config' }

  // Check env vars by convention
  const envVarMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    xai: 'XAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    ollama: '', // no key needed
    'openai-compat': 'OPENAI_API_KEY',
    'llama-server': '', // no key needed
  }

  const envVar = envVarMap[name]
  if (envVar === '') return { ok: true, detail: 'no key required' }
  if (envVar && process.env[envVar]) return { ok: true, detail: `${envVar} set` }

  return { ok: false, detail: envVar ? `${envVar} not set` : 'unknown auth' }
}

function checkChannelAuth(
  name: string,
  config: Record<string, unknown>,
): { ok: boolean; detail: string } {
  if (config.bot_token) return { ok: true, detail: 'bot_token in config' }

  const envVarMap: Record<string, string> = {
    telegram: 'TELEGRAM_BOT_TOKEN',
    discord: 'DISCORD_BOT_TOKEN',
    'voice-discord': 'DISCORD_BOT_TOKEN',
  }

  const envVar = envVarMap[name]
  if (envVar && process.env[envVar]) return { ok: true, detail: `${envVar} set` }
  return { ok: false, detail: envVar ? `${envVar} not set` : 'unknown auth' }
}

function checkMemoryAuth(
  name: string,
  config: Record<string, unknown>,
): { ok: boolean; detail: string } {
  if (config.connection_string) return { ok: true, detail: 'connection_string in config' }

  if (name === 'postgres') {
    if (process.env.RIVETOS_PG_URL) return { ok: true, detail: 'RIVETOS_PG_URL set' }
    return { ok: false, detail: 'RIVETOS_PG_URL not set' }
  }

  return { ok: true, detail: '' }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export default async function plugins(): Promise<void> {
  const subcommand = process.argv[3]

  if (!subcommand || subcommand === 'help') {
    console.log('Usage: rivetos plugins <subcommand>')
    console.log('')
    console.log('Subcommands:')
    console.log('  list       Show all plugins with status')
    return
  }

  switch (subcommand) {
    case 'list': {
      const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
      let config: Record<string, unknown> | null = null

      try {
        const raw = await readFile(configPath, 'utf-8')
        config = parseYaml(raw) as Record<string, unknown>
      } catch {
        console.error(`❌ Cannot read config: ${configPath}`)
        console.error('   Run: rivetos config init')
        process.exit(1)
      }

      const installed = await getInstalledPlugins()
      const results: PluginInfo[] = []

      // Providers
      const providers = (config.providers ?? {}) as Partial<Record<string, Record<string, unknown>>>
      const installedProviders = installed.get('providers') ?? new Set()

      for (const [name, provConfig] of Object.entries(providers)) {
        if (!provConfig) continue
        const auth = checkProviderAuth(name, provConfig)
        const model = provConfig.model as string | undefined
        results.push({
          type: 'provider',
          name,
          status: auth.ok ? 'configured' : 'missing-key',
          detail: model ? `model: ${model}, ${auth.detail}` : auth.detail,
        })
      }

      // Show installed but unconfigured providers
      for (const name of installedProviders) {
        if (!providers[name]) {
          results.push({
            type: 'provider',
            name,
            status: 'available',
            detail: 'installed but not in config',
          })
        }
      }

      // Channels
      const channels = (config.channels ?? {}) as Partial<Record<string, Record<string, unknown>>>
      const installedChannels = installed.get('channels') ?? new Set()

      for (const [name, chanConfig] of Object.entries(channels)) {
        if (!chanConfig) continue
        const auth = checkChannelAuth(name, chanConfig)
        results.push({
          type: 'channel',
          name,
          status: auth.ok ? 'configured' : 'missing-key',
          detail: auth.detail,
        })
      }

      for (const name of installedChannels) {
        if (!channels[name]) {
          results.push({
            type: 'channel',
            name,
            status: 'available',
            detail: 'installed but not in config',
          })
        }
      }

      // Memory
      const memory = (config.memory ?? {}) as Partial<Record<string, Record<string, unknown>>>
      const installedMemory = installed.get('memory') ?? new Set()

      for (const [name, memConfig] of Object.entries(memory)) {
        if (!memConfig) continue
        const auth = checkMemoryAuth(name, memConfig)
        results.push({
          type: 'memory',
          name,
          status: auth.ok ? 'configured' : 'missing-key',
          detail: auth.detail,
        })
      }

      for (const name of installedMemory) {
        if (!memory[name]) {
          results.push({
            type: 'memory',
            name,
            status: 'available',
            detail: 'installed but not in config',
          })
        }
      }

      // Tools (always available — not individually configured)
      const installedTools = installed.get('tools') ?? new Set()
      for (const name of installedTools) {
        results.push({
          type: 'tool',
          name,
          status: 'configured',
          detail: 'built-in',
        })
      }

      // Print results
      if (results.length === 0) {
        console.log('No plugins found.')
        return
      }

      const statusIcon = (s: string) => {
        switch (s) {
          case 'configured':
            return '✅'
          case 'available':
            return '⚪'
          case 'missing-key':
            return '⚠️ '
          default:
            return '?'
        }
      }

      // Group by type
      const groups: Partial<Record<string, PluginInfo[]>> = {}
      for (const r of results) {
        ;(groups[r.type] ??= []).push(r)
      }

      const typeLabels: Record<string, string> = {
        provider: 'Providers',
        channel: 'Channels',
        memory: 'Memory',
        tool: 'Tools',
      }

      for (const type of ['provider', 'channel', 'memory', 'tool']) {
        const items = groups[type]
        if (!items || items.length === 0) continue

        console.log(`\n${typeLabels[type]}:`)
        for (const item of items) {
          const icon = statusIcon(item.status)
          const detail = item.detail ? `  (${item.detail})` : ''
          console.log(`  ${icon} ${item.name}${detail}`)
        }
      }

      console.log('')
      break
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      process.exit(1)
  }
}
