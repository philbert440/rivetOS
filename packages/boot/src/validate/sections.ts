/**
 * Section validators — runtime, agents, providers, channels, memory.
 */

import {
  KNOWN_RUNTIME_KEYS,
  KNOWN_AGENT_KEYS,
  REMOVED_RUNTIME_KEYS,
  REMOVED_AGENT_KEYS,
  REMOVED_PROVIDERS,
  VALID_THINKING_LEVELS,
  KNOWN_PROVIDERS,
  KNOWN_CHANNELS,
  KNOWN_HEARTBEAT_KEYS,
  KNOWN_MEMORY_POSTGRES_KEYS,
  REMOVED_MEMORY_POSTGRES_KEYS,
  KNOWN_DEN_KEYS,
  KNOWN_DEN_TERMINAL_KEYS,
  KNOWN_TASKS_KEYS,
  DEN_LOOPBACK_HOSTS,
  API_KEY_PATTERNS,
  type ValidationIssue,
} from './types.js'

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export function validateRuntime(runtime: Record<string, unknown>, issues: ValidationIssue[]): void {
  for (const key of Object.keys(runtime)) {
    const removedMsg = REMOVED_RUNTIME_KEYS.get(key)
    if (removedMsg) {
      issues.push({
        severity: 'error',
        path: `runtime.${key}`,
        message: removedMsg,
      })
      continue
    }
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
      const removedMsg = REMOVED_AGENT_KEYS.get(key)
      if (removedMsg) {
        issues.push({
          severity: 'error',
          path: `${path}.${key}`,
          message: removedMsg,
        })
        continue
      }
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

    const removedMsg = REMOVED_PROVIDERS.get(name)
    if (removedMsg) {
      issues.push({ severity: 'error', path, message: removedMsg })
      continue
    }

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

    if ((name === 'ollama' || name === 'vllm' || name === 'llama-server') && !provider.base_url) {
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
        const removedMsg = REMOVED_MEMORY_POSTGRES_KEYS.get(key)
        if (removedMsg) {
          issues.push({
            severity: 'error',
            path: `memory.postgres.${key}`,
            message: removedMsg,
          })
        } else if (!KNOWN_MEMORY_POSTGRES_KEYS.has(key)) {
          issues.push({
            severity: 'warning',
            path: `memory.postgres.${key}`,
            message: `Unknown memory.postgres key "${key}"`,
          })
        }
      }
      if (pg.delegation_tracking !== undefined && typeof pg.delegation_tracking !== 'boolean') {
        issues.push({
          severity: 'error',
          path: 'memory.postgres.delegation_tracking',
          message: '"delegation_tracking" must be a boolean (true/false)',
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mesh (mTLS Migration — Phase 0.5)
// TLS is mandatory when mesh.enabled; fail fast with clear error if tls not set.
// mesh.secret is dead — mTLS is the sole agent-channel auth. The key is still
// accepted (with a warning) so existing configs don't break on upgrade.
// ---------------------------------------------------------------------------

export function validateMesh(mesh: Record<string, unknown>, issues: ValidationIssue[]): void {
  const path = 'mesh'

  if (typeof mesh.enabled === 'boolean' && mesh.enabled) {
    if (mesh.tls === undefined || mesh.tls === false) {
      issues.push({
        severity: 'error',
        path: `${path}.tls`,
        message:
          'mesh.enabled requires tls configuration. TLS is mandatory when mesh is enabled — no plaintext fallback is allowed. Set tls: true (uses conventional /rivet-shared/rivet-ca/ paths) or provide a MeshTlsConfig object.',
      })
    }

    if (typeof mesh.node_name !== 'string' || mesh.node_name.trim() === '') {
      issues.push({
        severity: 'error',
        path: `${path}.node_name`,
        message: 'mesh.node_name is required when mesh.enabled is true (used as CN for node cert)',
      })
    }
  }

  if (mesh.tls !== undefined) {
    if (
      typeof mesh.tls !== 'boolean' &&
      (typeof mesh.tls !== 'object' || Array.isArray(mesh.tls) || mesh.tls === null)
    ) {
      issues.push({
        severity: 'error',
        path: `${path}.tls`,
        message:
          'mesh.tls must be boolean (true for defaults) or a MeshTlsConfig object { ca_path?, cert_path?, key_path? }',
      })
    }
  }

  if (mesh.advertise_host !== undefined) {
    if (typeof mesh.advertise_host !== 'string' || mesh.advertise_host.trim() === '') {
      issues.push({
        severity: 'error',
        path: `${path}.advertise_host`,
        message: 'mesh.advertise_host must be a non-empty string (IP or DNS name)',
      })
    } else if (/[\s;&|`$<>()'"\\]/.test(mesh.advertise_host)) {
      // It flows into mesh.json `host`, which `rivetos update --mesh`
      // interpolates into `ssh <user>@<host>` — reject shell metacharacters.
      issues.push({
        severity: 'error',
        path: `${path}.advertise_host`,
        message: 'mesh.advertise_host contains shell-unsafe characters',
      })
    }
  }

  if (mesh.secret !== undefined) {
    issues.push({
      severity: 'warning',
      path: `${path}.secret`,
      message:
        'mesh.secret is ignored — agent-channel authentication is mTLS only. Remove this key from your config.',
    })
  }
}

// ---------------------------------------------------------------------------
// Den — rivet-den per-node server (deploy + mesh advertising)
//
// The terminal token rule mirrors den-server's own startup security gate
// (services/den-server/src/server.ts): terminals spawn shells as the service
// user, so exposing them off-loopback without a bearer token would hang an
// unauthenticated shell on the network. den-server force-disables terminals
// at runtime in that state; we reject the config here so the mistake is
// caught at config-validate/deploy time, not at first click.
// ---------------------------------------------------------------------------

export function validateDen(den: Record<string, unknown>, issues: ValidationIssue[]): void {
  const path = 'den'

  for (const key of Object.keys(den)) {
    if (!KNOWN_DEN_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `${path}.${key}`,
        message: `Unknown den key "${key}"`,
      })
    }
  }

  if (den.enabled !== undefined && typeof den.enabled !== 'boolean') {
    issues.push({
      severity: 'error',
      path: `${path}.enabled`,
      message: '"den.enabled" must be a boolean',
    })
  }

  if (den.host !== undefined && (typeof den.host !== 'string' || den.host.trim() === '')) {
    issues.push({
      severity: 'error',
      path: `${path}.host`,
      message: '"den.host" must be a non-empty string (bind address, e.g. 127.0.0.1 or 0.0.0.0)',
    })
  }

  if (den.port !== undefined) {
    if (
      typeof den.port !== 'number' ||
      !Number.isInteger(den.port) ||
      den.port < 1 ||
      den.port > 65535
    ) {
      issues.push({
        severity: 'error',
        path: `${path}.port`,
        message: '"den.port" must be an integer between 1 and 65535',
      })
    }
  }

  if (den.token !== undefined && typeof den.token !== 'string') {
    issues.push({
      severity: 'error',
      path: `${path}.token`,
      message: '"den.token" must be a string',
    })
  }

  let terminalEnabled = false
  let terminalOpen = false
  if (den.terminal !== undefined) {
    if (typeof den.terminal !== 'object' || Array.isArray(den.terminal) || den.terminal === null) {
      issues.push({
        severity: 'error',
        path: `${path}.terminal`,
        message: '"den.terminal" must be an object (e.g. { enabled: true })',
      })
    } else {
      const terminal = den.terminal as Record<string, unknown>
      for (const key of Object.keys(terminal)) {
        if (!KNOWN_DEN_TERMINAL_KEYS.has(key)) {
          issues.push({
            severity: 'warning',
            path: `${path}.terminal.${key}`,
            message: `Unknown den.terminal key "${key}"`,
          })
        }
      }
      if (terminal.enabled !== undefined && typeof terminal.enabled !== 'boolean') {
        issues.push({
          severity: 'error',
          path: `${path}.terminal.enabled`,
          message: '"den.terminal.enabled" must be a boolean',
        })
      }
      if (terminal.open !== undefined && typeof terminal.open !== 'boolean') {
        issues.push({
          severity: 'error',
          path: `${path}.terminal.open`,
          message: '"den.terminal.open" must be a boolean',
        })
      }
      terminalEnabled = terminal.enabled === true
      terminalOpen = terminal.open === true
    }
  }

  for (const key of ['packs_dir', 'static_dir'] as const) {
    if (den[key] !== undefined && (typeof den[key] !== 'string' || den[key].trim() === '')) {
      issues.push({
        severity: 'error',
        path: `${path}.${key}`,
        message: `"den.${key}" must be a non-empty string path`,
      })
    }
  }

  // SECURITY GATE — token required when terminals are exposed off loopback.
  // Only enforced when den.enabled (a disabled section deploys nothing);
  // den-server's own runtime gate remains the backstop.
  const host = typeof den.host === 'string' ? den.host.trim() : '127.0.0.1'
  const hasToken = typeof den.token === 'string' && den.token.length > 0
  if (
    den.enabled === true &&
    terminalEnabled &&
    !terminalOpen &&
    !DEN_LOOPBACK_HOSTS.has(host) &&
    !hasToken
  ) {
    issues.push({
      severity: 'error',
      path: `${path}.token`,
      message:
        '"den.token" is required when den.terminal.enabled is true and den.host is not loopback ' +
        '(127.0.0.1/::1/localhost) — an exposed token-less terminal would hang an unauthenticated ' +
        'shell on the network. Set den.token, bind den.host to loopback, or explicitly opt out ' +
        'with den.terminal.open: true on a trusted private network.',
    })
  }
}

// ---------------------------------------------------------------------------
// Tasks — durable task engine (ros_tasks + embedded runner, phase 1).
// Default enabled: with zero rows the engine is inert.
// ---------------------------------------------------------------------------

export function validateTasks(tasks: Record<string, unknown>, issues: ValidationIssue[]): void {
  const path = 'tasks'

  for (const key of Object.keys(tasks)) {
    if (!KNOWN_TASKS_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `${path}.${key}`,
        message: `Unknown tasks key "${key}"`,
      })
    }
  }

  if (tasks.enabled !== undefined && typeof tasks.enabled !== 'boolean') {
    issues.push({
      severity: 'error',
      path: `${path}.enabled`,
      message: '"tasks.enabled" must be a boolean',
    })
  }
}
