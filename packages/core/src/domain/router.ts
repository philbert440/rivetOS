/**
 * Router — routes inbound messages to the right agent and provider.
 *
 * Pure domain logic. Stateless lookup.
 */

import type { InboundMessage, Provider, AgentConfig } from '@rivetos/types'

export interface RouteResult {
  agent: AgentConfig
  provider: Provider
}

export class Router {
  private agents: Map<string, AgentConfig> = new Map()
  private providers: Map<string, Provider> = new Map()
  private defaultAgentId: string

  constructor(defaultAgentId: string) {
    this.defaultAgentId = defaultAgentId
  }

  registerAgent(agent: AgentConfig): void {
    this.agents.set(agent.id, agent)
  }

  registerProvider(provider: Provider): void {
    this.providers.set(provider.id, provider)
  }

  route(message: InboundMessage): RouteResult {
    const agentId = message.agent ?? this.defaultAgentId
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(
        `Unknown agent: "${agentId}". Registered: [${[...this.agents.keys()].join(', ')}]`,
      )
    }

    const provider = this.providers.get(agent.provider)
    if (!provider) {
      throw new Error(
        `Unknown provider: "${agent.provider}" for agent "${agentId}". Registered: [${[...this.providers.keys()].join(', ')}]`,
      )
    }

    return { agent, provider }
  }

  getAgents(): AgentConfig[] {
    return [...this.agents.values()]
  }

  getProviders(): Provider[] {
    return [...this.providers.values()]
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    for (const [id, provider] of this.providers) {
      try {
        results[id] = await provider.isAvailable()
      } catch {
        results[id] = false
      }
    }
    return results
  }
}
