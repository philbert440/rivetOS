/**
 * @rivetos/channel-agent
 *
 * Agent-to-agent channel — exposes an HTTP endpoint for cross-instance
 * messaging. When an agent on another instance sends a message, it arrives
 * here and is processed through the full normal pipeline (memory, hooks,
 * tools, everything).
 *
 * Protocol:
 *   POST /api/message
 *   Headers: Authorization: Bearer <shared-secret>
 *   Body: { fromAgent: string, message: string, conversationId?: string, waitForResponse?: boolean }
 *   Response: { response: string, agent: string, timestamp: number }
 *
 * The channel also provides an `agent_message` tool for sending messages
 * to peer agents on other instances.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Channel, InboundMessage, OutboundMessage, Tool } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentChannelConfig {
  /** Port to listen on (default: 3100) */
  port?: number
  /** Bind address (default: 0.0.0.0) */
  host?: string
  /** Shared secret for authenticating peer agents */
  secret: string
  /** This agent's ID */
  agentId: string
  /** Peer agents: name → URL mapping */
  peers?: Record<string, PeerConfig>
}

export interface PeerConfig {
  /** Base URL of the peer agent (e.g., http://10.4.20.102:3100) */
  url: string
  /** Override secret for this specific peer (optional, defaults to channel secret) */
  secret?: string
}

// ---------------------------------------------------------------------------
// Channel Implementation
// ---------------------------------------------------------------------------

export class AgentChannel implements Channel {
  id: string
  platform = 'agent'

  private config: AgentChannelConfig
  private server?: Server
  private port: number
  private host: string
  private messageHandler?: (message: InboundMessage) => Promise<void>
  private commandHandler?: (command: string, args: string, message: InboundMessage) => Promise<void>

  /** Pending responses — maps request ID to response resolver */
  private pendingResponses: Map<
    string,
    {
      resolve: (response: string) => void
      timeout: ReturnType<typeof setTimeout>
    }
  > = new Map()

  constructor(config: AgentChannelConfig) {
    this.config = config
    this.id = `agent-${config.agentId}`
    this.port = config.port ?? 3100
    this.host = config.host ?? '0.0.0.0'
  }

