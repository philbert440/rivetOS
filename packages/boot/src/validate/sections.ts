/**
 * Section validators — runtime, agents, providers, channels, memory.
 */

import {
  KNOWN_RUNTIME_KEYS,
  KNOWN_AGENT_KEYS,
  VALID_THINKING_LEVELS,
  KNOWN_PROVIDERS,
  KNOWN_CHANNELS,
  KNOWN_HEARTBEAT_KEYS,
  KNOWN_PIPELINE_KEYS,
  KNOWN_MEMORY_POSTGRES_KEYS,
  API_KEY_PATTERNS,
  type ValidationIssue,
} from './types.js'

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export function validateRuntime(runtime: Record<string, unknown>, issues: ValidationIssue[]): void {
  for (const key of Object.keys(runtime)) {
    if (!KNOWN_RUNTIME_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `runtime.${key}`,
        message: `Unknown runtime key "${key}"`,
      })
    }
  }

  if (!runtime.workspace) {
    issues.push({
      severity: 'error',
      path: 'runtime.workspace',
      message: 'Missing required field "runtime.workspace"',
    })
  } else if (typeof runtime.workspace !== 'string') {
    issues.push({
      severity: 'error',
      path: 'runtime.workspace',
      message: '"runtime.workspace" must be a string path',
    })
  }

  if (!runtime.default_agent) {
    issues.push({
      severity: 'error',
      path: 'runtime.default_agent',
      message: 'Missing required field "runtime.default_agent"',
    })
  } else if (typeof runtime.default_agent !== 'string') {
    issues.push({
      severity: 'error',
      path: 'runtime.default_agent',
      message: '"runtime.default_agent" must be a string',
    })
  }

  if (runtime.turn_timeout !== undefined) {
    if (typeof runtime.turn_timeout !== 'number' || runtime.turn_timeout < 1) {
      issues.push({
        severity: 'error',
        path: 'runtime.turn_timeout',
        message: '"runtime.turn_timeout" must be a positive number (seconds)',
      })
    }
  }

  if (runtime.skill_dirs !== undefined) {
    if (!Array.isArray(runtime.skill_dirs)) {
      issues.push({
        severity: 'error',
        path: 'runtime.skill_dirs',
        message: '"runtime.skill_dirs" must be an array of paths',
      })
    } else {
      for (let i = 0; i < runtime.skill_dirs.length; i++) {
        if (typeof runtime.skill_dirs[i] !== 'string') {
          issues.push({
            severity: 'error',
            path: `runtime.skill_dirs[${i}]`,
            message: 'Each skill_dirs entry must be a string path',
          })
        }
      }
    }
  }

  if (runtime.heartbeats !== undefined) {
    if (!Array.isArray(runtime.heartbeats)) {
      issues.push({
        severity: 'error',
        path: 'runtime.heartbeats',
        message: '"runtime.heartbeats" must be an array',
      })
    } else {
      for (let i = 0; i < runtime.heartbeats.length; i++) {
        validateHeartbeat(runtime.heartbeats[i], i, issues)
      }
    }
  }

  if (runtime.coding_pipeline !== undefined) {
    if (typeof runtime.coding_pipeline !== 'object' || Array.isArray(runtime.coding_pipeline)) {
      issues.push({
        severity: 'error',
        path: 'runtime.coding_pipeline',
        message: '"runtime.coding_pipeline" must be an object',
      })
    } else {
      validateCodingPipeline(runtime.coding_pipeline as Record<string, unknown>, issues)
    }
  }
}

