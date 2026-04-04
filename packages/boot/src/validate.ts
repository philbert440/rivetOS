/**
 * Config Validation — schema validation with helpful error messages.
 *
 * Zero external dependencies. Validates the parsed YAML config object
 * and returns structured errors/warnings before anything tries to boot.
 *
 * Design:
 * - Errors = fatal, won't boot
 * - Warnings = suspicious but not blocking
 * - Each issue includes a path (e.g., "agents.grok.provider") and a human-readable message
 */

export type Severity = 'error' | 'warning'

export interface ValidationIssue {
  severity: Severity
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** Known top-level config sections */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'runtime',
  'agents',
  'providers',
  'channels',
  'memory',
  'mcp',
])

/** Known runtime keys */
const KNOWN_RUNTIME_KEYS = new Set([
  'workspace',
  'default_agent',
  'max_tool_iterations',
  'skill_dirs',
  'heartbeats',
  'coding_pipeline',
  'fallbacks',
  'safety',
  'auto_actions',
])

/** Known agent keys */
const KNOWN_AGENT_KEYS = new Set(['provider', 'default_thinking', 'fallbacks'])

/** Valid thinking levels */
const VALID_THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high'])

/** Known provider types and their expected keys */
const KNOWN_PROVIDERS: Record<string, Set<string>> = {
  anthropic: new Set(['model', 'max_tokens', 'api_key']),
  xai: new Set(['model', 'max_tokens', 'api_key', 'temperature']),
  google: new Set(['model', 'max_tokens', 'api_key']),
  ollama: new Set(['model', 'base_url', 'num_ctx', 'temperature', 'keep_alive']),
  'openai-compat': new Set([
    'model',
    'base_url',
    'api_key',
    'max_tokens',
    'temperature',
    'top_p',
    'repeat_penalty',
    'name',
  ]),
  'llama-server': new Set([
    'model',
    'base_url',
    'api_key',
    'max_tokens',
    'temperature',
    'top_p',
    'repeat_penalty',
    'name',
  ]),
}

/** Known channel types and their expected keys */
const KNOWN_CHANNELS: Record<string, Set<string>> = {
  telegram: new Set(['bot_token', 'owner_id', 'allowed_users', 'agent']),
  discord: new Set([
    'bot_token',
    'owner_id',
    'allowed_guilds',
    'allowed_channels',
    'allowed_users',
    'channel_bindings',
    'mention_only',
  ]),
  voice: new Set([
    'bot_token',
    'xai_api_key',
    'guild_id',
    'allowed_users',
    'voice',
    'instructions',
    'transcript_dir',
  ]),
  'voice-discord': new Set([
    'bot_token',
    'xai_api_key',
    'guild_id',
    'allowed_users',
    'voice',
    'instructions',
    'transcript_dir',
  ]),
}

/** Known heartbeat keys */
const KNOWN_HEARTBEAT_KEYS = new Set([
  'agent',
  'schedule',
  'timezone',
  'prompt',
  'output_channel',
  'quiet_hours',
])

/** Known coding_pipeline keys */
const KNOWN_PIPELINE_KEYS = new Set([
  'builder_agent',
  'validator_agent',
  'max_build_loops',
  'max_validation_loops',
  'auto_commit',
])

/** Known memory.postgres keys */
const KNOWN_MEMORY_POSTGRES_KEYS = new Set([
  'connection_string',
  'embed_endpoint',
  'compactor_endpoint',
  'compactor_model',
])

/** Env var patterns that suggest an API key was pasted directly */
const API_KEY_PATTERNS = [
  /^sk-[a-zA-Z0-9-]{20,}$/, // Anthropic / OpenAI
  /^xai-[a-zA-Z0-9]{20,}$/, // xAI
  /^AIza[a-zA-Z0-9_-]{30,}$/, // Google
  /^[a-f0-9]{64,}$/, // Generic hex key
]

/**
 * Validate a parsed config object. Returns structured errors and warnings.
 */