  // -----------------------------------------------------------------------
  // Channel interface
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handleRequest(req, res))

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Agent channel port ${String(this.port)} is already in use`))
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, this.host, () => {
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    // Clear pending responses
    for (const [_id, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout)
      pending.resolve('[channel shutting down]')
    }
    this.pendingResponses.clear()

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  send(message: OutboundMessage): Promise<string | null> {
    // "Sending" on the agent channel means resolving a pending response
    const pending = this.pendingResponses.get(message.channelId)
    if (pending && message.text) {
      clearTimeout(pending.timeout)
      pending.resolve(message.text)
      this.pendingResponses.delete(message.channelId)
      return Promise.resolve(message.channelId)
    }
    return Promise.resolve(null)
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onCommand(
    handler: (command: string, args: string, message: InboundMessage) => Promise<void>,
  ): void {
    this.commandHandler = handler
  }

  // -----------------------------------------------------------------------
  // HTTP request handler
  // -----------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      })
      res.end()
      return
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', agent: this.config.agentId, timestamp: Date.now() }))
      return
    }

    // Agent message endpoint
    if (req.method === 'POST' && req.url === '/api/message') {
      await this.handleAgentMessage(req, res)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  private async handleAgentMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth check
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }))
      return
    }

    const token = authHeader.slice(7)
    if (token !== this.config.secret) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid secret' }))
      return
    }

    // Parse body
    let body: AgentMessageBody
    try {
      const rawBody = await readBody(req)
      body = JSON.parse(rawBody) as AgentMessageBody
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }

    if (!body.fromAgent || !body.message) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing required fields: fromAgent, message' }))
      return
    }

    const requestId = `agent-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const waitForResponse = body.waitForResponse !== false // Default: true
    const timeoutMs = body.timeoutMs ?? 120000

    // Build InboundMessage
    const inbound: InboundMessage = {
      id: requestId,
      userId: `agent:${body.fromAgent}`,
      username: body.fromAgent,
      displayName: `Agent: ${body.fromAgent}`,
      channelId: requestId, // Unique per request — response routes back via send()
      chatType: 'agent',
      text: body.message,
      platform: 'agent',
      agent: this.config.agentId,
      timestamp: Math.floor(Date.now() / 1000),
      metadata: {
        fromAgent: body.fromAgent,
        conversationId: body.conversationId,
        isAgentMessage: true,
      },
    }

    if (waitForResponse) {
      // Create a response promise that the send() method will resolve
      const responsePromise = new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingResponses.delete(requestId)
          resolve('[timeout — agent did not respond in time]')
        }, timeoutMs)

        this.pendingResponses.set(requestId, { resolve, timeout })
      })

      // Dispatch the message through the normal pipeline
      try {
        if (this.messageHandler) {
          // Don't await — let it process asynchronously while we wait on the response promise
          this.messageHandler(inbound).catch((err: unknown) => {
            const pending = this.pendingResponses.get(requestId)
            if (pending) {
              clearTimeout(pending.timeout)
              const msg = err instanceof Error ? err.message : String(err)
              pending.resolve(`[error processing message: ${msg}]`)
              this.pendingResponses.delete(requestId)
            }
          })
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'No message handler registered' }))
          return
        }

        const response = await responsePromise

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            response,
            agent: this.config.agentId,
            fromAgent: body.fromAgent,
            timestamp: Date.now(),
          }),
        )
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Processing failed: ${msg}` }))
      }
    } else {
      // Fire and forget
      if (this.messageHandler) {
        void this.messageHandler(inbound) // Errors are swallowed in async mode
      }

      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'accepted',
          requestId,
          agent: this.config.agentId,
          timestamp: Date.now(),
        }),
      )
    }
  }

  // -----------------------------------------------------------------------
  // Peer messaging tool
  // -----------------------------------------------------------------------

  /**
   * Creates the `agent_message` tool for sending messages to peer agents.
   */
  createMessageTool(): Tool {
    return {
      name: 'agent_message',
      description:
        'Send a message to another agent on a different instance. ' +
        "The message goes through the remote agent's full pipeline (memory, hooks, tools). " +
        'Use for cross-instance collaboration — the remote agent sees it as a real message.',
      parameters: {
        type: 'object',
        properties: {
          to_agent: {
            type: 'string',
            description: 'Agent ID to message (must be configured as a peer)',
          },
          message: {
            type: 'string',
            description: 'Message to send',
          },
          wait_for_response: {
            type: 'boolean',
            description: 'Wait for the remote agent to respond (default: true)',
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in ms when waiting for response (default: 120000)',
          },
        },
        required: ['to_agent', 'message'],
      },
      execute: async (args) => {
        const toAgent = args.to_agent as string
        const message = args.message as string
        const waitForResponse =
          args.wait_for_response != null ? (args.wait_for_response as boolean) : true
        const timeoutMs = args.timeout_ms != null ? (args.timeout_ms as number) : 120000

        const peer = this.config.peers?.[toAgent]
        if (!peer) {
          const available = Object.keys(this.config.peers ?? {}).join(', ') || 'none'
          return `Error: Unknown peer agent "${toAgent}". Available peers: ${available}`
        }

        try {
          const response = await this.sendToPeer(peer, {
            fromAgent: this.config.agentId,
            message,
            waitForResponse,
            timeoutMs,
          })

          if (waitForResponse) {
            return response.response ?? '[no response]'
          } else {
            return `Message sent to ${toAgent} (async — no response expected). Request ID: ${response.requestId}`
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error sending message to ${toAgent}: ${msg}`
        }
      },
    }
  }

  // -----------------------------------------------------------------------
  // Outbound peer messaging
  // -----------------------------------------------------------------------

  async sendToPeer(peer: PeerConfig, body: AgentMessageBody): Promise<AgentMessageResponse> {
    const secret = peer.secret ?? this.config.secret
    const url = `${peer.url.replace(/\/$/, '')}/api/message`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), (body.timeoutMs ?? 120000) + 5000) // Extra 5s for network

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => 'unknown error')
        throw new Error(`HTTP ${res.status}: ${errBody}`)
      }

      return (await res.json()) as AgentMessageResponse
    } finally {
      clearTimeout(timeout)
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentMessageBody {
  fromAgent: string
  message: string
  conversationId?: string
  waitForResponse?: boolean
  timeoutMs?: number
}

interface AgentMessageResponse {
  response?: string
  agent?: string
  fromAgent?: string
  requestId?: string
  status?: string
  timestamp?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
