/**
 * rivetos model [provider] [model]
 *
 * Progressive discovery:
 *   rivetos model                          — list all providers + current models
 *   rivetos model <provider>               — show current model for that provider
 *   rivetos model <provider> <model>       — switch to that model (persisted)
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

interface ProviderConfig {
  model?: string
  base_url?: string
  [key: string]: unknown
}

interface ParsedConfig {
  providers?: Record<string, ProviderConfig>
  agents?: Record<string, { provider?: string; [key: string]: unknown }>
  [key: string]: unknown
}

export default async function model(): Promise<void> {
  const args = process.argv.slice(3)
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')

  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch {
    console.error('❌ Cannot read config. Run: rivetos config init')
    process.exit(1)
    return
  }

  let config: ParsedConfig
  try {
    config = parseYaml(raw) as ParsedConfig
  } catch (err: unknown) {
    console.error(`❌ Failed to parse config: ${(err as Error).message}`)
    process.exit(1)
    return
  }

  const providers = config.providers ?? {}
  const agents = config.agents ?? {}

  // rivetos model — list all providers + current models
  if (args.length === 0) {
    console.log('\n🤖 Configured providers:\n')
    const providerIds = Object.keys(providers)
    if (providerIds.length === 0) {
      console.log('  No providers configured.')
      return
    }

    for (const id of providerIds) {
      const p = providers[id]
      const currentModel = p.model ?? '(no model set)'
      const boundAgents = Object.entries(agents)
        .filter(([, a]) => a.provider === id)
        .map(([name]) => name)
      const agentStr = boundAgents.length > 0 ? boundAgents.join(', ') : 'none'
      console.log(`  ${id}`)
      console.log(`    Model:  ${currentModel}`)
      console.log(`    Agents: ${agentStr}`)
      if (p.base_url) console.log(`    URL:    ${p.base_url}`)
      console.log()
    }
    return
  }

  const providerId = args[0]

  if (!(providerId in providers)) {
    console.error(`❌ Unknown provider: ${providerId}`)
    console.error(`   Available: ${Object.keys(providers).join(', ')}`)
    return process.exit(1)
  }

  const providerConfig = providers[providerId]

  // rivetos model <provider> — show current model for that provider
  if (args.length === 1) {
    const currentModel = providerConfig.model ?? '(no model set)'
    const boundAgents = Object.entries(agents)
      .filter(([, a]) => a.provider === providerId)
      .map(([name]) => name)

    console.log(`\n🤖 ${providerId}`)
    console.log(`  Model:  ${currentModel}`)
    console.log(`  Agents: ${boundAgents.length > 0 ? boundAgents.join(', ') : 'none'}`)
    if (providerConfig.base_url) console.log(`  URL:    ${providerConfig.base_url}`)
    console.log()
    return
  }

  // rivetos model <provider> <model> — switch model
  const newModel = args.slice(1).join(' ')
  const oldModel = providerConfig.model ?? '(none)'

  // Update the YAML file — find the provider section and replace the model line
  const providerRegex = new RegExp(
    `(${providerId}:\\s*\\n(?:[ \\t]+\\w[^\\n]*\\n)*?[ \\t]+model:[ \\t]+)([^\\n]+)`,
  )
  const updated = raw.replace(providerRegex, `$1${newModel}`)

  if (updated === raw) {
    // Model line not found — try to add it under the provider section
    const sectionRegex = new RegExp(`(${providerId}:\\s*\\n)`)
    const withModel = raw.replace(sectionRegex, `$1    model: ${newModel}\n`)
    if (withModel === raw) {
      console.error(
        `❌ Could not update config — provider section "${providerId}" not found in YAML`,
      )
      return process.exit(1)
    }
    await writeFile(configPath, withModel, 'utf-8')
  } else {
    await writeFile(configPath, updated, 'utf-8')
  }

  console.log(`✅ ${providerId} model: ${oldModel} → ${newModel}`)
  console.log('   Saved to config. Restart the runtime for the change to take effect.')
}
