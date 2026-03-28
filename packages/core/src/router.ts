/**
 * Router — routes inbound messages to the right agent and provider.
 *
 * Simple mapping: channel/chatId → agent → provider.
 * No smart routing, no query classification. Just a lookup table.
 * You can make it smarter later with a plugin.
 */

import type { InboundMessage, Provider, AgentConfig } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  agent: AgentConfig;
  provider: Provider;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class Router {
  private agents: Map<string, AgentConfig> = new Map();
  private providers: Map<string, Provider> = new Map();
  private defaultAgentId: string;

  constructor(defaultAgentId: string) {
    this.defaultAgentId = defaultAgentId;
  }

  /**
   * Register an agent configuration.
   */
  registerAgent(agent: AgentConfig): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * Register a provider instance.
   */
  registerProvider(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Route an inbound message to an agent and provider.
   *
   * Priority:
   * 1. Message's `agent` field (set by channel binding)
   * 2. Default agent
   */
  route(message: InboundMessage): RouteResult {
    // Determine agent
    const agentId = message.agent ?? this.defaultAgentId;
    const agent = this.agents.get(agentId);

    if (!agent) {
      throw new Error(`Unknown agent: "${agentId}". Registered: [${[...this.agents.keys()].join(', ')}]`);
    }

    // Determine provider
    const provider = this.providers.get(agent.provider);

    if (!provider) {
      throw new Error(`Unknown provider: "${agent.provider}" for agent "${agentId}". Registered: [${[...this.providers.keys()].join(', ')}]`);
    }

    return { agent, provider };
  }

  /**
   * List registered agents.
   */
  getAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }

  /**
   * List registered providers.
   */
  getProviders(): Provider[] {
    return [...this.providers.values()];
  }

  /**
   * Check if all providers are available.
   */
  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [id, provider] of this.providers) {
      try {
        results[id] = await provider.isAvailable();
      } catch {
        results[id] = false;
      }
    }
    return results;
  }
}
