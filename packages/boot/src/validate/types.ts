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
  'workflows',
  'plugins',
])

export const KNOWN_TASKS_KEYS = new Set(['enabled', 'pricing', 'eval', 'harnesses', 'sqlite_path'])

/** tasks.harnesses.<harness-id>.* keys (YAML snake_case). */
export const KNOWN_TASKS_HARNESS_KEYS = new Set([
  'binary',
  'model',
  'effort',
  'cwd',
  'home',
  'models',
  'efforts',
  'models_mode',
  'isolation',
  'allowed_tools',
])

/** workflows.* keys (YAML snake_case). */
export const KNOWN_WORKFLOWS_KEYS = new Set([
  'enabled',
  'runs_dir',
  'defs_roots',
  'agent_allowlist',
])
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
  'token', // legacy; ignored — gateway auth is device mTLS via tls_cert/tls_key
  'tls_cert',
  'tls_key',
  'terminal',
  'static_dir',
  'root_redirect',
  'files_root',
  'files_open',
  'devices',
  'advertise_mdns',
  'allowed_origins',
  'allowed_hosts',
  'allowed_harnesses',
])

export const KNOWN_DEN_DEVICES_KEYS = new Set([
  'enabled',
  'relay_ssh',
  'relay_sudo',
  'wg_interface',
  'pool',
  'wg_endpoint',
  'wg_public_key',
  'allowed_ips',
  'home_subnet',
  'relay_forward_src',
  'relay_forward_dest',
  'shared_host',
  'shared_export',
  'roster_path',
  'gateway_url',
  'pg_admin_url',
  'pg_device_group',
])

export const KNOWN_DEN_TERMINAL_KEYS = new Set(['enabled', 'open', 'idle_ttl_ms'])

/**
 * Hosts den-server treats as loopback in its terminal security gate
 * (services/den-server/src/server.ts LOOPBACK_HOSTS). Keep in sync — the
 * config validator mirrors that gate so a token-less exposed terminal is
 * rejected at validate time instead of force-disabled at runtime.
 */
export const DEN_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** Only `target` is a known deployment key; all others warn as unknown. */
export const KNOWN_DEPLOYMENT_KEYS = new Set(['target'])

export const VALID_DEPLOYMENT_TARGETS = new Set(['docker', 'proxmox', 'kubernetes', 'manual'])

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
  'experimental',
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

export const VALID_THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high', 'xhigh'])

/**
 * CLI harness providers shell out to a local coding-agent binary that has
 * its own configured default model. `providers.<id>.model` is optional for
 * these; API providers still require it.
 */
export const CLI_HARNESS_PROVIDERS = new Set([
  'grok-cli',
  'hermes-cli',
  'kimi-code',
  'claude-cli',
  'codex-cli',
  'opencode-cli',
  'pi-cli',
  'qwen-code',
])

