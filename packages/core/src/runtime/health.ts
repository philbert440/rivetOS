/**
 * Health Endpoint — HTTP server exposing runtime health.
 *
 * GET /health      → full health check with metrics, providers, channels
 * GET /health/live → simple liveness check (200 OK)
 *
 * Bind: RIVETOS_HEALTH_HOST (default 127.0.0.1) and RIVETOS_HEALTH_PORT (default 3100).
 */

import { createServer, type Server } from 'node:http'
import { metrics, type MetricsSnapshot } from './metrics.js'
import { logger } from '../logger.js'

const log = logger('Health')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  version: string
  uptime: number
  startedAt: string
  agents: string[]
  providers: Record<string, { available: boolean }>
  channels: Record<string, { connected: boolean }>
  memory: { connected: boolean }
  metrics: MetricsSnapshot
}

export interface HealthBind {
  host: string
  port: number
}

/** Loopback unless RIVETOS_HEALTH_HOST / RIVETOS_HEALTH_PORT override. */
export function resolveHealthBind(env: NodeJS.ProcessEnv = process.env): HealthBind {
  const parsed = parseInt(env.RIVETOS_HEALTH_PORT ?? '3100', 10)
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : 3100
  const host = env.RIVETOS_HEALTH_HOST?.trim() || '127.0.0.1'
  return { host, port }
}

export interface HealthConfig {
  port?: number
  host?: string
  /** Functions to check runtime health */
  getAgents: () => string[]
  checkProviders: () => Promise<Record<string, boolean>>
  getChannelStatus: () => Record<string, boolean>
  getMemoryStatus: () => boolean
  version?: string
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class HealthServer {
  private server: Server | null = null
  private config: HealthConfig
  private port: number
  private host: string

  constructor(config: HealthConfig) {
    this.config = config
    const bind = resolveHealthBind()
    this.port = config.port ?? bind.port
    this.host = config.host ?? bind.host
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req.url ?? '/', res)
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn(`Port ${this.port} in use, health endpoint disabled`)
          resolve() // Don't fail startup over health port
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, this.host, () => {
        log.info(`Health endpoint on ${this.host}:${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  private async handleRequest(url: string, res: import('node:http').ServerResponse): Promise<void> {
    try {
      if (url === '/health/live') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }

      if (url === '/health' || url === '/health/') {
        const health = await this.buildHealthStatus()
        const statusCode =
          health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503
        res.writeHead(statusCode, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(health, null, 2))
        return
      }

      if (url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(metrics.getSnapshot(), null, 2))
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    } catch (err: unknown) {
      log.error('Health check failed', err)
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Internal error' }))
    }
  }

  private async buildHealthStatus(): Promise<HealthStatus> {
    const providerHealth = await this.config.checkProviders()
    const channelStatus = this.config.getChannelStatus()
    const memoryConnected = this.config.getMemoryStatus()

    const providers: HealthStatus['providers'] = {}
    for (const [id, available] of Object.entries(providerHealth)) {
      providers[id] = { available }
    }

    const channels: HealthStatus['channels'] = {}
    for (const [id, connected] of Object.entries(channelStatus)) {
      channels[id] = { connected }
    }

    // Determine overall status
    const allProvidersDown = Object.values(providerHealth).every((v) => !v)
    const someProvidersDown = Object.values(providerHealth).some((v) => !v)
    const allChannelsDown = Object.values(channelStatus).every((v) => !v)

    let status: HealthStatus['status'] = 'healthy'
    if (allProvidersDown || allChannelsDown || !memoryConnected) {
      status = 'unhealthy'
    } else if (someProvidersDown) {
      status = 'degraded'
    }

    return {
      status,
      version: this.config.version ?? '0.5.0',
      uptime: metrics.getSnapshot().uptime,
      startedAt: metrics.getSnapshot().startedAt,
      agents: this.config.getAgents(),
      providers,
      channels,
      memory: { connected: memoryConnected },
      metrics: metrics.getSnapshot(),
    }
  }
}
