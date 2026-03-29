// TODO: Support agent-scoped tool filtering (see review #13)

/**
 * Delegation — agent-to-agent task handoff.
 *
 * One agent asks another to do work. The delegate gets its own
 * AgentLoop, provider, and workspace context. The result comes
 * back as a tool response to the requesting agent.
 */

import type {
  DelegationRequest,
  DelegationResult,
  Tool,
} from '@rivetos/types';
import { AgentLoop } from './loop.js';
import type { Router } from './router.js';
import type { WorkspaceLoader } from './workspace.js';

export interface DelegationConfig {
  router: Router;
  workspace: WorkspaceLoader;
  tools: Tool[];
}

export class DelegationEngine {
  private config: DelegationConfig;

  constructor(config: DelegationConfig) {
    this.config = config;
  }

  /**
   * Delegate a task to another agent. Blocks until the delegate completes.
   */
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const { router, workspace, tools } = this.config;

    // Resolve the delegate agent's provider
    const agents = router.getAgents();
    const agent = agents.find((a) => a.id === request.toAgent);
    if (!agent) {
      return {
        status: 'failed',
        response: `Unknown agent: ${request.toAgent}. Available: ${agents.map((a) => a.id).join(', ')}`,
      };
    }

    const providers = router.getProviders();
    const provider = providers.find((p) => p.id === agent.provider);
    if (!provider) {
      return {
        status: 'failed',
        response: `Provider ${agent.provider} not available for agent ${request.toAgent}`,
      };
    }

    // Build system prompt for the delegate
    const systemPrompt = await workspace.buildSystemPrompt(agent.id);
    const enrichedPrompt = systemPrompt + `\n\n## Delegation Context\nYou were asked to do this by agent "${request.fromAgent}".\n${request.context?.join('\n') ?? ''}`;

    // Create abort controller with timeout
    const abort = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (request.timeoutMs) {
      timeoutId = setTimeout(() => abort.abort('Delegation timeout'), request.timeoutMs);
    }

    try {
      const loop = new AgentLoop({
        systemPrompt: enrichedPrompt,
        provider,
        tools,
        // Delegate stream events are logged but not forwarded to the parent channel
        // (the parent agent will summarize the result in its own response)
      });

      const result = await loop.run(request.task, [], abort.signal);

      if (result.aborted) {
        return {
          status: 'timeout',
          response: `Delegation to ${request.toAgent} timed out after ${request.timeoutMs}ms`,
          iterations: result.iterations,
        };
      }

      return {
        status: 'completed',
        response: result.response,
        iterations: result.iterations,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        response: `Delegation to ${request.toAgent} failed: ${err.message}`,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Create a Tool that lets the agent delegate to other agents.
   */
  createDelegationTool(): Tool {
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
      execute: async (args: Record<string, unknown>, _signal?: AbortSignal, context?: { agentId?: string }): Promise<string> => {
        const result = await this.delegate({
          fromAgent: context?.agentId ?? 'unknown',
          toAgent: args.to_agent as string,
          task: args.task as string,
          context: args.context as string[] | undefined,
          timeoutMs: (args.timeout_ms as number) ?? 120000,
        });

        return `[${result.status}] ${result.response}`;
      },
    };
  }
}
