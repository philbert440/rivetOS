/**
 * Infrastructure orchestrator — reads rivet.config.yaml and drives
 * the appropriate provider to create the full stack.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { DockerProvider } from './providers/docker/index.js'
import { ProxmoxProvider } from './providers/proxmox/index.js'
import type { InfraProvider, InfraStatus } from './components/types.js'
import type { ProxmoxProviderConfig } from './providers/proxmox/index.js'

// ──────────────────────────────────────────────────────────────────────────────
// Config types (matching rivet.config.yaml deployment section)
// ──────────────────────────────────────────────────────────────────────────────

interface RivetConfig {
  agents?: Record<string, { provider?: string; default_thinking?: string }>
  providers?: Record<string, { model?: string; base_url?: string }>
  deployment?: {
    target?: string
    datahub?: {
      postgres?: boolean
      shared_storage?: boolean
      shared_mount_path?: string
    }
    image?: {
      build_from_source?: boolean
      registry?: string
      tag?: string
    }
    docker?: {
      network?: string
      postgres_port?: number
    }
    proxmox?: {
      api_url?: string
      nodes?: Array<{ name: string; host: string; role: string }>
      network?: { bridge?: string; subnet?: string; gateway?: string }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ──────────────────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  /** Path to rivet.config.yaml */
  configPath: string

  /** Path to .env file */
  envPath: string

  /** RivetOS source directory (for building from source) */
  sourceDir: string

  /** Data directory (e.g., ~/.rivetos) */
  dataDir: string
}

export class InfraOrchestrator {
  private config!: RivetConfig
  private provider!: InfraProvider
  private opts: OrchestratorOptions

  constructor(opts: OrchestratorOptions) {
    this.opts = opts
  }

  async load(): Promise<void> {
    const raw = await readFile(this.opts.configPath, 'utf-8')
    this.config = parseYaml(raw) as RivetConfig

    if (!this.config.deployment?.target) {
      throw new Error('No deployment target configured. Run: rivetos init')
    }

    this.provider = this.createProvider()
  }

  async up(): Promise<void> {
    await this.load()

    const env = await this.loadEnv()
    const buildFromSource = this.config.deployment?.image?.build_from_source !== false

    // 1. Network
    const networkName = this.config.deployment?.docker?.network ?? 'rivetos-net'
    await this.provider.createNetwork({ name: networkName })

    // 2. Datahub
    const datahub = await this.provider.createDatahub({
      user: env.POSTGRES_USER ?? 'rivetos',
      password: env.POSTGRES_PASSWORD ?? 'rivetos',
      database: env.POSTGRES_DB ?? 'rivetos',
      exposePort: this.config.deployment?.docker?.postgres_port ?? 5432,
      sourceDir: buildFromSource ? this.opts.sourceDir : undefined,
    })

    // 3. Agents
    const agents = this.config.agents ?? {}
    for (const [name] of Object.entries(agents)) {
      await this.provider.createAgent({
        name,
        provider: agents[name].provider ?? 'unknown',
        model: this.getModel(agents[name].provider ?? ''),
        configPath: this.opts.configPath,
        envPath: this.opts.envPath,
        workspacePath: resolve(this.opts.dataDir, 'workspace'),
        datahub: {
          host: datahub.host,
          port: datahub.port,
          database: env.POSTGRES_DB ?? 'rivetos',
        },
        sharedMountPath: this.config.deployment?.datahub?.shared_mount_path ?? '/rivet-shared',
        sourceDir: buildFromSource ? this.opts.sourceDir : undefined,
      })
    }

    // 4. Deploy
    if (this.provider instanceof DockerProvider) {
      await this.provider.deploy()
    } else if (this.provider instanceof ProxmoxProvider) {
      await this.provider.deploy()
    }
  }

  async preview(): Promise<string> {
    await this.load()

    // Build same resources as up() but don't deploy
    const env = await this.loadEnv()
    const buildFromSource = this.config.deployment?.image?.build_from_source !== false
    const networkName = this.config.deployment?.docker?.network ?? 'rivetos-net'

    await this.provider.createNetwork({ name: networkName })

    const datahub = await this.provider.createDatahub({
      user: env.POSTGRES_USER ?? 'rivetos',
      password: env.POSTGRES_PASSWORD ?? 'rivetos',
      database: env.POSTGRES_DB ?? 'rivetos',
      exposePort: this.config.deployment?.docker?.postgres_port ?? 5432,
      sourceDir: buildFromSource ? this.opts.sourceDir : undefined,
    })

    const agents = this.config.agents ?? {}
    for (const [name] of Object.entries(agents)) {
      await this.provider.createAgent({
        name,
        provider: agents[name].provider ?? 'unknown',
        model: this.getModel(agents[name].provider ?? ''),
        configPath: this.opts.configPath,
        envPath: this.opts.envPath,
        workspacePath: resolve(this.opts.dataDir, 'workspace'),
        datahub: {
          host: datahub.host,
          port: datahub.port,
          database: env.POSTGRES_DB ?? 'rivetos',
        },
        sharedMountPath: this.config.deployment?.datahub?.shared_mount_path ?? '/rivet-shared',
        sourceDir: buildFromSource ? this.opts.sourceDir : undefined,
      })
    }

    if (this.provider instanceof DockerProvider) {
      return this.provider.preview()
    } else if (this.provider instanceof ProxmoxProvider) {
      return this.provider.preview()
    }

    return 'No preview available for this provider.'
  }

  async destroy(): Promise<void> {
    await this.load()
    await this.provider.destroy()
  }

  async status(): Promise<InfraStatus> {
    await this.load()
    return this.provider.status()
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  private createProvider(): InfraProvider {
    const target = this.config.deployment!.target!

    switch (target) {
      case 'docker':
        return new DockerProvider(this.opts.dataDir, this.opts.sourceDir)

      case 'proxmox': {
        const pxConfig = this.config.deployment!.proxmox
        if (!pxConfig) {
          throw new Error('Proxmox deployment requires a "proxmox" section in deployment config')
        }

        const providerConfig: ProxmoxProviderConfig = {
          apiUrl: pxConfig.api_url ?? 'https://localhost:8006',
          nodes: (pxConfig.nodes ?? []).map((n) => ({
            name: n.name,
            host: n.host,
            role: n.role as 'datahub' | 'agents' | 'both',
          })),
          network: {
            bridge: pxConfig.network?.bridge ?? 'vmbr0',
            subnet: pxConfig.network?.subnet ?? '10.0.0.0/24',
            gateway: pxConfig.network?.gateway ?? '10.0.0.1',
          },
        }

        return new ProxmoxProvider(providerConfig, resolve(this.opts.dataDir, 'infra'))
      }

      case 'manual':
        throw new Error(
          'Manual deployment does not use infrastructure commands. Use: rivetos start',
        )

      default:
        throw new Error(`Unknown deployment target: ${target}`)
    }
  }

  private getModel(providerName: string): string {
    return this.config.providers?.[providerName]?.model ?? 'default'
  }

  private async loadEnv(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = {}
    try {
      const raw = await readFile(this.opts.envPath, 'utf-8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
        }
      }
    } catch {
      // No .env file
    }
    return env
  }
}
