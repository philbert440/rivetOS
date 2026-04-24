/**
 * Validation types and known-key registries.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Known key registries
// ---------------------------------------------------------------------------

export const KNOWN_TOP_LEVEL_KEYS = new Set([
  'runtime',
  'agents',
  'providers',
  'channels',
  'memory',
  'mcp',
  'deployment',
  'mesh',
])

export const KNOWN_DEPLOYMENT_KEYS = new Set([
  'target',
  'datahub',
  'image',
  'docker',
  'proxmox',
  'kubernetes',
])

export const VALID_DEPLOYMENT_TARGETS = new Set(['docker', 'proxmox', 'kubernetes', 'manual'])

export const KNOWN_DEPLOYMENT_DATAHUB_KEYS = new Set([
  'postgres',
  'postgres_version',
  'shared_storage',
  'shared_mount_path',
])

export const KNOWN_DEPLOYMENT_IMAGE_KEYS = new Set([
  'registry',
  'agent_image',
  'datahub_image',
  'tag',
  'build_from_source',
])

export const KNOWN_DEPLOYMENT_DOCKER_KEYS = new Set(['network', 'postgres_port', 'project_name'])

export const KNOWN_DEPLOYMENT_PROXMOX_KEYS = new Set(['api_url', 'nodes', 'network'])

export const KNOWN_DEPLOYMENT_PROXMOX_NODE_KEYS = new Set(['name', 'host', 'role', 'ctid_start'])

export const VALID_PROXMOX_NODE_ROLES = new Set(['datahub', 'agents', 'both'])

export const KNOWN_DEPLOYMENT_PROXMOX_NETWORK_KEYS = new Set(['bridge', 'subnet', 'gateway'])

export const KNOWN_DEPLOYMENT_K8S_KEYS = new Set(['namespace', 'storage_class', 'resources'])

export const KNOWN_RUNTIME_KEYS = new Set([
  'workspace',
  'default_agent',
  'turn_timeout',
  'context',
  'skill_dirs',
  'plugin_dirs',
  'heartbeats',
  'coding_pipeline',
  'fallbacks',
  'safety',
  'auto_actions',
])

export const KNOWN_AGENT_KEYS = new Set([
  'provider',
  'model',
  'default_thinking',
  'fallbacks',
  'local',
  'tools',
])

export const VALID_THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high'])

export const KNOWN_PROVIDERS: Partial<Record<string, Set<string>>> = {
  anthropic: new Set(['model', 'max_tokens', 'api_key', 'context_window', 'max_output_tokens']),
  'claude-cli': new Set([
    'model',
    'binary',
    'tools',
    'effort',
    'permission_mode',
    'exclude_dynamic_sections',
    'append_system_prompt',
    'cwd',
    'timeout_ms',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
  xai: new Set([
    'model',
    'max_tokens',
    'api_key',
    'temperature',
    'context_window',
    'max_output_tokens',
  ]),
  google: new Set(['model', 'max_tokens', 'api_key', 'context_window', 'max_output_tokens']),
  ollama: new Set([
    'model',
    'base_url',
    'num_ctx',
    'temperature',
    'keep_alive',
    'context_window',
    'max_output_tokens',
  ]),
  'llama-server': new Set([
    'model',
    'base_url',
    'api_key',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'typical_p',
    'repeat_penalty',
    'repeat_last_n',
    'presence_penalty',
    'frequency_penalty',
    'mirostat',
    'mirostat_tau',
    'mirostat_eta',
    'seed',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
  'openai-compat': new Set([
    'model',
    'base_url',
    'api_key',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'default_tool_choice',
    'verify_model_on_init',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
}

export const KNOWN_CHANNELS: Partial<Record<string, Set<string>>> = {
  telegram: new Set(['bot_token', 'owner_id', 'allowed_users', 'agent']),
  discord: new Set([
    'bot_token',
    'owner_id',
    'allowed_guilds',
    'allowed_channels',
    'allowed_users',
    'channel_bindings',
    'mention_only',
    'mention_only_channels',
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

export const KNOWN_HEARTBEAT_KEYS = new Set([
  'agent',
  'schedule',
  'timezone',
  'prompt',
  'output_channel',
  'quiet_hours',
])

export const KNOWN_PIPELINE_KEYS = new Set([
  'builder_agent',
  'validator_agent',
  'max_build_loops',
  'max_validation_loops',
  'auto_commit',
])

export const KNOWN_MEMORY_POSTGRES_KEYS = new Set([
  'connection_string',
  'embed_endpoint',
  'review_endpoint',
  'review_model',
  'review_api_key',
])

export const API_KEY_PATTERNS = [
  /^sk-[a-zA-Z0-9-]{20,}$/,
  /^xai-[a-zA-Z0-9]{20,}$/,
  /^AIza[a-zA-Z0-9_-]{30,}$/,
  /^[a-f0-9]{64,}$/,
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toResult(issues: ValidationIssue[]): ValidationResult {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return { valid: errors.length === 0, errors, warnings }
}
