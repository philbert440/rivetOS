pub const KNOWN_MEMORY_SQLITE_KEYS: &[&str] = &[
    "path",
    "embed_endpoint",
    "embed_model",
    "embed_api_key",
    "embed_token_command",
    "embed_token_ttl_ms",
    "embed_wire_shape",
    "embed_expected_dims",
    "embed_timeout_ms",
    "embed_query_instruction",
    "compactor_endpoint",
    "compactor_model",
    "compactor_api_key",
    "compactor_token_command",
    "compactor_timeout_ms",
    "wiki_dir",
    "wiki_extraction",
    "tagging",
    "tagger_endpoint",
    "tagger_model",
    "tagger_api_key",
    "tagger_token_command",
    "tagger_wire_shape",
    "tagger_allow_protected_removals",
    "project_rule",
    "per_user_files",
    "users_dir",
    "workers",
];

pub(crate) const KNOWN_TOP_LEVEL: &[&str] = &[
    "runtime",
    "agents",
    "providers",
    "channels",
    "memory",
    "mcp",
    "transports",
    "deployment",
    "mesh",
    "den",
    "tasks",
    "workflows",
    "plugins",
];

pub(crate) const KNOWN_RUNTIME: &[&str] = &[
    "workspace",
    "default_agent",
    "turn_timeout",
    "context",
    "skill_dirs",
    "plugin_dirs",
    "heartbeats",
    "safety",
    "auto_actions",
    "experimental",
];

pub(crate) const KNOWN_AGENT: &[&str] =
    &["provider", "model", "default_thinking", "local", "tools"];

pub(crate) const THINKING_LEVELS: &[&str] = &["off", "low", "medium", "high", "xhigh"];

pub(crate) const CLI_HARNESS_PROVIDERS: &[&str] = &[
    "grok-cli",
    "hermes-cli",
    "kimi-code",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "pi-cli",
    "qwen-code",
];

pub(crate) const TOKEN_COMMAND_PROVIDERS: &[&str] = &["anthropic", "xai", "vllm", "llama-server"];

pub(crate) const MODEL_CATALOG_PROVIDERS: &[&str] = &["vllm", "llama-server"];

pub(crate) const EMBEDDING_COLUMN_DIMS: f64 = 1024.0;

pub(crate) const PERMISSION_PROMPT_TIMEOUT_MS: i64 = 60_000;

pub(crate) const PERMISSION_PROMPT_TIMEOUT_MAX_MS: i64 = 600_000;

pub(crate) const KNOWN_HEARTBEAT: &[&str] = &[
    "agent",
    "schedule",
    "timezone",
    "prompt",
    "output_channel",
    "quiet_hours",
];

pub(crate) const KNOWN_MEMORY: &[&str] = &["postgres", "sqlite", "capture"];

pub(crate) const KNOWN_MEMORY_POSTGRES: &[&str] = &[
    "connection_string",
    "embed_endpoint",
    "embed_model",
    "embed_api_key",
    "embed_token_command",
    "embed_token_ttl_ms",
    "embed_token_command_timeout_ms",
    "embed_wire_shape",
    "embed_expected_dims",
    "embed_query_instruction",
    "embed_timeout_ms",
    "hnsw_ef_search",
    "delegation_tracking",
    "embedded",
];

pub(crate) const KNOWN_MEMORY_EMBEDDED: &[&str] =
    &["data_dir", "port", "auto_migrate", "max_connections"];

pub(crate) const KNOWN_MEMORY_CAPTURE: &[&str] = &["redaction"];

pub(crate) const KNOWN_MEMORY_CAPTURE_REDACTION: &[&str] = &["enabled", "builtins", "patterns"];

pub(crate) const KNOWN_CHANNEL_AGENT: &[&str] = &[
    "port", "host", "secret", "agentId", "agent_id", "peers", "tls",
];

pub(crate) const KNOWN_DEPLOYMENT: &[&str] = &["target"];

pub(crate) const VALID_DEPLOYMENT_TARGETS: &[&str] = &["docker", "proxmox", "kubernetes", "manual"];

