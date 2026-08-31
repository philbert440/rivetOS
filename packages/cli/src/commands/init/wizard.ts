/**
 * Main wizard orchestrator — ties all phases together.
 */

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import { sharedPath } from '@rivetos/types'
import { parseUserHost } from '../../lib/mesh-enroll.js'
import { detectEnvironment } from './detect.js'
import { configureDeployment } from './deployment.js'
import { configureAgents } from './agents.js'
import { configureChannels } from './channels.js'
import { configurePostgres } from './postgres.js'
import { reviewConfig } from './review.js'
import { generateConfig, meshSectionFromEnroll } from './generate.js'
import { configureMeshJoin } from './mesh.js'
import { seedUsersJson } from './users.js'
import {
  interpretAnswers,
  loadAnswersFile,
  MissingAnswerError,
  type AnsweredInit,
} from './answers.js'
import type { WizardState } from './types.js'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

export interface InitOptions {
  /** Host to join an existing mesh (from --join flag) */
  joinHost?: string
  /** JSON file supplying every prompt answer (`rivetos init --answers-file`) */
  answersFile?: string
}

/** Mesh listener default. `rivetos init --join` pings this port, not standalone plugin 3100. */
export const INIT_MESH_JOIN_PORT = 3000

export async function runInitWizard(options: InitOptions = {}): Promise<void> {
  if (options.answersFile) {
    await runInitFromAnswersFile(options)
    return
  }

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
        p.outro(
          '🔩 Deploy when ready with `docker compose -f infra/docker/rivetos/docker-compose.yml up -d` or your preferred runner.',
        )
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

  const rivetDir = resolve(homedir(), '.rivetos')

  // Phase 2: Deployment target
  const { target } = await configureDeployment(env)

  // Phase 3: Agent configuration
  p.log.step('Agent Configuration')
  const agents = await configureAgents()

  // Phase 3b: Join a RivetHub mesh (after provider setup)
  const meshJoin = await configureMeshJoin()

  // Phase 4: Channel configuration
  p.log.step('Channel Configuration')
  const channels = await configureChannels()

  // Generate a random postgres password (used for the bundled datahub on
  // docker/proxmox deployments; ignored on manual where the user supplies a URL)
  const postgresPassword = randomBytes(16).toString('hex')

  // Phase 4b: Postgres connection — manual deployments BYO postgres
  let postgresUrl: string | undefined
  if (target === 'manual') {
    postgresUrl = await configurePostgres()
  }

  const ownerId = await promptOwnerId()

  // Build full state
  const state: WizardState = {
    deployment: target,
    agents,
    channels,
    postgresPassword,
    postgresUrl,
    ownerId,
    meshJoin,
  }

  // Phase 5: Review
  const confirmed = await reviewConfig(state)
  if (!confirmed) {
    p.cancel('Setup cancelled. Run npx rivetos init again to start over.')
    process.exit(0)
  }

  // Phase 6: Enroll (if joining a RivetHub mesh) then generate files
  await enrollMeshIfRequested(state, { interactive: true })

  const s = p.spinner()
  s.start('Generating configuration...')

  const result = await generateConfig(state, rivetDir)
  const users = await seedUsersJson(state.ownerId)

  s.stop('Configuration generated.')

  p.log.success(`Config:     ${result.configPath}`)
  p.log.success(`Secrets:    ${result.envPath}`)
  p.log.success(`Workspace:  ${result.workspacePath}`)
  if (users.written) {
    p.log.success(`Users:      ${users.path}`)
  } else {
    p.log.info(`Users:      ${users.path} (already exists, left in place)`)
  }

  // Phase 7: Deploy (optional, for containerized targets)
  let deploySuccess = false
  if (target === 'docker') {
    deploySuccess = await offerDockerDeploy(result.envPath)
  } else if (target === 'proxmox') {
    p.log.info('To provision a Proxmox container, run infra/scripts/provision-ct.sh')
  }

  // Phase 8: Mesh join (if --join was specified)
  if (options.joinHost) {
    p.log.step('Joining Mesh')
    const s2 = p.spinner()
    s2.start(`Joining mesh via ${options.joinHost}...`)

    try {
      const port = INIT_MESH_JOIN_PORT

      // Ping seed first — try mTLS, fall back to plain HTTPS (certs may not exist yet at init time)
      let pingRes: Response
      try {
        const { readFileSync: rfs } = await import('node:fs')
        const { Agent: UndiciAgent } = await import('undici')
        const nodeName = options.joinHost.split('.')[0]
        const ca = rfs(sharedPath('rivet-ca', 'intermediate', 'ca-chain.pem'))
        const cert = rfs(sharedPath('rivet-ca', 'issued', `${nodeName}.crt`))
        const key = rfs(sharedPath('rivet-ca', 'issued', `${nodeName}.key`))
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
    nextSteps.push(
      'docker compose -f infra/docker/rivetos/docker-compose.yml up -d   Deploy containers',
    )
  } else if (target === 'manual') {
    nextSteps.push('npx rivetos start                 Start the runtime')
    nextSteps.push('')
    nextSteps.push(
      'To run as a systemd service, drop this unit at /etc/systemd/system/rivetos.service:',
    )
    nextSteps.push('')
    nextSteps.push('  [Unit]')
    nextSteps.push('  Description=RivetOS Agent Runtime')
    nextSteps.push('  After=network-online.target')
    nextSteps.push('  Wants=network-online.target')
    nextSteps.push('')
    nextSteps.push('  [Service]')
    nextSteps.push(`  User=${process.env.USER ?? 'rivet'}`)
    nextSteps.push(`  EnvironmentFile=${result.envPath}`)
    nextSteps.push('  ExecStart=/usr/bin/env npx rivetos start')
    nextSteps.push('  Restart=on-failure')
    nextSteps.push('  RestartSec=5')
    nextSteps.push('')
    nextSteps.push('  [Install]')
    nextSteps.push('  WantedBy=multi-user.target')
    nextSteps.push('')
    nextSteps.push('Then: systemctl daemon-reload && systemctl enable --now rivetos')
  }

  nextSteps.push(
    'npx rivetos doctor                Verify connectivity',
    'npx rivetos status                Check runtime status',
  )

  if (options.joinHost || state.meshJoin) {
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

async function promptOwnerId(): Promise<string> {
  const ownerResult = await p.text({
    message: 'Owner user id',
    placeholder: 'owner',
    defaultValue: 'owner',
    validate: (val) => {
      if (!val || !val.trim()) return 'Owner id is required'
      return undefined
    },
  })
  bail(ownerResult)
  return ownerResult.trim()
}

async function enrollMeshIfRequested(
  state: WizardState,
  opts: { interactive: boolean },
): Promise<void> {
  if (!state.meshJoin) return
  const uh = parseUserHost(state.meshJoin.hub)
  const spinner = opts.interactive ? p.spinner() : undefined
  spinner?.start(`Enrolling ${state.meshJoin.name} via ${state.meshJoin.hub}...`)
  try {
    const { runMeshEnroll } = await import('../mesh.js')
    const { unpacked, advertise } = await runMeshEnroll({
      user: uh.user,
      host: uh.host,
      name: state.meshJoin.name,
      advertise: state.meshJoin.advertise,
    })
    state.meshSection = meshSectionFromEnroll(unpacked, advertise)
    spinner?.stop(`Enrolled ${state.meshJoin.name} (advertise ${advertise}).`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    spinner?.stop('Mesh enroll failed.')
    if (opts.interactive) {
      p.log.error(message)
    } else {
      console.error(`mesh enroll failed: ${message}`)
    }
    process.exit(1)
  }
}

async function runInitFromAnswersFile(options: InitOptions): Promise<void> {
  const answersPath = options.answersFile
  if (!answersPath) return

  let answers: Record<string, unknown>
  try {
    answers = await loadAnswersFile(answersPath)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
    return
  }

  const env = await detectEnvironment({ quiet: true })

  let interpreted: AnsweredInit
  try {
    interpreted = interpretAnswers(answers, env)
  } catch (err) {
    const message =
      err instanceof MissingAnswerError || err instanceof Error ? err.message : String(err)
    console.error(message)
    process.exit(1)
    return
  }

  if (env.configExists) {
    const action = interpreted.existingAction
    if (action === 'cancel') {
      console.error('Setup cancelled.')
      process.exit(0)
    }
    if (action === 'validate') {
      try {
        const doctor = await import('../doctor.js')
        await doctor.default()
      } catch {
        console.error('Run: npx rivetos doctor')
      }
      process.exit(0)
    }
    if (action === 'deploy') {
      const rivetDir = resolve(homedir(), '.rivetos')
      const envPath = resolve(rivetDir, '.env')
      const deploySuccess = await offerDockerDeploy(envPath, interpreted.deployNow ?? true)
      if (deploySuccess) {
        console.log('RivetOS is running.')
      } else {
        console.log('Deploy skipped or failed.')
      }
      process.exit(0)
    }
    if (action === 'overwrite' && !interpreted.overwriteConfirm) {
      console.error('Setup cancelled (overwriteConfirm is false).')
      process.exit(0)
    }
  }

  if (!interpreted.confirm) {
    console.error('Setup cancelled.')
    process.exit(0)
  }

  const rivetDir = resolve(homedir(), '.rivetos')
  const postgresPassword = randomBytes(16).toString('hex')
  const state: WizardState = {
    deployment: interpreted.deployment,
    agents: interpreted.agents,
    channels: [],
    postgresPassword,
    postgresUrl: interpreted.postgresUrl,
    ownerId: interpreted.ownerId,
    meshJoin: interpreted.meshJoin,
  }

  await enrollMeshIfRequested(state, { interactive: false })

  const result = await generateConfig(state, rivetDir)
  const users = await seedUsersJson(state.ownerId)

  console.log(`Config:     ${result.configPath}`)
  console.log(`Secrets:    ${result.envPath}`)
  console.log(`Workspace:  ${result.workspacePath}`)
  console.log(`Users:      ${users.path}${users.written ? '' : ' (already exists, left in place)'}`)

  let deploySuccess = false
  if (interpreted.deployment === 'docker') {
    deploySuccess = await offerDockerDeploy(result.envPath, interpreted.deployNow)
  } else if (interpreted.deployment === 'proxmox') {
    console.log('To provision a Proxmox container, run infra/scripts/provision-ct.sh')
  }

  if (options.joinHost) {
    await legacyMeshJoinPing(options.joinHost, { interactive: false })
  }

  if (interpreted.deployment === 'docker' && deploySuccess) {
    console.log('RivetOS is running.')
  } else {
    console.log('RivetOS is ready.')
  }
}

async function legacyMeshJoinPing(joinHost: string, opts: { interactive: boolean }): Promise<void> {
  const port = INIT_MESH_JOIN_PORT
  const log = (msg: string) => {
    if (opts.interactive) p.log.info(msg)
    else console.log(msg)
  }
  const warn = (msg: string) => {
    if (opts.interactive) p.log.warn(msg)
    else console.error(msg)
  }
  try {
    let pingRes: Response
    try {
      const { readFileSync: rfs } = await import('node:fs')
      const { Agent: UndiciAgent } = await import('undici')
      const nodeName = joinHost.split('.')[0]
      const ca = rfs(sharedPath('rivet-ca', 'intermediate', 'ca-chain.pem'))
      const cert = rfs(sharedPath('rivet-ca', 'issued', `${nodeName}.crt`))
      const key = rfs(sharedPath('rivet-ca', 'issued', `${nodeName}.key`))
      const dispatcher = new UndiciAgent({ connect: { ca, cert, key, rejectUnauthorized: true } })
      pingRes = await fetch(`https://${joinHost}:${String(port)}/api/mesh/ping`, {
        // @ts-expect-error — undici dispatcher not in Node fetch types
        dispatcher,
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      pingRes = await fetch(`https://${joinHost}:${String(port)}/api/mesh/ping`, {
        signal: AbortSignal.timeout(5000),
      })
    }
    if (!pingRes.ok) {
      warn(
        `Seed node responded with HTTP ${String(pingRes.status)}. You can join later with: npx rivetos mesh join ${joinHost}`,
      )
    } else {
      log(`Mesh: connected to ${joinHost}`)
    }
  } catch (err: unknown) {
    warn(`Could not reach seed node: ${(err as Error).message}`)
    log(`You can join later with: npx rivetos mesh join ${joinHost}`)
  }
}

async function offerDockerDeploy(envPath: string, preanswered?: boolean): Promise<boolean> {
  let deploy: boolean
  if (preanswered === undefined) {
    const asked = await p.confirm({
      message: 'Deploy now with Docker Compose?',
      initialValue: true,
    })
    bail(asked)
    deploy = asked
  } else {
    deploy = preanswered
  }

  const composeFlags = '-f infra/docker/rivetos/docker-compose.yml'

  if (!deploy) {
    p.log.info(`To deploy later, run: docker compose ${composeFlags} up -d`)
    return false
  }

  const s = p.spinner()
  s.start('Starting containers...')

  try {
    const { execSync } = await import('node:child_process')
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dirname may be undefined in older Node
    const root = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..')

    execSync(`docker compose ${composeFlags} up -d`, {
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

    try {
      execSync(`docker compose ${composeFlags} ps --format json`, {
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
    p.log.info(`Try running manually: docker compose ${composeFlags} up -d`)
    return false
  }
}