function validateHeartbeat(hb: unknown, index: number, issues: ValidationIssue[]): void {
  const path = `runtime.heartbeats[${index}]`

  if (!hb || typeof hb !== 'object' || Array.isArray(hb)) {
    issues.push({ severity: 'error', path, message: 'Each heartbeat entry must be an object' })
    return
  }

  const entry = hb as Record<string, unknown>

  for (const key of Object.keys(entry)) {
    if (!KNOWN_HEARTBEAT_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `${path}.${key}`,
        message: `Unknown heartbeat key "${key}"`,
      })
    }
  }

  if (!entry.agent || typeof entry.agent !== 'string') {
    issues.push({
      severity: 'error',
      path: `${path}.agent`,
      message: 'Heartbeat requires a string "agent" field',
    })
  }

  if (!entry.schedule) {
    issues.push({
      severity: 'error',
      path: `${path}.schedule`,
      message: 'Heartbeat requires a "schedule" field (e.g., "30m", "1h")',
    })
  }

  if (!entry.prompt || typeof entry.prompt !== 'string') {
    issues.push({
      severity: 'error',
      path: `${path}.prompt`,
      message: 'Heartbeat requires a string "prompt" field',
    })
  }

  if (entry.quiet_hours !== undefined) {
    if (typeof entry.quiet_hours !== 'object' || Array.isArray(entry.quiet_hours)) {
      issues.push({
        severity: 'error',
        path: `${path}.quiet_hours`,
        message: '"quiet_hours" must be an object with "start" and "end" (0-23)',
      })
    } else {
      const qh = entry.quiet_hours as Record<string, unknown>
      if (typeof qh.start !== 'number' || qh.start < 0 || qh.start > 23) {
        issues.push({
          severity: 'error',
          path: `${path}.quiet_hours.start`,
          message: '"quiet_hours.start" must be a number 0-23',
        })
      }
      if (typeof qh.end !== 'number' || qh.end < 0 || qh.end > 23) {
        issues.push({
          severity: 'error',
          path: `${path}.quiet_hours.end`,
          message: '"quiet_hours.end" must be a number 0-23',
        })
      }
    }
  }
}

