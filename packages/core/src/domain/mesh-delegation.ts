/**
 * Mesh-aware Delegation — extends DelegationEngine to route to remote agents.
 *
 * When a delegate_task targets an agent that doesn't exist locally, the
 * mesh delegation layer checks the mesh registry for a remote node that
 * hosts that agent, then sends the task via the agent channel HTTP API.
 *
 * Priority:
 * 1. Local agent (same process) → use DelegationEngine directly
 * 2. Remote agent (mesh peer) → HTTP POST to the peer's /api/message
 * 3. Not found → error
 */

import type {
  DelegationRequest,
  DelegationResult,
  Tool,
  MeshNode,
  MeshRegistry,
  MeshDelegationRoute,
} from '@rivetos/types'
import type { DelegationEngine } from './delegation.js'
import type { Router } from './router.js'
import { logger } from '../logger.js'

const log = logger('MeshDelegation')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MeshDelegationConfig {
  /** The local DelegationEngine for same-process delegation */
  localEngine: DelegationEngine

  /** The local Router — used to check if an agent is local */
  router: Router

  /** Mesh registry — used to find remote agents */
  meshRegistry: MeshRegistry

  /**
   * Shared secret — DEPRECATED for agent-channel auth.
   * @deprecated No longer used for agent-channel communication. Retained for compat.
   */
  secret?: string

  /** TLS material for outbound mTLS connections */
  tls: import('../runtime/agent-channel.js').AgentChannelTlsConfig

  /** Pre-created undici dispatcher for mTLS (shared across all requests) */
  httpsDispatcher?: unknown

  /** This node's agent IDs */
  localAgents: string[]
}

// ---------------------------------------------------------------------------
// Mesh Delegation Engine
// ---------------------------------------------------------------------------

export class MeshDelegationEngine {
  private config: MeshDelegationConfig

  constructor(config: MeshDelegationConfig) {
    this.config = config

    // If no dispatcher was provided from boot, create one (fallback for tests)
    if (!this.config.httpsDispatcher) {
      this.createDispatcher().catch((err: unknown) =>
        log.error('Failed to create HTTPS dispatcher for mesh delegation', err),
      )
    }
  }

  /**
   * Route a delegation request to the best available agent —
   * local if possible, remote via mesh if not.
   */
  async delegate(request: DelegationRequest, chainDepth = 0): Promise<DelegationResult> {
    const route = await this.resolveRoute(request.toAgent)

    if (!route) {
      return {
        status: 'failed',
        response: `Agent "${request.toAgent}" not found locally or in the mesh. Available local agents: ${this.config.localAgents.join(', ')}`,
      }
    }

    if (route.type === 'local') {
      log.info(`Delegating to ${request.toAgent} locally`)
      return this.config.localEngine.delegate(request, chainDepth)
    }

    log.info(
      `Delegating to ${request.toAgent} remotely via ${route.node.name} (${route.node.host}:${String(route.node.port)})`,
    )
    return this.delegateRemote(request, route, chainDepth)
  }

  /**
   * Resolve where an agent lives — local or remote.
   */
  async resolveRoute(agentId: string): Promise<MeshDelegationRoute | undefined> {
    // Check local first
    if (this.config.localAgents.includes(agentId)) {
      const agents = this.config.router.getAgents()
      const agent = agents.find((a) => a.id === agentId)
      if (agent) {
        return {
          agentId,
          node: { id: 'local', name: 'local', host: 'localhost', port: 0 } as MeshNode,
          type: 'local',
        }
      }
    }

    // Check mesh registry
    const nodes = await this.config.meshRegistry.findByAgent(agentId)
    if (nodes.length === 0) return undefined

    // Pick the best node — prefer online, then most recently seen
    const sorted = nodes
      .filter((n) => n.status === 'online')
      .sort((a, b) => b.lastSeen - a.lastSeen)

    if (sorted.length === 0) {
      // All nodes hosting this agent are offline
      return undefined
    }

    return {
      agentId,
      node: sorted[0],
      type: 'remote',
    }
  }

  /**
   * Prefer `<nodeName>.mesh` DNS name for mTLS connections — dnsmasq resolves
   * it everywhere on the mesh and the node cert SANs include it. Fall back to
   * the IP stored in the registry only if the node name is unavailable.
   */
  private meshHost(node: import('@rivetos/types').MeshNode): string {
    return node.name ? `${node.name}.mesh` : node.host
  }