pub(crate) const KNOWN_DEN: &[&str] = &[
    "enabled",
    "host",
    "port",
    "token",
    "tls_cert",
    "tls_key",
    "terminal",
    "static_dir",
    "root_redirect",
    "files_root",
    "files_open",
    "devices",
    "advertise_mdns",
    "allowed_origins",
    "allowed_hosts",
    "allowed_harnesses",
];

pub(crate) const KNOWN_DEN_DEVICES: &[&str] = &[
    "enabled",
    "relay_ssh",
    "relay_sudo",
    "wg_interface",
    "pool",
    "wg_endpoint",
    "wg_public_key",
    "allowed_ips",
    "home_subnet",
    "relay_forward_src",
    "relay_forward_dest",
    "shared_host",
    "shared_export",
    "roster_path",
    "gateway_url",
    "pg_admin_url",
    "pg_device_group",
];

pub(crate) const DEN_DEVICE_BOOLS: &[&str] = &["enabled", "relay_sudo"];

pub(crate) const DEN_DEVICE_STRINGS: &[&str] = &[
    "relay_ssh",
    "wg_interface",
    "pool",
    "wg_endpoint",
    "wg_public_key",
    "allowed_ips",
    "home_subnet",
    "relay_forward_src",
    "relay_forward_dest",
    "shared_host",
    "shared_export",
    "roster_path",
    "gateway_url",
    "pg_admin_url",
    "pg_device_group",
];

pub(crate) const KNOWN_DEN_TERMINAL: &[&str] = &["enabled", "open", "idle_ttl_ms"];

pub(crate) const DEN_LOOPBACK_HOSTS: &[&str] = &["127.0.0.1", "::1", "localhost"];

pub(crate) const KNOWN_TASKS: &[&str] = &["enabled", "pricing", "eval", "harnesses", "sqlite_path"];

pub(crate) const KNOWN_TASKS_HARNESS: &[&str] = &[
    "binary",
    "model",
    "effort",
    "cwd",
    "home",
    "models",
    "efforts",
    "models_mode",
    "isolation",
    "allowed_tools",
];

pub(crate) const HARNESS_STRING_FIELDS: &[&str] = &["binary", "model", "cwd", "home"];

pub(crate) const KNOWN_TASKS_EVAL: &[&str] = &[
    "enabled",
    "require_criteria",
    "derive_internal",
    "skip_origins",
    "max_retries",
    "verifier",
    "escalation",
];

pub(crate) const EVAL_BOOLS: &[&str] = &["enabled", "require_criteria", "derive_internal"];

pub(crate) const KNOWN_WORKFLOWS: &[&str] =
    &["enabled", "runs_dir", "defs_roots", "agent_allowlist"];

pub(crate) fn has(keys: &[&str], key: &str) -> bool {
    keys.contains(&key)
}

pub(crate) fn join(keys: &[&str]) -> String {
    keys.join(", ")
}