export const KNOWN_PROVIDERS: Partial<Record<string, Set<string>>> = {
  'codex-cli': new Set([
    'model',
    'binary',
    'reasoning_effort',
    'cwd',
    'sandbox',
    'approve_for_me',
    'skip_git_repo_check',
    'profile',
    'session',
    'context_window',
    'max_output_tokens',
  ]),
  anthropic: new Set([
    'model',
    'max_tokens',
    'api_key',
    'token_command',
    'token_ttl_ms',
    'token_command_timeout_ms',
    'context_window',
    'max_output_tokens',
  ]),
  'grok-cli': new Set([
    'model',
    'binary',
    'permission_mode',
    'reasoning_effort',
    'max_turns',
    'no_plan',
    'system_prompt',
    'session',
    'allow',
    'tools',
    'cwd',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
  'hermes-cli': new Set(['model', 'binary', 'cwd', 'name', 'context_window', 'max_output_tokens']),
  'kimi-code': new Set([
    'model',
    'binary',
    'home',
    'cwd',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
  'opencode-cli': new Set([
    'model',
    'binary',
    'home',
    'cwd',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
  'pi-cli': new Set([
    'model',
    'binary',
    'home',
    'cwd',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
  'qwen-code': new Set([
    'model',
    'binary',
    'home',
    'cwd',
    'name',
    'context_window',
    'max_output_tokens',
  ]),
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
    'permission_prompts',
    'permission_timeout_ms',
    'allowed_api_key_sources',
  ]),
  xai: new Set([
    'model',
    'max_tokens',
    'api_key',
    'token_command',
    'token_ttl_ms',
    'token_command_timeout_ms',
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
    'token_command',
    'token_ttl_ms',
    'token_command_timeout_ms',
    'models',
    'models_ttl_ms',
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
    'api_prefix',
    'models_url',
    'probe_models',
  ]),
  'llama-server': new Set([
    'model',
    'base_url',
    'api_key',
    'token_command',
    'token_ttl_ms',
    'token_command_timeout_ms',
    'models',
    'models_ttl_ms',
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

/**
 * Known channel types and their config keys.
 *
 * Social channels (telegram / discord / voice-discord) were removed in Phase 5.
 * A stale `channels.telegram:` (etc.) is an **unknown channel type warning**, not
 * a hard error — registration is skipped because the package is gone, so nodes
 * do not crash-loop on leftover fleet config.
 *
 * Product path for human interaction is Hub (gateway + rivethub). The only
 * first-party channel plugin remaining is agent-to-agent mesh.
 */
export const KNOWN_CHANNELS: Partial<Record<string, Set<string>>> = {
  agent: new Set(['port', 'host', 'secret', 'agentId', 'agent_id', 'peers', 'tls']),
}

export const KNOWN_HEARTBEAT_KEYS = new Set([
  'agent',
  'schedule',
  'timezone',
  'prompt',
  'output_channel',
  'quiet_hours',
])

/** Top-level keys under `memory` (backends + capture options). */
export const KNOWN_MEMORY_KEYS = new Set(['postgres', 'sqlite', 'capture'])

export const KNOWN_MEMORY_POSTGRES_KEYS = new Set([
  'connection_string',
  'embed_endpoint',
  'embed_model',
  'embed_api_key',
  'embed_token_command',
  'embed_token_ttl_ms',
  'embed_token_command_timeout_ms',
  'embed_wire_shape',
  'embed_expected_dims',
  'embed_query_instruction',
  'embed_timeout_ms',
  'hnsw_ef_search',
  'delegation_tracking',
  'embedded',
])

export const KNOWN_MEMORY_EMBEDDED_KEYS = new Set([
  'data_dir',
  'port',
  'auto_migrate',
  'max_connections',
])

/** `memory.sqlite` — file-backed Memory backend (phase 1: WAL + FTS5). */
export const KNOWN_MEMORY_SQLITE_KEYS = new Set([
  'path',
  'embed_endpoint',
  'embed_model',
  'embed_api_key',
  'embed_token_command',
  'embed_token_ttl_ms',
  'embed_wire_shape',
  'embed_expected_dims',
  'embed_timeout_ms',
  'embed_query_instruction',
  'compactor_endpoint',
  'compactor_model',
  'compactor_api_key',
  'compactor_token_command',
  'compactor_timeout_ms',
  'wiki_dir',
  'wiki_extraction',
  'tagging',
  'tagger_endpoint',
  'tagger_model',
  'tagger_api_key',
  'tagger_wire_shape',
  'project_rule',
  'per_user_files',
  'users_dir',
  'workers',
])

/** Backends with a known plugin under `plugins/memory/<name>`. */
export const KNOWN_MEMORY_BACKENDS = new Set(['postgres', 'sqlite'])

export const KNOWN_MEMORY_CAPTURE_KEYS = new Set(['redaction'])

export const KNOWN_MEMORY_CAPTURE_REDACTION_KEYS = new Set(['enabled', 'builtins', 'patterns'])

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
