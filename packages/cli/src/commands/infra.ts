/**
 * rivetos infra <subcommand>
 *
 * infra up        — deploy containers based on config
 * infra preview   — show what would be deployed
 * infra destroy   — tear down all containers
 * infra status    — show infrastructure status
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

function getDataDir(): string {
  return resolve(process.env.HOME ?? '.', '.rivetos')
}

export default async function infra(): Promise<void> {
  const subcommand = process.argv[3]

  if (!subcommand || subcommand === 'help') {
    console.log('Usage: rivetos infra <subcommand>')
    console.log('')
    console.log('Subcommands:')
    console.log('  up        Deploy containers based on config')
    console.log('  preview   Show what would be deployed')
    console.log('  destroy   Tear down all containers')
    console.log('  status    Show infrastructure status')
    return
  }

  // Lazy-import to avoid loading Pulumi/infra deps when not needed.
  // @rivetos/infra is a private workspace package (Pulumi tooling) — only available
  // from a dev checkout, not from `npm install -g @rivetos/cli`.
  let InfraOrchestrator: typeof import('@rivetos/infra').InfraOrchestrator
  try {
    ;({ InfraOrchestrator } = await import('@rivetos/infra'))
  } catch (err: unknown) {
    console.error('❌ rivetos infra requires the @rivetos/infra workspace package.')
    console.error('   This command is only available from a RivetOS source checkout.')
    console.error(`   (${(err as Error).message})`)
    process.exit(1)
  }

  const dataDir = getDataDir()
  const orchestrator = new InfraOrchestrator({
    configPath: resolve(dataDir, 'config.yaml'),
    envPath: resolve(dataDir, '.env'),
    sourceDir: ROOT,
    dataDir,
  })

  switch (subcommand) {
    case 'up': {
      console.log('🔩 Deploying RivetOS infrastructure...\n')
      try {
        await orchestrator.up()
        console.log('\n✅ Infrastructure deployed.')
        console.log('   Run: rivetos infra status  — to check health')
      } catch (err: unknown) {
        console.error(`\n❌ Deployment failed: ${(err as Error).message}`)
        process.exit(1)
      }
      break
    }

    case 'preview': {
      console.log('🔩 Infrastructure Preview\n')
      try {
        const preview = await orchestrator.preview()
        console.log(preview)
      } catch (err: unknown) {
        console.error(`❌ Preview failed: ${(err as Error).message}`)
        process.exit(1)
      }
      break
    }

    case 'destroy': {
      console.log('🔩 Tearing down RivetOS infrastructure...\n')
      try {
        await orchestrator.destroy()
        console.log('\n✅ Infrastructure destroyed.')
      } catch (err: unknown) {
        console.error(`❌ Destroy failed: ${(err as Error).message}`)
        process.exit(1)
      }
      break
    }

    case 'status': {
      try {
        const status = await orchestrator.status()
        console.log(`Infrastructure: ${status.provider}\n`)

        if (status.network) {
          console.log(`Network: ${status.network.name} (${status.network.status})`)
        }

        if (status.datahub) {
          console.log(
            `Datahub: ${status.datahub.host}:${status.datahub.port} (${status.datahub.status})`,
          )
        }

        if (status.agents.length > 0) {
          console.log('\nAgents:')
          for (const agent of status.agents) {
            console.log(`  ${agent.name}: ${agent.status}${agent.ip ? ` (${agent.ip})` : ''}`)
          }
        } else {
          console.log('\nNo agents deployed.')
        }
      } catch (err: unknown) {
        console.error(`❌ Status check failed: ${(err as Error).message}`)
        process.exit(1)
      }
      break
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      console.log('Run: rivetos infra help')
      process.exit(1)
  }
}
