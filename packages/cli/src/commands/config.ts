/**
 * rivetos config <subcommand>
 *
 * config show       — print current config path and summary
 * config validate   — validate config schema without starting
 * config edit       — open config in $EDITOR
 * config path       — print config file path only
 */

import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'
import { validateConfig, formatValidationResult } from '@rivetos/boot'

function getConfigPath(): string {
  return resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
}

export default async function config(): Promise<void> {
  const subcommand = process.argv[3]

  if (!subcommand || subcommand === 'help') {
    console.log('Usage: rivetos config <subcommand>')
    console.log('')
    console.log('Subcommands:')
    console.log('  show       Print config summary')
    console.log('  validate   Validate config schema (dry run)')
    console.log('  edit       Open config in $EDITOR')
    console.log('  path       Print config file path')
    console.log('')
    console.log('To create a new config: rivetos init')
    return
  }

  switch (subcommand) {
    case 'show': {
      const configPath = getConfigPath()
      let raw: string
      try {
        raw = await readFile(configPath, 'utf-8')
      } catch {
        console.log('No config found. Run: rivetos init')
        return
      }

      try {
        const parsed = parseYaml(raw) as Record<string, unknown>

        console.log(`Config: ${configPath}\n`)

        // Agents
        const agents = (parsed.agents ?? {}) as Record<
          string,
          { provider?: string; default_thinking?: string }
        >
        const agentNames = Object.keys(agents)
        console.log(`Agents (${agentNames.length}):`)
        for (const [name, cfg] of Object.entries(agents)) {
          console.log(
            `  ${name} → ${cfg.provider ?? 'unknown'}${cfg.default_thinking ? ` (thinking: ${cfg.default_thinking})` : ''}`,
          )
        }

        // Providers
        const providers = (parsed.providers ?? {}) as Record<string, { model?: string }>
        console.log(`\nProviders (${Object.keys(providers).length}):`)
        for (const [name, cfg] of Object.entries(providers)) {
          console.log(`  ${name} → ${cfg.model ?? 'default'}`)
        }

        // Channels
        const channels = (parsed.channels ?? {}) as Record<string, unknown>
        const channelNames = Object.keys(channels)
        console.log(`\nChannels: ${channelNames.length > 0 ? channelNames.join(', ') : 'none'}`)

        // Deployment
        const deployment = parsed.deployment as { target?: string } | undefined
        if (deployment) {
          console.log(`\nDeployment: ${deployment.target ?? 'unknown'}`)
        } else {
          console.log('\nDeployment: manual (bare metal)')
        }

        // Runtime
        const runtime = (parsed.runtime ?? {}) as {
          default_agent?: string
          workspace?: string
        }
        console.log(`\nDefault agent: ${runtime.default_agent ?? 'not set'}`)
        console.log(`Workspace: ${runtime.workspace ?? '~/.rivetos/workspace'}`)
      } catch (err: unknown) {
        console.error(`Failed to parse config: ${(err as Error).message}`)
        process.exit(1)
      }
      break
    }

    case 'validate': {
      const configPath = process.argv[4] ?? getConfigPath()

      let raw: string
      try {
        raw = await readFile(configPath, 'utf-8')
      } catch {
        console.error(`❌ Cannot read config file: ${configPath}`)
        process.exit(1)
        return
      }

      let parsed: unknown
      try {
        parsed = parseYaml(raw)
      } catch (err: unknown) {
        console.error(`❌ Failed to parse YAML: ${(err as Error).message}`)
        process.exit(1)
        return
      }

      const result = validateConfig(parsed)
      console.log(formatValidationResult(result))

      if (!result.valid) {
        process.exit(1)
      }
      break
    }

    case 'edit': {
      const configPath = getConfigPath()
      try {
        await access(configPath)
      } catch {
        console.log('No config found. Run: rivetos init')
        process.exit(1)
        return
      }

      const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi'
      try {
        execSync(`${editor} ${configPath}`, { stdio: 'inherit' })
      } catch {
        console.error(`Failed to open editor: ${editor}`)
        console.log(`Edit manually: ${configPath}`)
      }
      break
    }

    case 'path': {
      const configPath = getConfigPath()
      try {
        await access(configPath)
        console.log(configPath)
      } catch {
        console.log('No config found. Run: rivetos init')
        process.exit(1)
      }
      break
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      console.log('Run: rivetos config help')
      process.exit(1)
  }
}
