/**
 * Docker infrastructure provider.
 *
 * Uses Docker Compose under the hood. Generates a docker-compose.yml
 * from the abstract component args, then runs compose commands.
 *
 * This is the "works anywhere" provider — no Proxmox, no K8s, just Docker.
 */

import { execSync } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stringify as toYaml } from 'yaml'
import type {
  InfraProvider,
  InfraStatus,
  NetworkComponentArgs,
  NetworkComponentOutputs,
  DatahubComponentArgs,
  DatahubComponentOutputs,
  AgentComponentArgs,
  AgentComponentOutputs,
} from '../../components/types.js'

interface ComposeService {
  image?: string
  build?: { context: string; dockerfile: string }
  container_name?: string
  environment?: Record<string, string>
  env_file?: string[]
  volumes?: string[]
  ports?: string[]
  networks?: string[]
  depends_on?: Record<string, { condition: string }>
  restart?: string
  healthcheck?: {
    test: string[]
    interval: string
    timeout: string
    retries: number
    start_period?: string
  }
}

interface ComposeFile {
  services: Record<string, ComposeService>
  volumes: Record<string, { name: string }>
  networks: Record<string, { name: string; driver: string }>
}

export class DockerProvider implements InfraProvider {
  readonly name = 'docker'

  private compose: ComposeFile = {
    services: {},
    volumes: {},
    networks: {},
  }

  private projectDir: string
  private sourceDir: string

  constructor(
    /** Directory where compose file and state are stored (e.g., ~/.rivetos) */
    projectDir: string,
    /** Root of the RivetOS source tree */
    sourceDir: string,
  ) {
    this.projectDir = projectDir
    this.sourceDir = sourceDir
  }

  createNetwork(args: NetworkComponentArgs): Promise<NetworkComponentOutputs> {
    this.compose.networks[args.name] = {
      name: args.name,
      driver: 'bridge',
    }

    return Promise.resolve({ id: args.name, name: args.name })
  }

  createDatahub(args: DatahubComponentArgs): Promise<DatahubComponentOutputs> {
    const service: ComposeService = {
      container_name: 'rivetos-datahub',
      environment: {
        POSTGRES_USER: args.user,
        POSTGRES_PASSWORD: args.password,
        POSTGRES_DB: args.database,
      },
      volumes: ['rivetos-pgdata:/var/lib/postgresql/data', 'rivetos-shared:/shared'],
      ports: args.exposePort ? [`${args.exposePort}:5432`] : [],
      networks: Object.keys(this.compose.networks),
      restart: 'unless-stopped',
      healthcheck: {
        test: ['CMD-SHELL', `pg_isready -U ${args.user}`],
        interval: '5s',
        timeout: '3s',
        retries: 5,
      },
    }

    if (args.sourceDir) {
      service.build = {
        context: resolve(this.sourceDir, 'containers', 'datahub'),
        dockerfile: 'Dockerfile',
      }
    } else {
      service.image = args.image ?? `rivetos-datahub:latest`
    }

    this.compose.services['datahub'] = service
    this.compose.volumes['rivetos-pgdata'] = { name: 'rivetos-pgdata' }
    this.compose.volumes['rivetos-shared'] = { name: 'rivetos-shared' }

    return Promise.resolve({
      id: 'rivetos-datahub',
      host: 'datahub',
      port: 5432,
      connectionString: `postgresql://${args.user}:${args.password}@datahub:5432/${args.database}`,
      status: 'defined',
    })
  }

  createAgent(args: AgentComponentArgs): Promise<AgentComponentOutputs> {
    const containerName = `rivetos-${args.name}`

    const service: ComposeService = {
      container_name: containerName,
      env_file: [args.envPath],
      environment: {
        RIVETOS_PG_URL: `postgresql://${args.datahub.database}:${args.datahub.database}@${args.datahub.host}:${args.datahub.port}/${args.datahub.database}`,
        ...args.env,
      },
      volumes: [
        'rivetos-shared:/shared',
        `${args.configPath}:/home/rivetos/.rivetos/config.yaml:ro`,
        `${args.workspacePath}:/home/rivetos/.rivetos/workspace`,
      ],
      networks: Object.keys(this.compose.networks),
      depends_on: {
        datahub: { condition: 'service_healthy' },
      },
      restart: 'unless-stopped',
    }

    if (args.sourceDir) {
      service.build = {
        context: this.sourceDir,
        dockerfile: 'infra/containers/agent/Dockerfile',
      }
    } else {
      service.image = args.image ?? 'rivetos-agent:latest'
    }

    this.compose.services[args.name] = service

    return Promise.resolve({
      id: containerName,
      name: args.name,
      status: 'defined',
    })
  }

  /** Write the compose file and run `docker compose up -d` */
  async deploy(): Promise<void> {
    await this.writeComposeFile()
    this.exec('docker compose up -d --build')
  }

  /** Run `docker compose up -d` without rebuild */
  async start(): Promise<void> {
    await this.writeComposeFile()
    this.exec('docker compose up -d')
  }

  /** Preview what would be deployed (just writes the compose file) */
  preview(): Promise<string> {
    return Promise.resolve(this.toYaml())
  }

  destroy(): Promise<void> {
    this.exec('docker compose down -v')
    return Promise.resolve()
  }

  status(): Promise<InfraStatus> {
    const result: InfraStatus = {
      provider: 'docker',
      agents: [],
    }

    try {
      const output = this.exec('docker compose ps --format json', true)
      if (output) {
        const lines = output.trim().split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const container = JSON.parse(line) as { Name: string; State: string; Status: string }
            if (container.Name === 'rivetos-datahub') {
              result.datahub = {
                status: container.State,
                host: 'datahub',
                port: 5432,
              }
            } else if (container.Name.startsWith('rivetos-')) {
              result.agents.push({
                name: container.Name.replace('rivetos-', ''),
                status: container.State,
              })
            }
          } catch {
            /* skip unparseable lines */
          }
        }
      }
    } catch {
      // Compose not running
    }

    return Promise.resolve(result)
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────────────────────

  private toYaml(): string {
    const header = [
      '# RivetOS Docker Compose — generated by rivetos infra',
      '# Do not edit manually. Changes will be overwritten.',
      '# To customize: edit rivet.config.yaml and run rivetos infra up',
      '',
    ].join('\n')

    return header + toYaml(this.compose, { lineWidth: 120 })
  }

  private async writeComposeFile(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true })
    const composePath = resolve(this.projectDir, 'docker-compose.yml')
    await writeFile(composePath, this.toYaml(), 'utf-8')
  }

  private exec(cmd: string, capture = false): string {
    const opts = {
      cwd: this.projectDir,
      encoding: 'utf-8' as const,
      timeout: 300000,
      env: { ...process.env, COMPOSE_PROJECT_NAME: 'rivetos' },
      stdio: capture ? (['pipe', 'pipe', 'pipe'] as const) : ('inherit' as const),
    }

    if (capture) {
      return execSync(cmd, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    }

    execSync(cmd, { ...opts, stdio: 'inherit' })
    return ''
  }
}
