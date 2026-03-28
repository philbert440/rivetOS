// TODO: Support agent-scoped tool filtering (see review #13)

/**
 * Delegation — agent-to-agent task handoff (intra-instance).
 *
 * One agent asks another to do work. The delegate gets its own
 * AgentLoop, provider, and workspace context. The result comes
 * back as a tool response to the requesting agent.
 *
 * Features:
 * - Chain depth limiting (A→B→C with configurable max depth)
 * - Result caching (same task+agent within session = cached)
 * - Graceful timeout with partial result return
 * - Hook integration (delegation:before / delegation:after)
 * - Rich fromAgent context so delegates know who asked and why
 */

import type {
  DelegationRequest,
  DelegationResult,
  TokenUsage,
  Tool,
  HookPipeline,
  DelegationBeforeContext,
  DelegationAfterContext,
  AgentToolFilter,
} from '@rivetos/types'
import { AgentLoop } from './loop.js'
import type { Router } from './router.js'
import type { WorkspaceLoader } from './workspace.js'

// ---------------------------------------------------------------------------
// Tool filtering
// ---------------------------------------------------------------------------

/** Filter tools based on per-agent include/exclude rules */
export function filterToolsForAgent(
  tools: Tool[],
  agentId: string,
  filters?: Record<string, AgentToolFilter>,
): Tool[] {
  const filter = filters?.[agentId]
  if (!filter) return tools
  // Include takes precedence if both are set
  if (filter.include?.length) {
    return tools.filter((t) => filter.include!.includes(t.name))
  }
  if (filter.exclude?.length) {
    return tools.filter((t) => !filter.exclude!.includes(t.name))
  }
  return tools
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DelegationConfig {
  router: Router
  workspace: WorkspaceLoader
  /** Tool resolver — called at delegation time, not construction time */
  tools: () => Tool[]
  /** Maximum delegation chain depth (default: 3) */
  maxChainDepth?: number
  /** Cache TTL in ms (default: 300000 = 5 min) */
  cacheTtlMs?: number
  /** Hook pipeline for delegation:before/after events */
  hooks?: HookPipeline
  /** Per-agent tool filtering (exclude/include lists) */
  toolFilter?: Record<string, AgentToolFilter>
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: DelegationResult
  timestamp: number
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class DelegationEngine {
  private config: DelegationConfig
  private maxChainDepth: number
  private cacheTtlMs: number
  private cache: Map<string, CacheEntry> = new Map()

  constructor(config: DelegationConfig) {
    this.config = config
    this.maxChainDepth = config.maxChainDepth ?? 3
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000
  }

  /**
   * Delegate a task to another agent. Blocks until the delegate completes.
   *
   * @param request - What to delegate
   * @param chainDepth - Current depth in a delegation chain (0 = top level)
   */
  async delegate(request: DelegationRequest, chainDepth = 0): Promise<DelegationResult> {
    const startTime = Date.now()

    // --- Chain depth check ---
    if (chainDepth >= this.maxChainDepth) {
      return {
        status: 'failed',
        response:
          `Delegation chain depth limit reached (${this.maxChainDepth}). ` +
          `Chain: ${request.fromAgent} → ${request.toAgent} at depth ${chainDepth}. ` +
          `Increase maxChainDepth in config if deeper chains are needed.`,
      }
    }

    // --- Cache check ---
    const cacheKey = this.buildCacheKey(request)
    const cached = this.getFromCache(cacheKey)
    if (cached) {
      // Fire delegation:after with cached=true
      await this.fireAfterHook(
        request,
        { ...cached, status: 'completed' },
        startTime,
        chainDepth,
        true,
      )
      return { ...cached, status: 'completed' }
    }

    // --- Hook: delegation:before ---
    if (this.config.hooks) {
      const beforeCtx: DelegationBeforeContext = {
        event: 'delegation:before',
        fromAgent: request.fromAgent,
        toAgent: request.toAgent,
        task: request.task,
        chainDepth,
        agentId: request.fromAgent,
        timestamp: Date.now(),
        metadata: {},
      }
      await this.config.hooks.run(beforeCtx)

      if (beforeCtx.blocked) {
        const result: DelegationResult = {
          status: 'failed',
          response: `Delegation blocked: ${beforeCtx.blockReason ?? 'blocked by hook'}`,
        }
        await this.fireAfterHook(request, result, startTime, chainDepth, false)
        return result
      }
    }

    // --- Resolve agent and provider ---
    const { router, workspace } = this.config

    const agents = router.getAgents()
    const agent = agents.find((a) => a.id === request.toAgent)
    if (!agent) {
      const result: DelegationResult = {
        status: 'failed',
        response: `Unknown agent: ${request.toAgent}. Available: ${agents.map((a) => a.id).join(', ')}`,
      }
      await this.fireAfterHook(request, result, startTime, chainDepth, false)
      return result
    }

    const providers = router.getProviders()
    const provider = providers.find((p) => p.id === agent.provider)
    if (!provider) {
      const result: DelegationResult = {
        status: 'failed',
        response: `Provider ${agent.provider} not available for agent ${request.toAgent}`,
      }
      await this.fireAfterHook(request, result, startTime, chainDepth, false)
      return result
    }

    // --- Build enriched system prompt with fromAgent context ---
    const systemPrompt = await workspace.buildSystemPrompt(agent.id)
    const contextLines = [
      `## Delegation Context`,
      `You are being delegated a task by **${request.fromAgent}**.`,
      ``,
      `**Requesting agent:** ${request.fromAgent}`,
      `**Chain depth:** ${chainDepth} (max: ${this.maxChainDepth})`,
    ]

    if (request.context?.length) {
      contextLines.push(``, `**Additional context:**`)
      for (const line of request.context) {
        contextLines.push(`- ${line}`)
      }
    }

    if (chainDepth > 0) {
      contextLines.push(
        ``,
        `> You are in a delegation chain. You may delegate to other agents (depth ${chainDepth + 1}/${this.maxChainDepth}).`,
      )
    }

    const enrichedPrompt = systemPrompt + '\n\n' + contextLines.join('\n')

    // --- Create abort controller with timeout ---
    const abort = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false

    if (request.timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true
        abort.abort('Delegation timeout')
      }, request.timeoutMs)
    }

    try {
      // Resolve tools at delegation time and filter for the target agent
      const allTools = this.config.tools()
      const filteredTools = filterToolsForAgent(allTools, request.toAgent, this.config.toolFilter)
      const delegationTools = [...filteredTools]

      // If we have room in the chain, give the delegate the delegation tool too
      if (chainDepth + 1 < this.maxChainDepth) {
        delegationTools.push(this.createDelegationTool(chainDepth + 1))
      }

      const loop = new AgentLoop({
        systemPrompt: enrichedPrompt,
        provider,
        tools: delegationTools,
        agentId: request.toAgent,
        hooks: this.config.hooks,
      })

      const turnResult = await loop.run(request.task, [], abort.signal)

      // Enrich raw token counts into a full TokenUsage with agent metadata
      const enrichUsage = (raw?: {
        promptTokens: number
        completionTokens: number
      }): TokenUsage | undefined => {
        if (!raw) return undefined
        return {
          ...raw,
          agent: request.toAgent,
          provider: agent.provider,
          model: provider.name,
          timestamp: Date.now(),
        }
      }

      if (turnResult.aborted) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timedOut is mutated asynchronously in setTimeout callback
        if (timedOut) {
          // Timeout — return partial result if available
          const result: DelegationResult = {
            status: 'timeout',
            response: turnResult.partialResponse
              ? `Delegation to ${request.toAgent} timed out after ${request.timeoutMs}ms. Partial result:\n\n${turnResult.partialResponse}`
              : `Delegation to ${request.toAgent} timed out after ${request.timeoutMs}ms (no partial result available).`,
            iterations: turnResult.iterations,
            usage: enrichUsage(turnResult.usage),
            toolsUsed: turnResult.toolsUsed,
            durationMs: Date.now() - startTime,
          }
          await this.fireAfterHook(request, result, startTime, chainDepth, false)
          return result
        }

        // Aborted (not timeout)
        const result: DelegationResult = {
          status: 'failed',
          response: `Delegation to ${request.toAgent} was aborted.`,
          iterations: turnResult.iterations,
          toolsUsed: turnResult.toolsUsed,
          durationMs: Date.now() - startTime,
        }
        await this.fireAfterHook(request, result, startTime, chainDepth, false)
        return result
      }

      const result: DelegationResult = {
        status: 'completed',
        response: turnResult.response,
        iterations: turnResult.iterations,
        usage: enrichUsage(turnResult.usage),
        toolsUsed: turnResult.toolsUsed,
        durationMs: Date.now() - startTime,
      }

      // Cache the result
      this.putInCache(cacheKey, result)

      await this.fireAfterHook(request, result, startTime, chainDepth, false)
      return result
    } catch (err: unknown) {
      const result: DelegationResult = {
        status: 'failed',
        response: `Delegation to ${request.toAgent} failed: ${(err as Error).message}`,
      }
      await this.fireAfterHook(request, result, startTime, chainDepth, false)
      return result
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  /**
   * Create a Tool that lets the agent delegate to other agents.
   *
   * @param chainDepth - Current chain depth (passed to delegate calls)
   */
  createDelegationTool(chainDepth = 0): Tool {
    return {
      name: 'delegate_task',
      description:
        'Delegate a task to another agent. Use when you need a different model — ' +
        'e.g., ask Grok to write code, ask Opus to review it. ' +
        'The delegate runs with its own provider and returns the result.',
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
            description: 'Timeout in milliseconds (default: 120000)',
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
            timeoutMs: (args.timeout_ms as number | undefined) ?? 120000,
          },
          chainDepth,
        )

        const meta: string[] = []
        if (result.durationMs != null) meta.push(`${result.durationMs}ms`)
        if (result.toolsUsed?.length) {
          meta.push(`tools: ${[...new Set(result.toolsUsed)].join(', ')}`)
        }
        if (result.usage) {
          meta.push(`tokens: ${result.usage.promptTokens + result.usage.completionTokens}`)
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

  /** Clear the result cache */
  clearCache(): void {
    this.cache.clear()
  }

  /** Get cache size (for testing/metrics) */
  get cacheSize(): number {
    return this.cache.size
  }

  // -----------------------------------------------------------------------
  // Cache helpers
  // -----------------------------------------------------------------------

  private buildCacheKey(request: DelegationRequest): string {
    return `${request.fromAgent}:${request.toAgent}:${request.task}`
  }

  private getFromCache(key: string): DelegationResult | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    if (Date.now() - entry.timestamp > this.cacheTtlMs) {
      this.cache.delete(key)
      return undefined
    }

    return entry.result
  }

  private putInCache(key: string, result: DelegationResult): void {
    // Only cache successful results
    if (result.status !== 'completed') return
    this.cache.set(key, { result, timestamp: Date.now() })
  }

  // -----------------------------------------------------------------------
  // Hook helpers
  // -----------------------------------------------------------------------

  private async fireAfterHook(
    request: DelegationRequest,
    result: DelegationResult,
    startTime: number,
    chainDepth: number,
    cached: boolean,
  ): Promise<void> {
    if (!this.config.hooks) return

    const afterCtx: DelegationAfterContext = {
      event: 'delegation:after',
      fromAgent: request.fromAgent,
      toAgent: request.toAgent,
      task: request.task,
      status: cached ? 'cached' : result.status,
      durationMs: Date.now() - startTime,
      usage: result.usage,
      toolsUsed: result.toolsUsed,
      cached,
      agentId: request.fromAgent,
      timestamp: Date.now(),
      metadata: {},
    }
    await this.config.hooks.run(afterCtx)
  }
}
