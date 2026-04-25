/**
 * Agent Channel Server — HTTPS/mTLS endpoint for receiving mesh delegations.
 *
 * This is the "receiver" side of cross-instance delegation. When a remote
 * MeshDelegationEngine sends a task to this node, it hits POST /api/message.
 * We route it through the local DelegationEngine as if a local agent asked.
 *
 * Endpoints:
 *   GET  /api/mesh/ping — liveness probe (TLS handshake required, no app-layer auth)
 *   POST /api/message   — receive a delegated task, execute locally, return result
 *   GET  /api/mesh      — return current mesh registry (for seed sync)
 *   GET  /api/agents    — list agents on this node
 *
 * Auth: Mutual TLS — peer must present a cert signed by our CA.
 *       rejectUnauthorized: true on the TLS server enforces this.
 *       No bearer token is checked; the TLS handshake is the auth.
 */

import { createServer, type Server } from 'node:https'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { DelegationEngine } from '../domain/delegation.js'
import type { MeshRegistry } from '@rivetos/types'
import type { Router } from '../domain/router.js'
import { logger } from '../logger.js'

const log = logger('AgentChannel')

/**
 * Extract peer identity from TLS client certificate.
 * Uses CN from subject (per spec: node certs only, CN = nodeName).
 */
export function extractPeerIdentity(socket: TLSSocket): string {
  const peerCert = socket.getPeerCertificate() as
    | { subject?: { CN?: string | string[] } }
    | undefined
  const rawCn = peerCert?.subject?.CN
  return Array.isArray(rawCn) ? (rawCn[0] ?? 'unknown') : (rawCn ?? 'unknown')
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentChannelTlsConfig {
  /** CA chain PEM for verifying peers */
  ca: Buffer
  /** This node's certificate PEM */
  cert: Buffer
  /** This node's private key PEM */
  key: Buffer
  /** This node's Common Name (extracted from cert, used for logging) */
  cn: string
}

export interface AgentChannelConfig {
  /** Port to listen on (default: 3000) */
  port?: number

  /**
   * Shared secret — DEPRECATED for agent-channel auth.
   * No longer used by AgentChannelServer. Kept in type for compat.
   * @deprecated Auth is now mutual TLS; this field is ignored.
   */
  secret?: string

  /** TLS configuration — required. Mesh = TLS, no plaintext fallback. */
  tls: AgentChannelTlsConfig

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
  chainDepth?: number
  /** Optional per-call model override forwarded from the remote caller. */
  model?: string
}

interface MessageResponse {
  response: string
  agent: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load TLS material for this node.
 * Resolves default cert paths from nodeName when tls:true.
 */
export function loadTlsConfig(
  tls: boolean | { caPath?: string; certPath?: string; keyPath?: string },
  nodeName: string,
): AgentChannelTlsConfig {
  const defaultCa = '/rivet-shared/rivet-ca/intermediate/ca-chain.pem'
  const defaultCert = `/rivet-shared/rivet-ca/issued/${nodeName}.crt`
  const defaultKey = `/rivet-shared/rivet-ca/issued/${nodeName}.key`

  const caPath = typeof tls === 'object' ? (tls.caPath ?? defaultCa) : defaultCa
  const certPath = typeof tls === 'object' ? (tls.certPath ?? defaultCert) : defaultCert
  const keyPath = typeof tls === 'object' ? (tls.keyPath ?? defaultKey) : defaultKey

  const readPem = (path: string, label: string): Buffer => {
    try {
      return readFileSync(path)
    } catch (err) {
      throw new Error(
        `mesh TLS configured but ${label} at ${path} not readable: ${(err as Error).message}`,
        { cause: err },
      )
    }
  }

  const ca = readPem(caPath, 'CA chain')
  const cert = readPem(certPath, 'node cert')
  const key = readPem(keyPath, 'node key')

  return { ca, cert, key, cn: nodeName }
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
      const { ca, cert, key, cn } = this.config.tls

      this.server = createServer(
        {
          ca,
          cert,
          key,
          requestCert: true,
          rejectUnauthorized: true,
        },
        (req, res) => {
          void this.handleRequest(req, res)
        },
      )

      this.server.on('tlsClientError', (err: Error, socket: TLSSocket) => {
        const remoteAddr = socket.remoteAddress ?? 'unknown'
        log.warn(`TLS handshake failed from ${remoteAddr}: ${err.message}`)
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
        log.info(`Agent channel listening on :${this.port} (TLS, CN=${cn})`)
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

    // Extract peer CN for logging
    const _peerCn = extractPeerIdentity(req.socket as TLSSocket)

    try {
      // Liveness probe — TLS handshake has already happened (rejectUnauthorized: true)
      if (method === 'GET' && url === '/api/mesh/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            tls: true,
            node: this.config.tls.cn,
          }),
        )
        return
      }

      const peerCn = extractPeerIdentity(req.socket as TLSSocket)
      log.debug(`Request ${method} ${url} from peer.cn=${peerCn}`)

      if (method === 'POST' && url === '/api/message') {
        await this.handleMessage(req, res, peerCn)
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
      log.error('Agent channel request failed', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal error' }))
    }
  }

  // -----------------------------------------------------------------------
  // POST /api/message — receive and execute a delegated task
  // -----------------------------------------------------------------------

  private async handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    _peerCn: string,
  ): Promise<void> {
    let body: Record<string, unknown> | null
    try {
      body = await this.readBody(req)
    } catch (err) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
      return
    }
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }

    const { fromAgent, message, timeoutMs, chainDepth, model } = body as unknown as MessageRequest

    if (!fromAgent || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing fromAgent or message' }))
      return
    }

    const targetAgent = this.config.localAgents[0]
    if (!targetAgent) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No agents available on this node' }))
      return
    }

    log.info(
      `Received mesh delegation peer.cn=${_peerCn} from ${fromAgent} → ${targetAgent}: ${message.slice(0, 100)}...`,
    )

    const startTime = Date.now()

    try {
      const result = await this.config.delegationEngine.delegate(
        {
          fromAgent,
          toAgent: targetAgent,
          task: message.replace(/^\[Mesh delegation\]\s*/, ''),
          timeoutMs: timeoutMs ?? 120_000,
          noDelegation: true,
          model,
        },
        chainDepth ?? 0,
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
      log.error(`Delegation from ${fromAgent} (peer.cn=${_peerCn}) failed: ${msg}`)

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
  // Body parsing
  // -----------------------------------------------------------------------

  private static readonly MAX_BODY_SIZE = 10 * 1024 * 1024 // 10 MB

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalBytes = 0
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > AgentChannelServer.MAX_BODY_SIZE) {
          req.destroy()
          reject(new Error('Request body exceeds 10 MB limit'))
          return
        }
        chunks.push(chunk)
      })
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
