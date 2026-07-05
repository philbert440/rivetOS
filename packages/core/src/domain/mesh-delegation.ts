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
// Use undici's own fetch (not Node's global fetch). The mTLS dispatcher is
// built from the node_modules `undici` Agent; Node's global fetch is backed by
// a *different* bundled undici whose dispatcher handler interface is
// incompatible — passing our Agent to global fetch throws
// `invalid onRequestStart method (UND_ERR_INVALID_ARG)` before the request
// leaves the host, silently breaking all remote mesh delegation. Importing
// fetch from the same undici instance as the Agent keeps them in lockstep.
import { fetch as undiciFetch, type Dispatcher } from 'undici'

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

  /** TLS material for outbound mTLS connections */
  tls: import('../runtime/agent-channel.js').AgentChannelTlsConfig

  /** Pre-created undici dispatcher for mTLS (shared across all requests) */
  httpsDispatcher?: unknown

  /** This node's agent IDs */
  localAgents: string[]

  /**
   * This node's name in the mesh registry. Used to exclude self when
   * enumerating *remote* agents for the roster — otherwise this node's own
   * agents would also show up as "remote on <self>".
   */
  nodeName?: string
}

/** A reachable agent and where it lives, for the delegation roster. */
interface RosterEntry {
  agentId: string
  /** True if the agent runs on this node (delegation stays in-process). */
  local: boolean
  /** Names of remote nodes hosting this agent (online only). */
  remoteNodes: string[]
}

// ---------------------------------------------------------------------------
// Mesh Delegation Engine
// ---------------------------------------------------------------------------

export class MeshDelegationEngine {
  private config: MeshDelegationConfig

  /** Cached, human-readable roster of reachable agents (for the tool description). */
  private rosterText = '(roster loading…)'
  /** When the roster cache was last refreshed (epoch ms; 0 = never). */
  private rosterFetchedAt = 0
  /** How long a cached roster stays fresh before a lazy background refresh. */
  private readonly rosterTtlMs = 30_000

  constructor(config: MeshDelegationConfig) {
    this.config = config

    // If no dispatcher was provided from boot, create one (fallback for tests)
    if (!this.config.httpsDispatcher) {
      this.createDispatcher().catch((err: unknown) =>
        log.error('Failed to create HTTPS dispatcher for mesh delegation', err),
      )
    }

    // Prime the roster so the first turn already advertises real agents
    // instead of the loading placeholder.
    void this.refreshRoster()
  }

  // -------------------------------------------------------------------------
  // Agent roster — what the model can actually delegate to
  //
  // The whole point of the mesh is that an agent can hand work to a *different*
  // model on another node. But a delegate_task tool with a free-text target and
  // a hardcoded "e.g. grok, opus" example leaves weaker local models guessing —
  // they parrot the example and never discover who's really out there. So we
  // advertise the live roster (local + online mesh peers) right in the tool.
  // -------------------------------------------------------------------------

  /**
   * Enumerate every agent this node can delegate to right now — its own
   * local agents plus agents on online mesh peers. Local agents win: if an
   * agent id exists both locally and remotely, delegation stays in-process,
   * so we mark it local and don't advertise the remote copies.
   */
  async listReachableAgents(): Promise<RosterEntry[]> {
    const byAgent = new Map<string, RosterEntry>()

    for (const agentId of this.config.localAgents) {
      byAgent.set(agentId, { agentId, local: true, remoteNodes: [] })
    }

    let nodes: MeshNode[] = []
    try {
      nodes = await this.config.meshRegistry.getNodes()
    } catch (err: unknown) {
      log.warn(`Could not read mesh registry for roster: ${(err as Error).message}`)
    }

    for (const node of nodes) {
      if (node.status !== 'online') continue
      // Skip self — its agents are already covered by localAgents above.
      if (this.config.nodeName && node.name === this.config.nodeName) continue
      for (const agentId of node.agents) {
        const existing = byAgent.get(agentId)
        if (existing?.local) continue // local copy preferred — don't list remotes
        if (existing) {
          if (!existing.remoteNodes.includes(node.name)) existing.remoteNodes.push(node.name)
        } else {
          byAgent.set(agentId, { agentId, local: false, remoteNodes: [node.name] })
        }
      }
    }

    return Array.from(byAgent.values())
  }

  /** Refresh the cached roster text from the live registry. Best-effort. */
  private async refreshRoster(): Promise<void> {
    const entries = await this.listReachableAgents()
    this.rosterText = this.formatRoster(entries)
    this.rosterFetchedAt = Date.now()
  }

  /** Format the roster as bullet lines for the tool description. */
  private formatRoster(entries: RosterEntry[]): string {
    if (entries.length === 0) return '(no agents currently reachable)'
    return entries
      .map((e) =>
        e.local
          ? `- ${e.agentId} (this node — local, in-process)`
          : `- ${e.agentId} (remote: ${e.remoteNodes.join(', ')})`,
      )
      .join('\n')
  }

  /**
   * The delegate_task description, including the live roster. Read fresh by the
   * provider on every turn (via the tool's `description` getter), so it always
   * reflects the current mesh. Kicks a background refresh when the cache is
   * stale; returns the last-known roster immediately (never blocks a turn).
   */
  private buildDescription(): string {
    if (Date.now() - this.rosterFetchedAt > this.rosterTtlMs) {
      void this.refreshRoster()
    }
    return (
      'Delegate a task to another agent — use when a different model or specialist ' +
      'is better suited (e.g., ask "opus" to review code, ask "grok" for live web/X search). ' +
      'The delegate runs with its own model and returns the result. ' +
      'Works across the mesh — targets on other nodes are reached automatically.\n\n' +
      'Agents you can delegate to right now (pass one as `to_agent`):\n' +
      this.rosterText +
      '\n\nPick the agent whose model/strengths fit the task; "local" runs a fresh context on this node.'
    )
  }

  /**
   * Route a delegation request to the best available agent —
   * local if possible, remote via mesh if not.
   */
  async delegate(request: DelegationRequest, chainDepth = 0): Promise<DelegationResult> {
    const route = await this.resolveRoute(request.toAgent)

    if (!route) {
      const reachable = (await this.listReachableAgents()).map((e) => e.agentId)
      return {
        status: 'failed',
        response:
          `Agent "${request.toAgent}" not found locally or in the mesh. ` +
          `Agents you can delegate to: ${reachable.length ? reachable.join(', ') : '(none reachable)'}`,
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

      // Use shared undici dispatcher for mTLS (created once at construction).
      // Must call undici's own fetch here so the dispatcher and client come
      // from the same undici instance (see import note above).
      const res = await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: request.timeoutMs ? controller.signal : undefined,
        dispatcher: this.config.httpsDispatcher as Dispatcher,
      })

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
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getter below needs the engine instance
    const engine = this
    return {
      name: 'delegate_task',
      // Live description: read fresh by the provider every turn so the
      // advertised roster always reflects the current mesh (see buildDescription).
      get description(): string {
        return engine.buildDescription()
      },
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
