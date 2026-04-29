/**
 * Config Loader — reads YAML config, validates schema, resolves env vars, returns typed config.
 */

import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { logger } from '@rivetos/core'
import { validateConfig, formatValidationResult } from './validate/index.js'

const log = logger('Config')

// ---------------------------------------------------------------------------
// Config Types
// ---------------------------------------------------------------------------

export interface RivetConfig {
  runtime: RuntimeSection
  agents: Record<string, AgentSection>
  providers: Record<string, Record<string, unknown>>
  channels: Record<string, Record<string, unknown>>
  memory?: Record<string, Record<string, unknown>>
  mcp?: McpSection
  /**
   * Transport plugins — inbound surfaces that expose runtime tools to
   * external clients. Each key matches a discovered transport plugin name
   * (e.g. `mcp` → @rivetos/mcp-server). Presence enables the transport.
   */
  transports?: Record<string, Record<string, unknown>>
  /** Deployment configuration — optional. When present, drives containerized deployment. */
  deployment?: DeploymentSection
  /** Multi-agent mesh configuration — cross-instance delegation */
  mesh?: MeshSection
  /**
   * Explicit plugin list — npm package names of rivetos plugins to load.
   * Authoritative in production (flat install): missing entries fail-fast.
   * Additive in workspace mode: union'd with workspace `plugins/<category>/*`
   * and `node_modules/*` scans, deduped by package name.
   */
  plugins?: string[]
}

// ---------------------------------------------------------------------------
// Mesh Section (YAML shape — snake_case)
// ---------------------------------------------------------------------------

export interface MeshSection {
  enabled?: boolean
  node_name?: string
  secret?: string
  /** mTLS configuration for agent-channel.
   * true = use default paths derived from node_name
   * object = override paths */
  tls?:
    | boolean
    | {
        ca_path?: string
        cert_path?: string
        key_path?: string
      }
  /** Port for the agent channel HTTP server (default: 3000) */
  agent_channel_port?: number
  /** Shared storage directory for mesh.json (default: /rivet-shared) */
  storage_dir?: string
  discovery?: {
    mode: 'seed' | 'mdns' | 'static'
    seed_host?: string
    seed_port?: number
  }
  heartbeat_interval_ms?: number
  stale_threshold_ms?: number
  peers?: Array<{
    name: string
    host: string
    port?: number
  }>
}

// ---------------------------------------------------------------------------
// Deployment Section (YAML shape — snake_case)
// ---------------------------------------------------------------------------

export interface DeploymentSection {
  target: 'docker' | 'proxmox' | 'kubernetes' | 'manual'
  datahub?: {
    postgres?: boolean
    postgres_version?: string
    shared_storage?: boolean
    shared_mount_path?: string
  }
  image?: {
    registry?: string
    agent_image?: string
    datahub_image?: string
    tag?: string
    build_from_source?: boolean
  }
  docker?: {
    network?: string
    postgres_port?: number
    project_name?: string
  }
  proxmox?: {
    api_url?: string
    nodes?: Array<{
      name: string
      host?: string
      role: 'datahub' | 'agents' | 'both'
      ctid_start?: number
    }>
    network?: {
      bridge?: string
      subnet?: string
      gateway?: string
    }
  }
  kubernetes?: {
    namespace?: string
    storage_class?: string
    resources?: {
      cpu?: string
      memory?: string
    }
  }
}

export interface RuntimeSection {
  workspace: string
  default_agent: string
  /** Turn wall-clock timeout in seconds (default: 900) */
  turn_timeout?: number
  /** Context management config */
  context?: {
    soft_nudge_pct?: number[]
    hard_nudge_pct?: number
  }
  skill_dirs?: string[]
  /** Additional directories to scan for plugins (relative to monorepo root) */
  plugin_dirs?: string[]
  heartbeats?: HeartbeatSection[]
  coding_pipeline?: CodingPipelineSection
  fallbacks?: FallbackSection[]
  safety?: SafetySection
  auto_actions?: AutoActionsSection
}

export interface AgentSection {
  provider: string
  /** Model override — use a specific model from this provider instead of the provider's default.
   *  Enables multiple agents to share one provider with different models. */
  model?: string
  default_thinking?: string
  fallbacks?: string[]
  /** Whether this agent uses a local/self-hosted provider (free tokens → extended context) */
  local?: boolean
  /** Tool filtering for when this agent runs as a delegate or sub-agent */
  tools?: {
    exclude?: string[]
    include?: string[]
  }
}

export interface HeartbeatSection {
  agent: string
  schedule: string
  timezone?: string
  prompt: string
  output_channel?: string
  quiet_hours?: { start: number; end: number }
}

export interface CodingPipelineSection {
  builder_agent?: string
  validator_agent?: string
  max_build_loops?: number
  max_validation_loops?: number
  auto_commit?: boolean
}

export interface FallbackSection {
  providerId: string
  fallbacks: string[]
}

export interface SafetySection {
  shellDanger?: boolean
  workspaceFence?: { allowedDirs: string[]; alwaysAllow?: string[]; tools?: string[] }
  audit?: boolean
}

export interface AutoActionsSection {
  format?: boolean
  lint?: boolean
  test?: boolean
  gitCheck?: boolean
}

export interface McpSection {
  servers?: Record<string, McpServerConfig>
}

export interface McpServerConfig {
  transport: 'stdio' | 'streamable-http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  toolPrefix?: string
  connectTimeout?: number
  autoReconnect?: boolean
}

// ---------------------------------------------------------------------------
// Config Error
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  constructor(public readonly formatted: string) {
    super('Config validation failed')
    this.name = 'ConfigValidationError'
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and parse YAML config file.
 * Validates schema (on raw parsed YAML, before env resolution).
 * Resolves ${ENV_VAR} references in string values.
 * Throws ConfigValidationError if validation fails.
 */
export async function loadConfig(path: string): Promise<RivetConfig> {
  const raw = await readFile(path, 'utf-8')
  const parsed: unknown = parseYaml(raw)

  const result = validateConfig(parsed)

  if (result.warnings.length > 0) {
    for (const warn of result.warnings) {
      log.warn(`${warn.path ? `[${warn.path}] ` : ''}${warn.message}`)
    }
  }

  if (!result.valid) {
    const formatted = formatValidationResult(result)
    log.error(`Validation failed:\n${formatted}`)
    throw new ConfigValidationError(formatted)
  }

  return resolveEnvVars(parsed as RivetConfig)
}

// ---------------------------------------------------------------------------
// Env Var Resolution
// ---------------------------------------------------------------------------

function resolveEnvVars<T>(obj: T): T {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      return process.env[name] ?? ''
    }) as T
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars) as T
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value)
    }
    return result as T
  }
  return obj
}
