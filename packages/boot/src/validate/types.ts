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
  'transports',
  'deployment',
  'mesh',
  'den',
  'tasks',
  'plugins',
])

export const KNOWN_TASKS_KEYS = new Set(['enabled', 'pricing', 'eval'])
export const KNOWN_TASKS_EVAL_KEYS = new Set([
  'enabled',
  'require_criteria',
  'derive_internal',
  'skip_origins',
  'max_retries',
  'verifier',
  'escalation',
])

export const KNOWN_DEN_KEYS = new Set([
  'enabled',
  'host',
  'port',
  'token',
  'terminal',
  'packs_dir',
  'static_dir',
  'root_redirect',
  'files_root',
])

export const KNOWN_DEN_TERMINAL_KEYS = new Set(['enabled', 'open'])

/**
 * Hosts den-server treats as loopback in its terminal security gate
 * (services/den-server/src/server.ts LOOPBACK_HOSTS). Keep in sync — the
 * config validator mirrors that gate so a token-less exposed terminal is
 * rejected at validate time instead of force-disabled at runtime.
 */
export const DEN_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

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
  'safety',
  'auto_actions',
])

export const KNOWN_AGENT_KEYS = new Set(['provider', 'model', 'default_thinking', 'local', 'tools'])

/**
 * Keys removed in the AI SDK migration — config validator emits a hard error
 * with a clear message when these are present so stale config fails loudly.
 */
export const REMOVED_RUNTIME_KEYS = new Map<string, string>([
  [
    'fallbacks',
    'Provider fallback was removed in the AI SDK migration. Remove "runtime.fallbacks" from your config.',
  ],
  [
    'coding_pipeline',
    'The coding-pipeline plugin was removed. Remove "runtime.coding_pipeline"; use delegate_task (and the upcoming task engine) instead.',
  ],
])

export const REMOVED_AGENT_KEYS = new Map<string, string>([
  [
    'fallbacks',
    'Per-agent fallback chains were removed in the AI SDK migration. Remove "fallbacks" from this agent.',
  ],
])

/**
 * Provider names removed in the AI SDK migration. Validator emits a hard error
 * pointing operators at the replacement.
 */
export const REMOVED_PROVIDERS = new Map<string, string>([
  [
    'openai-compat',
    'The "openai-compat" provider was split into dedicated providers. Use "vllm" for a vLLM server, or "llama-server" for llama.cpp\'s llama-server — both take base_url.',
  ],
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
    // xAI-specific capabilities supported by XAIProviderConfig — previously
    // rejected as "unknown key", silently dropping server-side search config.
    'name',
    'base_url',
    'store',
    'web_search',
    'webSearch',
    'x_search',
    'xSearch',
    'code_execution',
    'codeExecution',
    'reasoning_effort',
    'reasoningEffort',
    'max_turns',
    'maxTurns',
    'tool_choice',
    'toolChoice',
    'parallel_tool_calls',
    'parallelToolCalls',
    'truncation',
    'instructions',
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
  vllm: new Set([
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
    // vLLM extensions
    'repetition_penalty',
    'min_tokens',
    'stop',
    'mm_processor_kwargs',
    'chat_template_kwargs',
    'extra_body',
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
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'default_tool_choice',
    'verify_model_on_init',
    'name',
    'context_window',
    'max_output_tokens',
    'stop',
    'extra_body',
  ]),
}

/** Keys for the local (GERTY) voice backend — shared by `voice` and `voice-discord`. */
const VOICE_LOCAL_KEYS = [
  'provider',
  'agent',
  'channel_id',
  'voice_channel_id',
  'speaker',
  'gerty_host',
  'stt_url',
  'tts_url',
  'stt_model',
  'tts_model',
  'voice_instruct',
  'language',
  'sample_rate',
  'silence_ms',
  'tts_max_new_tokens',
] as const

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
    ...VOICE_LOCAL_KEYS,
  ]),
  'voice-discord': new Set([
    'bot_token',
    'xai_api_key',
    'guild_id',
    'allowed_users',
    'voice',
    'instructions',
    'transcript_dir',
    ...VOICE_LOCAL_KEYS,
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

export const KNOWN_MEMORY_POSTGRES_KEYS = new Set([
  'connection_string',
  'embed_endpoint',
  'embed_model',
  'delegation_tracking',
])

/**
 * Keys removed in the phase-0 deletion pass — hard error so stale config
 * fails loudly instead of silently booting without the feature.
 */
export const REMOVED_MEMORY_POSTGRES_KEYS = new Map<string, string>([
  [
    'review_endpoint',
    'The background review loop was removed — compaction is the single consolidation path. Remove "review_endpoint"; for delegation-event persistence set "delegation_tracking: true".',
  ],
  [
    'review_model',
    'The background review loop was removed. Remove "review_model" from memory.postgres.',
  ],
  [
    'review_api_key',
    'The background review loop was removed. Remove "review_api_key" from memory.postgres.',
  ],
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
