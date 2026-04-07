/**
 * rivetos agent <subcommand>
 *
 * agent list       — list configured agents
 * agent add        — add a new agent interactively
 * agent remove     — remove an agent
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import * as p from '@clack/prompts'
import { configureAgents, PROVIDER_ENV_KEYS } from './init/agents.js'

function getConfigPath(): string {
  return resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
}

function getEnvPath(): string {
  return resolve(process.env.HOME ?? '.', '.rivetos', '.env')
}

export default async function agent(): Promise<void> {
  const subcommand = process.argv[3]

  if (!subcommand || subcommand === 'help') {
    console.log('Usage: rivetos agent <subcommand>')
    console.log('')
    console.log('Subcommands:')
    console.log('  list     List configured agents')
    console.log('  add      Add a new agent interactively')
    console.log('  remove   Remove an agent')
    return
  }

  switch (subcommand) {
    case 'list':
      await listAgents()
      break
    case 'add':
      await addAgent()
      break
    case 'remove':
      await removeAgent()
      break
    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      process.exit(1)
  }
}

async function loadConfig(): Promise<{
  raw: string
  parsed: Record<string, unknown>
  path: string
}> {
  const path = getConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    console.error('No config found. Run: rivetos init')
    process.exit(1)
    throw new Error('unreachable')
  }
  const parsed = parseYaml(raw) as Record<string, unknown>
  return { raw, parsed, path }
}

async function listAgents(): Promise<void> {
  const { parsed } = await loadConfig()
  const agents = (parsed.agents ?? {}) as Record<string, Record<string, unknown>>
  const providers = (parsed.providers ?? {}) as Record<string, Record<string, unknown>>

  if (Object.keys(agents).length === 0) {
    console.log('No agents configured. Run: rivetos agent add')
    return
  }

  console.log('Configured agents:\n')
  for (const [name, cfg] of Object.entries(agents)) {
    const providerName = (cfg.provider as string | undefined) ?? 'unknown'
    const providerCfg = providers[providerName] ?? {}
    const model = (providerCfg.model as string | undefined) ?? 'default'
    const thinking = (cfg.default_thinking as string | undefined) ?? 'off'
    console.log(`  ${name}`)
    console.log(`    Provider: ${providerName}`)
    console.log(`    Model:    ${model}`)
    console.log(`    Thinking: ${thinking}`)
    console.log('')
  }
}

async function addAgent(): Promise<void> {
  p.intro('🔩 Add Agent')

  // Run the agent config wizard (reuses init/agents.ts)
  const newAgents = await configureAgents()
  if (newAgents.length === 0) {
    p.outro('No agents added.')
    return
  }

  const { parsed, path } = await loadConfig()
  const agents = (parsed.agents ?? {}) as Record<string, Record<string, unknown>>
  const providers = (parsed.providers ?? {}) as Record<string, Record<string, unknown> | undefined>

  for (const agent of newAgents) {
    // Add agent entry
    agents[agent.name] = {
      provider: agent.provider,
      ...(agent.thinking !== 'off' ? { default_thinking: agent.thinking } : {}),
    }

    // Add provider if not already present
    if (!providers[agent.provider]) {
      const providerCfg: Record<string, unknown> = {
        model: agent.model,
        max_tokens: 8192,
      }
      if (agent.baseUrl) providerCfg.base_url = agent.baseUrl
      providers[agent.provider] = providerCfg
    }

    // Append API key to .env if needed
    if (agent.apiKey) {
      const envKey = PROVIDER_ENV_KEYS[agent.provider]
      if (envKey) {
        await appendEnvKey(envKey, agent.apiKey, agent.provider)
      }
    }
  }

  parsed.agents = agents
  parsed.providers = providers

  // Write updated config
  const header =
    '# RivetOS Configuration\n# API keys and tokens are stored in .env — never in this file.\n\n'
  await writeFile(path, header + toYaml(parsed, { lineWidth: 120 }), 'utf-8')

  p.log.success(`Added ${newAgents.length} agent(s). Config updated: ${path}`)
  p.log.info('Restart the runtime to apply changes: rivetos service restart')
  p.outro('Done.')
}

async function removeAgent(): Promise<void> {
  const { parsed, path } = await loadConfig()
  const agents = (parsed.agents ?? {}) as Record<string, Record<string, unknown>>
  const agentNames = Object.keys(agents)

  if (agentNames.length === 0) {
    console.log('No agents to remove.')
    return
  }

  p.intro('🔩 Remove Agent')

  const name = await p.select({
    message: 'Which agent do you want to remove?',
    options: agentNames.map((n) => ({
      value: n,
      label: n,
      hint: typeof agents[n].provider === 'string' ? agents[n].provider : '',
    })),
  })

  if (p.isCancel(name)) {
    p.cancel('Cancelled.')
    return
  }

  const runtime = (parsed.runtime ?? {}) as Record<string, unknown>
  if (runtime.default_agent === name) {
    p.log.warn(`"${name}" is the default agent. You'll need to update runtime.default_agent.`)
  }

  const confirm = await p.confirm({
    message: `Remove agent "${name}"?`,
    initialValue: false,
  })

  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Cancelled.')
    return
  }

  const { [name]: _, ...remaining } = agents
  parsed.agents = remaining

  const header =
    '# RivetOS Configuration\n# API keys and tokens are stored in .env — never in this file.\n\n'
  await writeFile(path, header + toYaml(parsed, { lineWidth: 120 }), 'utf-8')

  p.log.success(`Removed agent "${name}". Config updated: ${path}`)
  p.log.info('Restart the runtime to apply changes: rivetos service restart')
  p.outro('Done.')
}

async function appendEnvKey(key: string, value: string, comment: string): Promise<void> {
  const envPath = getEnvPath()
  let existing = ''
  try {
    existing = await readFile(envPath, 'utf-8')
  } catch {
    // File doesn't exist
  }

  // Check if key already exists
  if (existing.split('\n').some((line) => line.startsWith(`${key}=`))) {
    return // Don't duplicate
  }

  const entry = `# ${comment}\n${key}=${value}\n\n`
  const content = existing ? existing.trimEnd() + '\n\n' + entry : entry
  await writeFile(envPath, content, 'utf-8')
}
