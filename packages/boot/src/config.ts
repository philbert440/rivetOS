/**
 * Config Loader — reads YAML config, validates schema, resolves env vars, returns typed config.
 */

import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { validateConfig, formatValidationResult } from './validate.js'

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
}

export interface RuntimeSection {
  workspace: string
  default_agent: string
  max_tool_iterations?: number
  skill_dirs?: string[]
  heartbeats?: HeartbeatSection[]
  coding_pipeline?: CodingPipelineSection
  fallbacks?: FallbackSection[]
  safety?: SafetySection
  auto_actions?: AutoActionsSection
}

export interface AgentSection {
  provider: string
  default_thinking?: string
  fallbacks?: string[]
  /** Whether this agent uses a local/self-hosted provider (free tokens → extended context) */
  local?: boolean
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
  const parsed = parseYaml(raw)

  const result = validateConfig(parsed)

  if (result.warnings.length > 0) {
    for (const warn of result.warnings) {
      console.warn(`[RivetOS] [WARN] [Config] ${warn.path ? `[${warn.path}] ` : ''}${warn.message}`)
    }
  }

  if (!result.valid) {
    const formatted = formatValidationResult(result)
    console.error(`[RivetOS] [ERROR] [Config] Validation failed:\n${formatted}`)
    throw new ConfigValidationError(formatted)
  }

  return resolveEnvVars(parsed as RivetConfig)
}

// ---------------------------------------------------------------------------
// Env Var Resolution
// ---------------------------------------------------------------------------

function resolveEnvVars<T>(obj: T): T {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => {
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