export function validateConfig(config: unknown): ValidationResult {
  const issues: ValidationIssue[] = []

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    issues.push({
      severity: 'error',
      path: '',
      message: 'Config must be a YAML object (got ' + typeof config + ')',
    })
    return toResult(issues)
  }

  const cfg = config as Record<string, unknown>

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: key,
        message: `Unknown top-level key "${key}" — will be ignored`,
      })
    }
  }

  // === runtime (required) ===
  if (!cfg.runtime) {
    issues.push({
      severity: 'error',
      path: 'runtime',
      message: 'Missing required section "runtime"',
    })
  } else if (typeof cfg.runtime !== 'object' || Array.isArray(cfg.runtime)) {
    issues.push({ severity: 'error', path: 'runtime', message: '"runtime" must be an object' })
  } else {
    validateRuntime(cfg.runtime as Record<string, unknown>, issues)
  }

  // === agents (required) ===
  if (!cfg.agents) {
    issues.push({
      severity: 'error',
      path: 'agents',
      message: 'Missing required section "agents" — define at least one agent',
    })
  } else if (typeof cfg.agents !== 'object' || Array.isArray(cfg.agents)) {
    issues.push({
      severity: 'error',
      path: 'agents',
      message: '"agents" must be an object mapping agent names to their config',
    })
  } else {
    validateAgents(cfg.agents as Record<string, unknown>, cfg, issues)
  }

  // === providers (required) ===
  if (!cfg.providers) {
    issues.push({
      severity: 'error',
      path: 'providers',
      message: 'Missing required section "providers" — define at least one provider',
    })
  } else if (typeof cfg.providers !== 'object' || Array.isArray(cfg.providers)) {
    issues.push({
      severity: 'error',
      path: 'providers',
      message: '"providers" must be an object mapping provider names to their config',
    })
  } else {
    validateProviders(cfg.providers as Record<string, unknown>, issues)
  }

  // === channels (optional but common) ===
  if (cfg.channels) {
    if (typeof cfg.channels !== 'object' || Array.isArray(cfg.channels)) {
      issues.push({ severity: 'error', path: 'channels', message: '"channels" must be an object' })
    } else {
      validateChannels(cfg.channels as Record<string, unknown>, issues)
    }
  }

  // === memory (optional) ===
  if (cfg.memory) {
    if (typeof cfg.memory !== 'object' || Array.isArray(cfg.memory)) {
      issues.push({ severity: 'error', path: 'memory', message: '"memory" must be an object' })
    } else {
      validateMemory(cfg.memory as Record<string, unknown>, issues)
    }
  }

  // === Cross-references ===
  validateCrossReferences(cfg, issues)

  return toResult(issues)
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validateRuntime(runtime: Record<string, unknown>, issues: ValidationIssue[]): void {
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

  if (runtime.max_tool_iterations !== undefined) {
    if (typeof runtime.max_tool_iterations !== 'number' || runtime.max_tool_iterations < 1) {
      issues.push({
        severity: 'error',
        path: 'runtime.max_tool_iterations',
        message: '"runtime.max_tool_iterations" must be a positive integer',
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

function validateAgents(
  agents: Record<string, unknown>,
  fullConfig: Record<string, unknown>,
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
  }
}

function validateProviders(providers: Record<string, unknown>, issues: ValidationIssue[]): void {
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

function validateChannels(channels: Record<string, unknown>, issues: ValidationIssue[]): void {
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

function validateMemory(memory: Record<string, unknown>, issues: ValidationIssue[]): void {
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

// ---------------------------------------------------------------------------
// Cross-reference validation
// ---------------------------------------------------------------------------

function validateCrossReferences(cfg: Record<string, unknown>, issues: ValidationIssue[]): void {
  const agents = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>
  const providers = (cfg.providers ?? {}) as Record<string, unknown>
  const runtime = (cfg.runtime ?? {}) as Record<string, unknown>

  const providerIds = new Set(Object.keys(providers))
  const agentIds = new Set(Object.keys(agents))

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

  if (typeof runtime.default_agent === 'string' && runtime.default_agent) {
    if (!agentIds.has(runtime.default_agent)) {
      issues.push({
        severity: 'error',
        path: 'runtime.default_agent',
        message: `Default agent "${runtime.default_agent}" is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
      })
    }
  }

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

  const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>
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

  const telegram = channels.telegram
  if (telegram && typeof telegram.agent === 'string' && !agentIds.has(telegram.agent)) {
    issues.push({
      severity: 'error',
      path: 'channels.telegram.agent',
      message: `Telegram agent "${telegram.agent}" is not defined in [agents]. Available: ${[...agentIds].join(', ') || '(none)'}`,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResult(issues: ValidationIssue[]): ValidationResult {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Format validation result as a human-readable string for CLI output.
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = []

  if (result.errors.length > 0) {
    lines.push('Errors:')
    for (const err of result.errors) {
      lines.push(`  ❌ ${err.path ? `[${err.path}] ` : ''}${err.message}`)
    }
  }

  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Warnings:')
    for (const warn of result.warnings) {
      lines.push(`  ⚠️  ${warn.path ? `[${warn.path}] ` : ''}${warn.message}`)
    }
  }

  if (result.valid && result.warnings.length === 0) {
    lines.push('✅ Config is valid.')
  } else if (result.valid) {
    lines.push('')
    lines.push(
      `✅ Config is valid (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}).`,
    )
  } else {
    lines.push('')
    lines.push(
      `❌ Config has ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}${result.warnings.length > 0 ? ` and ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}` : ''}.`,
    )
  }

  return lines.join('\n')
}
