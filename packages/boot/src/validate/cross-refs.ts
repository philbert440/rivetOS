/**
 * Cross-reference validation — ensures agents, providers, channels reference each other correctly.
 */

import type { ValidationIssue } from './types.js'

export function validateCrossReferences(
  cfg: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  const agents = (cfg.agents ?? {}) as Partial<Record<string, Record<string, unknown>>>
  const providers = (cfg.providers ?? {}) as Record<string, unknown>
  const runtime = (cfg.runtime ?? {}) as Record<string, unknown>

  const providerIds = new Set(Object.keys(providers))
  const agentIds = new Set(Object.keys(agents))

  // Each agent's provider must exist in providers section
  for (const [name, agent] of Object.entries(agents)) {
    if (agent && typeof agent === 'object' && typeof agent.provider === 'string') {
      if (!providerIds.has(agent.provider)) {
        issues.push({
          severity: 'error',
          path: `agents.${name}.provider`,
          message: `Provider "${agent.provider}" referenced by agent "${name}" is not defined in [providers]. Available: ${[...providerIds].join(', ') || '(none)'}`,
        })
      }
    }
  }

  // default_agent must exist in agents section
  if (typeof runtime.default_agent === 'string' && runtime.default_agent) {
    if (!agentIds.has(runtime.default_agent)) {
      issues.push({
        severity: 'error',
        path: 'runtime.default_agent',
        message: `Default agent "${runtime.default_agent}" is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
      })
    }
  }

  // Heartbeat agents must exist
  if (Array.isArray(runtime.heartbeats)) {
    for (let i = 0; i < runtime.heartbeats.length; i++) {
      const hb = runtime.heartbeats[i] as Record<string, unknown> | null
      if (hb && typeof hb.agent === 'string' && !agentIds.has(hb.agent)) {
        issues.push({
          severity: 'error',
          path: `runtime.heartbeats[${i}].agent`,
          message: `Heartbeat agent "${hb.agent}" is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
        })
      }
    }
  }

  // Coding pipeline agents must exist
  if (runtime.coding_pipeline && typeof runtime.coding_pipeline === 'object') {
    const pipeline = runtime.coding_pipeline as Record<string, unknown>
    if (typeof pipeline.builder_agent === 'string' && !agentIds.has(pipeline.builder_agent)) {
      issues.push({
        severity: 'error',
        path: 'runtime.coding_pipeline.builder_agent',
        message: `Builder agent "${pipeline.builder_agent}" is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
      })
    }
    if (typeof pipeline.validator_agent === 'string' && !agentIds.has(pipeline.validator_agent)) {
      issues.push({
        severity: 'error',
        path: 'runtime.coding_pipeline.validator_agent',
        message: `Validator agent "${pipeline.validator_agent}" is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
      })
    }
  }

  // Discord channel_bindings agent refs must exist
  const channels = (cfg.channels ?? {}) as Partial<Record<string, Record<string, unknown>>>
  const discord = channels.discord
  if (discord && typeof discord.channel_bindings === 'object' && discord.channel_bindings) {
    const bindings = discord.channel_bindings as Record<string, string>
    for (const [channelId, agentId] of Object.entries(bindings)) {
      if (typeof agentId === 'string' && !agentIds.has(agentId)) {
        issues.push({
          severity: 'error',
          path: `channels.discord.channel_bindings.${channelId}`,
          message: `Channel binding references agent "${agentId}" which is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
        })
      }
    }
  }

  // Telegram agent ref must exist
  const telegram = channels.telegram
  if (telegram && typeof telegram.agent === 'string' && !agentIds.has(telegram.agent)) {
    issues.push({
      severity: 'error',
      path: 'channels.telegram.agent',
      message: `Telegram agent "${telegram.agent}" is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
    })
  }
}
