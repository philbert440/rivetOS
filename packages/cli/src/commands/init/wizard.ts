/**
 * Main wizard orchestrator — ties all phases together.
 */

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import { detectEnvironment } from './detect.js'
import { configureDeployment } from './deployment.js'
import { configureAgents } from './agents.js'
import { configureChannels } from './channels.js'
import { reviewConfig } from './review.js'
import { generateConfig, loadWizardState, clearWizardState } from './generate.js'
import type { WizardState } from './types.js'

function bail(v: unknown): asserts v is Exclude<typeof v, symbol> {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

export interface InitOptions {
  /** Host to join an existing mesh (from --join flag) */
  joinHost?: string
}

export async function runInitWizard(options: InitOptions = {}): Promise<void> {
  p.intro(options.joinHost ? '🔩 RivetOS Setup (joining mesh)' : '🔩 RivetOS Setup')

  // Phase 1: Environment detection
  const env = await detectEnvironment()

  // Check for existing config
  if (env.configExists) {
    const action = await p.select({
      message: 'An existing configuration was found.',
      options: [
        { value: 'deploy', label: 'Deploy existing config', hint: 'build + start containers' },
        { value: 'reconfigure', label: 'Reconfigure', hint: 'walk through setup again' },
        { value: 'validate', label: 'Validate & diagnose', hint: 'run doctor checks' },
        { value: 'overwrite', label: 'Start fresh', hint: 'delete and start over' },
        { value: 'cancel', label: 'Cancel' },
      ],
    })
    bail(action)

    if (action === 'cancel') {
      p.cancel('Setup cancelled.')
      process.exit(0)
    }

    if (action === 'validate') {
      p.log.step('Running diagnostics...')
      try {
        const doctor = await import('../doctor.js')
        await doctor.default()
      } catch {
        p.log.info('Run: npx rivetos doctor')
      }
      process.exit(0)
    }

    if (action === 'deploy') {
      // Skip wizard, go straight to deploy
      const rivetDir = resolve(homedir(), '.rivetos')
      const envPath = resolve(rivetDir, '.env')

      p.log.step('Deploying existing configuration...')
      const deploySuccess = await offerDockerDeploy(envPath)

      const nextSteps = [
        'npx rivetos doctor                Verify connectivity',
        'npx rivetos status                Check runtime status',
      ]
      p.note(nextSteps.join('\n'), 'Next Steps')

      if (deploySuccess) {
        p.outro('🔩 RivetOS is running!')
      } else {
        p.outro('🔩 Deploy when ready: npx rivetos infra up')
      }
      process.exit(0)
    }

    if (action === 'overwrite') {
      const confirm = await p.confirm({
        message: 'This will delete your existing config. Are you sure?',
        initialValue: false,
      })
      bail(confirm)
      if (!confirm) {
        p.cancel('Setup cancelled.')
        process.exit(0)
      }
    }

    // 'reconfigure' and confirmed 'overwrite' both fall through to the wizard
  }

  // Check for partial state from a previous interrupted run
  const rivetDir = resolve(homedir(), '.rivetos')
  const savedState = await loadWizardState(rivetDir)
  if (savedState?.deployment) {
    const resume = await p.confirm({
      message: 'Found a previous incomplete setup. Continue where you left off?',
      initialValue: true,
    })
    bail(resume)
    if (!resume) {
      await clearWizardState(rivetDir)
    }
  }

  // Phase 2: Deployment target
  const { target, proxmox } = await configureDeployment(env)

  // Phase 3: Agent configuration
  p.log.step('Agent Configuration')
  const agents = await configureAgents()

  // Phase 4: Channel configuration
  p.log.step('Channel Configuration')
  const channels = await configureChannels()

  // Generate a random postgres password
  const postgresPassword = randomBytes(16).toString('hex')

  // Build full state
  const state: WizardState = {
    deployment: target,
    agents,
    channels,
    proxmox,
    postgresPassword,
  }

  // Phase 5: Review
  const confirmed = await reviewConfig(state)
  if (!confirmed) {
    p.cancel('Setup cancelled. Run npx rivetos init again to start over.')
    process.exit(0)
  }

  // Phase 6: Generate files
  const s = p.spinner()
  s.start('Generating configuration...')

  const result = await generateConfig(state, rivetDir)
  await clearWizardState(rivetDir)

  s.stop('Configuration generated.')

  p.log.success(`Config:     ${result.configPath}`)
  p.log.success(`Secrets:    ${result.envPath}`)
  p.log.success(`Workspace:  ${result.workspacePath}`)

  // Phase 7: Deploy (optional, for containerized targets)
  let deploySuccess = false
  if (target === 'docker') {
    deploySuccess = await offerDockerDeploy(result.envPath)
  } else if (target === 'proxmox') {
    p.log.info('To deploy to Proxmox, run: npx rivetos infra up')
  }

  // Phase 8: Mesh join (if --join was specified)
  if (options.joinHost) {
    p.log.step('Joining Mesh')
    const s2 = p.spinner()
    s2.start(`Joining mesh via ${options.joinHost}...`)

    try {
      const port = 3100

      // Ping seed first — try mTLS, fall back to plain HTTPS (certs may not exist yet at init time)
      let pingRes: Response
      try {
        const { readFileSync: rfs } = await import('node:fs')
        const { Agent: UndiciAgent } = await import('undici')
        const nodeName = options.joinHost.split('.')[0]
        const ca = rfs('/rivet-shared/rivet-ca/intermediate/ca-chain.pem')
        const cert = rfs(`/rivet-shared/rivet-ca/issued/${nodeName}.crt`)
        const key = rfs(`/rivet-shared/rivet-ca/issued/${nodeName}.key`)
        const dispatcher = new UndiciAgent({ connect: { ca, cert, key, rejectUnauthorized: true } })
        pingRes = await fetch(`https://${options.joinHost}:${String(port)}/api/mesh/ping`, {
          // @ts-expect-error — undici dispatcher not in Node fetch types
          dispatcher,
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        // Certs not available yet at init time — try plain HTTPS (server may reject without client cert)
        pingRes = await fetch(`https://${options.joinHost}:${String(port)}/api/mesh/ping`, {
          signal: AbortSignal.timeout(5000),
        })
      }

      if (!pingRes.ok) {
        s2.stop('Mesh join failed.')
        p.log.warn(
          `Seed node responded with HTTP ${String(pingRes.status)}. You can join later with: npx rivetos mesh join ${options.joinHost}`,
        )
      } else {
        s2.stop('Connected to mesh seed node.')
        p.log.success(`Mesh: connected to ${options.joinHost}`)
        p.log.info('The mesh will fully activate when you start the runtime.')
      }
    } catch (err: unknown) {
      s2.stop('Mesh join failed.')
      p.log.warn(`Could not reach seed node: ${(err as Error).message}`)
      p.log.info(`You can join later with: npx rivetos mesh join ${options.joinHost}`)
    }
  }

  // Next steps
  const nextSteps: string[] = []

  if (target === 'docker' && !deploySuccess) {
    nextSteps.push('npx rivetos infra up              Deploy containers')
  } else if (target === 'manual') {
    nextSteps.push('npx rivetos start                 Start the runtime')
  }

  nextSteps.push(
    'npx rivetos doctor                Verify connectivity',
    'npx rivetos status                Check runtime status',
  )

  if (options.joinHost) {
    nextSteps.push('npx rivetos mesh list              View mesh nodes')
  }

  nextSteps.push('', `Config:  ${result.configPath}`, `Secrets: ${result.envPath}`)

  p.note(nextSteps.join('\n'), 'Next Steps')

  if (target === 'docker' && deploySuccess) {
    p.outro('🔩 RivetOS is running!')
  } else {
    p.outro('🔩 RivetOS is ready.')
  }
}

async function offerDockerDeploy(envPath: string): Promise<boolean> {
  const deploy = await p.confirm({
    message: 'Deploy now with Docker Compose?',
    initialValue: true,
  })
  bail(deploy)

  if (!deploy) {
    p.log.info('To deploy later, run: npx rivetos infra up')
    return false
  }

  const s = p.spinner()
  s.start('Starting containers...')

  try {
    const { execSync } = await import('node:child_process')
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dirname may be undefined in older Node
    const root = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..')

    execSync('docker compose up -d', {
      cwd: root,
      encoding: 'utf-8',
      timeout: 120000,
      env: {
        ...process.env,
        RIVETOS_ENV_FILE: envPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    s.stop('Containers are running!')

    // Quick health check
    try {
      execSync('docker compose ps --format json', {
        cwd: root,
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      p.log.success('All containers are up.')
    } catch {
      p.log.warn('Containers started, but health check could not be verified.')
    }

    return true
  } catch (err: unknown) {
    s.stop('Deployment failed.')
    p.log.error(`Docker Compose error: ${(err as Error).message}`)
    p.log.info('Try running manually: docker compose up -d')
    return false
  }
}