function validateCodingPipeline(
  pipeline: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(pipeline)) {
    if (!KNOWN_PIPELINE_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `runtime.coding_pipeline.${key}`,
        message: `Unknown coding_pipeline key "${key}"`,
      })
    }
  }

  if (pipeline.max_build_loops !== undefined) {
    if (typeof pipeline.max_build_loops !== 'number' || pipeline.max_build_loops < 1) {
      issues.push({
        severity: 'error',
        path: 'runtime.coding_pipeline.max_build_loops',
        message: '"max_build_loops" must be a positive integer',
      })
    }
  }

  if (pipeline.max_validation_loops !== undefined) {
    if (typeof pipeline.max_validation_loops !== 'number' || pipeline.max_validation_loops < 1) {
      issues.push({
        severity: 'error',
        path: 'runtime.coding_pipeline.max_validation_loops',
        message: '"max_validation_loops" must be a positive integer',
      })
    }
  }

  if (pipeline.auto_commit !== undefined && typeof pipeline.auto_commit !== 'boolean') {
    issues.push({
      severity: 'error',
      path: 'runtime.coding_pipeline.auto_commit',
      message: '"auto_commit" must be a boolean',
    })
  }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function validateAgents(
  agents: Record<string, unknown>,
  _fullConfig: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  if (Object.keys(agents).length === 0) {
    issues.push({
      severity: 'error',
      path: 'agents',
      message: '"agents" is empty — define at least one agent',
    })
    return
  }

  for (const [name, agentCfg] of Object.entries(agents)) {
    const path = `agents.${name}`

    if (!agentCfg || typeof agentCfg !== 'object' || Array.isArray(agentCfg)) {
      issues.push({ severity: 'error', path, message: `Agent "${name}" must be an object` })
      continue
    }

    const agent = agentCfg as Record<string, unknown>

    for (const key of Object.keys(agent)) {
      if (!KNOWN_AGENT_KEYS.has(key)) {
        issues.push({
          severity: 'warning',
          path: `${path}.${key}`,
          message: `Unknown agent key "${key}"`,
        })
      }
    }

    if (!agent.provider) {
      issues.push({
        severity: 'error',
        path: `${path}.provider`,
        message: `Agent "${name}" is missing required field "provider"`,
      })
    } else if (typeof agent.provider !== 'string') {
      issues.push({
        severity: 'error',
        path: `${path}.provider`,
        message: `Agent "${name}" provider must be a string`,
      })
    }

    if (agent.default_thinking !== undefined) {
      if (
        typeof agent.default_thinking !== 'string' ||
        !VALID_THINKING_LEVELS.has(agent.default_thinking)
      ) {
        issues.push({
          severity: 'error',
          path: `${path}.default_thinking`,
          message: `Agent "${name}" default_thinking must be one of: ${[...VALID_THINKING_LEVELS].join(', ')} (got "${agent.default_thinking as string}")`,
        })
      }
    }

    // Validate tools filter config
    if (agent.tools !== undefined) {
      if (typeof agent.tools !== 'object' || Array.isArray(agent.tools) || agent.tools === null) {
        issues.push({
          severity: 'error',
          path: `${path}.tools`,
          message: `Agent "${name}" tools must be an object with optional "exclude" and/or "include" arrays`,
        })
      } else {
        const toolsCfg = agent.tools as Record<string, unknown>
        for (const key of Object.keys(toolsCfg)) {
          if (key !== 'exclude' && key !== 'include') {
            issues.push({
              severity: 'warning',
              path: `${path}.tools.${key}`,
              message: `Unknown tools filter key "${key}" — expected "exclude" or "include"`,
            })
          }
        }
        if (toolsCfg.exclude !== undefined && !Array.isArray(toolsCfg.exclude)) {
          issues.push({
            severity: 'error',
            path: `${path}.tools.exclude`,
            message: `Agent "${name}" tools.exclude must be an array of tool names`,
          })
        }
        if (toolsCfg.include !== undefined && !Array.isArray(toolsCfg.include)) {
          issues.push({
            severity: 'error',
            path: `${path}.tools.include`,
            message: `Agent "${name}" tools.include must be an array of tool names`,
          })
        }
        if (toolsCfg.exclude && toolsCfg.include) {
          issues.push({
            severity: 'warning',
            path: `${path}.tools`,
            message: `Agent "${name}" has both "exclude" and "include" — include takes precedence`,
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function validateProviders(
  providers: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  if (Object.keys(providers).length === 0) {
    issues.push({
      severity: 'error',
      path: 'providers',
      message: '"providers" is empty — define at least one provider',
    })
    return
  }

  for (const [name, providerCfg] of Object.entries(providers)) {
    const path = `providers.${name}`

    if (!providerCfg || typeof providerCfg !== 'object' || Array.isArray(providerCfg)) {
      issues.push({ severity: 'error', path, message: `Provider "${name}" must be an object` })
      continue
    }

    const provider = providerCfg as Record<string, unknown>

    if (!KNOWN_PROVIDERS[name]) {
      issues.push({
        severity: 'warning',
        path,
        message: `Unknown provider type "${name}" — make sure a registrar handles it`,
      })
    } else {
      const knownKeys = KNOWN_PROVIDERS[name]
      for (const key of Object.keys(provider)) {
        if (!knownKeys.has(key)) {
          issues.push({
            severity: 'warning',
            path: `${path}.${key}`,
            message: `Unknown key "${key}" for provider type "${name}"`,
          })
        }
      }
    }

    if (!provider.model) {
      issues.push({
        severity: 'error',
        path: `${path}.model`,
        message: `Provider "${name}" is missing required field "model"`,
      })
    } else if (typeof provider.model !== 'string') {
      issues.push({
        severity: 'error',
        path: `${path}.model`,
        message: `Provider "${name}" model must be a string`,
      })
    }

    if (
      (name === 'ollama' || name === 'openai-compat' || name === 'llama-server') &&
      !provider.base_url
    ) {
      issues.push({
        severity: 'error',
        path: `${path}.base_url`,
        message: `Provider "${name}" requires "base_url"`,
      })
    }

    if (provider.api_key && typeof provider.api_key === 'string') {
      const key = provider.api_key
      if (!key.includes('${') && API_KEY_PATTERNS.some((p) => p.test(key))) {
        issues.push({
          severity: 'warning',
          path: `${path}.api_key`,
          message: `Provider "${name}" appears to have a hardcoded API key — use environment variables instead (e.g., \${${name.toUpperCase().replace('-', '_')}_API_KEY})`,
        })
      }
    }

    if (provider.max_tokens !== undefined) {
      if (typeof provider.max_tokens !== 'number' || provider.max_tokens < 1) {
        issues.push({
          severity: 'error',
          path: `${path}.max_tokens`,
          message: `Provider "${name}" max_tokens must be a positive number`,
        })
      }
    }

    if (provider.temperature !== undefined) {
      if (
        typeof provider.temperature !== 'number' ||
        provider.temperature < 0 ||
        provider.temperature > 2
      ) {
        issues.push({
          severity: 'warning',
          path: `${path}.temperature`,
          message: `Provider "${name}" temperature ${provider.temperature as number} is outside typical range (0-2)`,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export function validateChannels(
  channels: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  for (const [name, channelCfg] of Object.entries(channels)) {
    const path = `channels.${name}`

    if (!channelCfg || typeof channelCfg !== 'object' || Array.isArray(channelCfg)) {
      issues.push({ severity: 'error', path, message: `Channel "${name}" must be an object` })
      continue
    }

    const channel = channelCfg as Record<string, unknown>

    if (!KNOWN_CHANNELS[name]) {
      issues.push({
        severity: 'warning',
        path,
        message: `Unknown channel type "${name}" — make sure a registrar handles it`,
      })
    } else {
      const knownKeys = KNOWN_CHANNELS[name]
      for (const key of Object.keys(channel)) {
        if (!knownKeys.has(key)) {
          issues.push({
            severity: 'warning',
            path: `${path}.${key}`,
            message: `Unknown key "${key}" for channel type "${name}"`,
          })
        }
      }
    }

    if (channel.bot_token && typeof channel.bot_token === 'string') {
      const token = channel.bot_token
      if (!token.includes('${') && token.length > 20) {
        issues.push({
          severity: 'warning',
          path: `${path}.bot_token`,
          message: `Channel "${name}" appears to have a hardcoded bot token — use environment variables instead`,
        })
      }
    }

    if (name === 'discord' && channel.channel_bindings !== undefined) {
      if (typeof channel.channel_bindings !== 'object' || Array.isArray(channel.channel_bindings)) {
        issues.push({
          severity: 'error',
          path: `${path}.channel_bindings`,
          message: '"channel_bindings" must be an object mapping channel IDs to agent IDs',
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function validateMemory(memory: Record<string, unknown>, issues: ValidationIssue[]): void {
  for (const key of Object.keys(memory)) {
    if (key !== 'postgres') {
      issues.push({
        severity: 'warning',
        path: `memory.${key}`,
        message: `Unknown memory backend "${key}" — only "postgres" is currently supported`,
      })
    }
  }

  if (memory.postgres) {
    if (typeof memory.postgres !== 'object' || Array.isArray(memory.postgres)) {
      issues.push({
        severity: 'error',
        path: 'memory.postgres',
        message: '"memory.postgres" must be an object',
      })
    } else {
      const pg = memory.postgres as Record<string, unknown>
      for (const key of Object.keys(pg)) {
        if (!KNOWN_MEMORY_POSTGRES_KEYS.has(key)) {
          issues.push({
            severity: 'warning',
            path: `memory.postgres.${key}`,
            message: `Unknown memory.postgres key "${key}"`,
          })
        }
      }
    }
  }
}