  private async createDispatcher() {
    const { Agent: UndiciAgent } = await import('undici')
    this.config.httpsDispatcher = new UndiciAgent({
      connect: {
        ca: this.config.tls.ca,
        cert: this.config.tls.cert,
        key: this.config.tls.key,
        rejectUnauthorized: true,
      },
    })
  }

  private async delegateRemote(
    request: DelegationRequest,
    route: MeshDelegationRoute,
    chainDepth = 0,
  ): Promise<DelegationResult> {
    const { node } = route
    const url = `https://${this.meshHost(node)}:${String(node.port)}/api/message`
    const startTime = Date.now()

    try {
      const controller = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | undefined

      if (request.timeoutMs) {
        timeout = setTimeout(() => controller.abort(), request.timeoutMs + 5_000)
      }

      const payload: Record<string, unknown> = {
        fromAgent: request.fromAgent,
        message: `[Mesh delegation] ${request.task}`,
        waitForResponse: true,
        chainDepth: chainDepth + 1,
      }
      if (request.timeoutMs) {
        payload.timeoutMs = request.timeoutMs
      }
      if (request.model) {
        payload.model = request.model
      }

      // Use shared undici dispatcher for mTLS (created once at construction)
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: request.timeoutMs ? controller.signal : undefined,
        dispatcher: this.config.httpsDispatcher as never,
      }

      const res = await fetch(url, fetchOptions)

      if (timeout) clearTimeout(timeout)

      if (!res.ok) {
        const errBody = await res.text().catch(() => 'unknown error')
        return {
          status: 'failed',
          response: `Remote delegation to ${request.toAgent} on ${node.name} failed: HTTP ${String(res.status)} — ${errBody}`,
          durationMs: Date.now() - startTime,
        }
      }

      const resBody = (await res.json()) as { response?: string; agent?: string }

      return {
        status: 'completed',
        response: resBody.response ?? '[no response from remote agent]',
        durationMs: Date.now() - startTime,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const isTimeout = msg.includes('abort')

      return {
        status: isTimeout ? 'timeout' : 'failed',
        response: `Remote delegation to ${request.toAgent} on ${node.name} ${isTimeout ? 'timed out' : 'failed'}: ${msg}`,
        durationMs: Date.now() - startTime,
      }
    }
  }

  /**
   * Create a mesh-aware delegate_task tool.
   * This replaces the local-only delegation tool when mesh is enabled.
   */
  createDelegationTool(chainDepth = 0): Tool {
    return {
      name: 'delegate_task',
      description:
        'Delegate a task to another agent. Use when you need a different model — ' +
        'e.g., ask Grok to write code, ask Opus to review it. ' +
        'The delegate runs with its own provider and returns the result. ' +
        'Works across the mesh — can route to agents on other nodes.',
      parameters: {
        type: 'object',
        properties: {
          to_agent: {
            type: 'string',
            description: 'Agent ID to delegate to (e.g., "grok", "opus", "local")',
          },
          task: {
            type: 'string',
            description: 'What you want the delegate to do',
          },
          context: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional context strings to include',
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in milliseconds (default: none — runs until done)',
          },
          model: {
            type: 'string',
            description:
              'Optional model override for the delegate. Use to pick a specific model ' +
              'tier (e.g., "grok-4-1-fast-reasoning" vs "grok-4.20-reasoning") without ' +
              'creating a separate agent. Forwarded across the mesh to remote nodes.',
          },
        },
        required: ['to_agent', 'task'],
      },
      execute: async (
        args: Record<string, unknown>,
        _signal?: AbortSignal,
        context?: { agentId?: string },
      ): Promise<string> => {
        const result = await this.delegate(
          {
            fromAgent: context?.agentId ?? 'unknown',
            toAgent: args.to_agent as string,
            task: args.task as string,
            context: args.context as string[] | undefined,
            timeoutMs: args.timeout_ms as number | undefined,
            model: args.model as string | undefined,
          },
          chainDepth,
        )

        const meta: string[] = []
        if (result.durationMs != null) meta.push(`${String(result.durationMs)}ms`)
        if (result.toolsUsed?.length) {
          meta.push(`tools: ${[...new Set(result.toolsUsed)].join(', ')}`)
        }
        if (result.usage) {
          meta.push(`tokens: ${String(result.usage.promptTokens + result.usage.completionTokens)}`)
        }
        const metaLine = meta.length
          ? `\n\n---\n_Delegation [${result.status}]: ${meta.join(' | ')}_`
          : ''

        if (result.status === 'completed') {
          return result.response + metaLine
        }
        return `[${result.status}] ${result.response}${metaLine}`
      },
    }
  }
}
