/**
 * Cross-reference validation — ensures agents, providers, channels reference each other correctly.
 */

import type { ValidationIssue } from './types.js'

export function validateCrossReferences(
  cfg: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  const agents = (cfg.agents ?? {}) as Record<string, { provider?: unknown } | null | undefined>
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

  // Social channel agent-binding cross-checks (discord channel_bindings,
  // telegram.agent) were removed with those plugins in Phase 5. Stale
  // channels.telegram / channels.discord keys only produce the generic
  // "unknown channel type" warning from validateChannels — they must not
  // hard-error boot.
}