pub(crate) fn provider_known_keys(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "codex-cli" => &[
            "model",
            "binary",
            "reasoning_effort",
            "cwd",
            "sandbox",
            "approve_for_me",
            "skip_git_repo_check",
            "profile",
            "session",
            "context_window",
            "max_output_tokens",
        ],
        "anthropic" => &[
            "model",
            "max_tokens",
            "api_key",
            "token_command",
            "token_ttl_ms",
            "token_command_timeout_ms",
            "context_window",
            "max_output_tokens",
        ],
        "grok-cli" => &[
            "model",
            "binary",
            "permission_mode",
            "reasoning_effort",
            "max_turns",
            "no_plan",
            "system_prompt",
            "session",
            "allow",
            "tools",
            "cwd",
            "name",
            "context_window",
            "max_output_tokens",
        ],
        "hermes-cli" => &[
            "model",
            "binary",
            "cwd",
            "name",
            "context_window",
            "max_output_tokens",
        ],
        "kimi-code" | "opencode-cli" | "pi-cli" | "qwen-code" => &[
            "model",
            "binary",
            "home",
            "cwd",
            "name",
            "context_window",
            "max_output_tokens",
        ],
        "claude-cli" => &[
            "model",
            "binary",
            "tools",
            "effort",
            "permission_mode",
            "exclude_dynamic_sections",
            "append_system_prompt",
            "cwd",
            "timeout_ms",
            "name",
            "context_window",
            "max_output_tokens",
            "permission_prompts",
            "permission_timeout_ms",
            "allowed_api_key_sources",
        ],
        "xai" => &[
            "model",
            "max_tokens",
            "api_key",
            "token_command",
            "token_ttl_ms",
            "token_command_timeout_ms",
            "temperature",
            "context_window",
            "max_output_tokens",
            "name",
            "base_url",
            "store",
            "web_search",
            "webSearch",
            "x_search",
            "xSearch",
            "code_execution",
            "codeExecution",
            "reasoning_effort",
            "reasoningEffort",
            "max_turns",
            "maxTurns",
            "tool_choice",
            "toolChoice",
            "parallel_tool_calls",
            "parallelToolCalls",
            "truncation",
            "instructions",
        ],
        "google" => &[
            "model",
            "max_tokens",
            "api_key",
            "context_window",
            "max_output_tokens",
        ],
        "ollama" => &[
            "model",
            "base_url",
            "num_ctx",
            "temperature",
            "keep_alive",
            "context_window",
            "max_output_tokens",
        ],
        "vllm" => &[
            "model",
            "base_url",
            "api_key",
            "token_command",
            "token_ttl_ms",
            "token_command_timeout_ms",
            "models",
            "models_ttl_ms",
            "max_tokens",
            "temperature",
            "top_p",
            "top_k",
            "min_p",
            "presence_penalty",
            "frequency_penalty",
            "seed",
            "default_tool_choice",
            "verify_model_on_init",
            "name",
            "context_window",
            "max_output_tokens",
            "repetition_penalty",
            "min_tokens",
            "stop",
            "mm_processor_kwargs",
            "chat_template_kwargs",
            "extra_body",
            "api_prefix",
            "models_url",
            "probe_models",
        ],
        "llama-server" => &[
            "model",
            "base_url",
            "api_key",
            "token_command",
            "token_ttl_ms",
            "token_command_timeout_ms",
            "models",
            "models_ttl_ms",
            "max_tokens",
            "temperature",
            "top_p",
            "top_k",
            "min_p",
            "presence_penalty",
            "frequency_penalty",
            "seed",
            "default_tool_choice",
            "verify_model_on_init",
            "name",
            "context_window",
            "max_output_tokens",
            "stop",
            "extra_body",
        ],
        _ => return None,
    })
}

pub(crate) fn removed_runtime(key: &str) -> Option<&'static str> {
    match key {
        "fallbacks" => Some(
            "Provider fallback was removed in the AI SDK migration. Remove \"runtime.fallbacks\" from your config.",
        ),
        "coding_pipeline" => Some(
            "The coding-pipeline plugin was removed. Remove \"runtime.coding_pipeline\"; use delegate_task (and the upcoming task engine) instead.",
        ),
        _ => None,
    }
}

pub(crate) fn removed_agent(key: &str) -> Option<&'static str> {
    match key {
        "fallbacks" => Some(
            "Per-agent fallback chains were removed in the AI SDK migration. Remove \"fallbacks\" from this agent.",
        ),
        _ => None,
    }
}

pub(crate) fn removed_provider(name: &str) -> Option<&'static str> {
    match name {
        "openai-compat" => Some(
            "The \"openai-compat\" provider was split into dedicated providers. Use \"vllm\" for a vLLM server, or \"llama-server\" for llama.cpp's llama-server — both take base_url.",
        ),
        _ => None,
    }
}

pub(crate) fn removed_postgres(key: &str) -> Option<&'static str> {
    match key {
        "review_endpoint" => Some(
            "The background review loop was removed — compaction is the single consolidation path. Remove \"review_endpoint\"; for delegation-event persistence set \"delegation_tracking: true\".",
        ),
        "review_model" => Some(
            "The background review loop was removed. Remove \"review_model\" from memory.postgres.",
        ),
        "review_api_key" => Some(
            "The background review loop was removed. Remove \"review_api_key\" from memory.postgres.",
        ),
        _ => None,
    }
}

pub(crate) fn harness_csv() -> String {
    protocol::HARNESS_IDS.join(", ")
}
