/**
 * Agent Channel Server — HTTP endpoint for receiving mesh delegations.
 *
 * This is the "receiver" side of cross-instance delegation. When a remote
 * MeshDelegationEngine sends a task to this node, it hits POST /api/message.
 * We route it through the local DelegationEngine as if a local agent asked.
 *
 * Endpoints:
 *   GET  /api/mesh/ping — unauthenticated liveness probe (returns { status, node })
 *   POST /api/message   — receive a delegated task, execute locally, return result
 *   GET  /api/mesh      — return current mesh registry (for seed sync)
 *   GET  /api/agents    — list agents on this node
 *
 * Auth: Bearer token in Authorization header, matched against mesh.secret.
 *       Exception: /api/mesh/ping is unauthenticated (liveness only, no sensitive data).
 */

import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DelegationEngine } from '../domain/delegation.js'
import type { MeshRegistry } from '@rivetos/types'
import type { Router } from '../domain/router.js'
import { logger } from '../logger.js'

const log = logger('AgentChannel')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentChannelConfig {
  /** Port to listen on (default: 3000) */
  port?: number

  /** Shared secret for authentication */
  secret: string

  /** Local delegation engine — used to execute received tasks */
  delegationEngine: DelegationEngine

  /** Mesh registry — served on GET /api/mesh for seed sync */
  meshRegistry?: MeshRegistry

  /** Router — for listing available agents */
  router: Router

  /** Local agent IDs */
  localAgents: string[]
}

// ---------------------------------------------------------------------------
// Request/Response types
// ---------------------------------------------------------------------------

interface MessageRequest {
  fromAgent: string
  message: string
  waitForResponse?: boolean
  timeoutMs?: number
}

interface MessageResponse {
  response: string
  agent: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class AgentChannelServer {
  private server: Server | null = null
  private config: AgentChannelConfig
  private port: number

  constructor(config: AgentChannelConfig) {
    this.config = config
    this.port = config.port ?? parseInt(process.env.RIVETOS_AGENT_PORT ?? '3000', 10)
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn(`Port ${this.port} in use, agent channel disabled`)
          resolve() // Don't fail startup
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, () => {
        log.info(`Agent channel listening on :${this.port}`)
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

  // -----------------------------------------------------------------------
  // Request handling
  // -----------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      // Unauthenticated liveness probe — must come before auth check
      if (method === 'GET' && url === '/api/mesh/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', node: this.config.localAgents[0] ?? 'unknown' }))
        return
      }

      // Auth check for all other endpoints
      if (!this.authenticate(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      if (method === 'POST' && url === '/api/message') {
        await this.handleMessage(req, res)
        return
      }

      if (method === 'GET' && url === '/api/mesh') {
        await this.handleMeshGet(res)
        return
      }

      if (method === 'GET' && url === '/api/agents') {
        this.handleAgentsList(res)
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err: unknown) {
      log.error('Agent channel request failed', err as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal error' }))
    }
  }

  // -----------------------------------------------------------------------
  // POST /api/message — receive and execute a delegated task
  // -----------------------------------------------------------------------

  private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }

    const { fromAgent, message, timeoutMs } = body as unknown as MessageRequest

    if (!fromAgent || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing fromAgent or message' }))
      return
    }

    // Extract target agent from the message or default to first local agent
    // The mesh delegation engine sets the message as "[Mesh delegation] <task>"
    // We route to the default/first agent on this node
    const targetAgent = this.config.localAgents[0]
    if (!targetAgent) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No agents available on this node' }))
      return
    }

    log.info(
      `Received mesh delegation from ${fromAgent} → ${targetAgent}: ${message.slice(0, 100)}...`,
    )

    const startTime = Date.now()

    try {
      // Use the local delegation engine to handle the task
      const result = await this.config.delegationEngine.delegate(
        {
          fromAgent,
          toAgent: targetAgent,
          task: message.replace(/^\[Mesh delegation\]\s*/, ''),
          timeoutMs: timeoutMs ?? 120_000,
        },
        0, // chainDepth 0 — fresh chain on the remote side
      )

      const response: MessageResponse = {
        response: result.response,
        agent: targetAgent,
        durationMs: Date.now() - startTime,
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`Delegation from ${fromAgent} failed: ${msg}`)

      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          response: `Delegation failed: ${msg}`,
          agent: targetAgent,
          durationMs: Date.now() - startTime,
        }),
      )
    }
  }

  // -----------------------------------------------------------------------
  // GET /api/mesh — return mesh registry for seed sync
  // -----------------------------------------------------------------------

  private async handleMeshGet(res: ServerResponse): Promise<void> {
    if (!this.config.meshRegistry) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Mesh not configured' }))
      return
    }

    const nodes = await this.config.meshRegistry.getNodes()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(nodes))
  }

  // -----------------------------------------------------------------------
  // GET /api/agents — list local agents
  // -----------------------------------------------------------------------

  private handleAgentsList(res: ServerResponse): void {
    const agents = this.config.router.getAgents().map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      model: a.model,
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ agents }))
  }

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  private authenticate(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization
    if (!authHeader) return false

    const token = authHeader.replace(/^Bearer\s+/i, '')
    return token === this.config.secret
  }

  // -----------------------------------------------------------------------
  // Body parsing
  // -----------------------------------------------------------------------

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8')
          resolve(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }
}
