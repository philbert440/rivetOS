mod common;

use common::{assert_has_error, memory, provider};

macro_rules! err {
    ($name:ident, $yaml:expr, $message:expr) => {
        #[test]
        fn $name() {
            let yaml = $yaml;
            assert_has_error(&yaml, $message);
        }
    };
}

err!(
    openai_compat_removed,
    provider("openai-compat", "    model: x\n"),
    "The \"openai-compat\" provider was split into dedicated providers. Use \"vllm\" for a vLLM server, or \"llama-server\" for llama.cpp's llama-server — both take base_url."
);
err!(
    model_missing,
    provider("anthropic", "    max_tokens: 16\n"),
    "Provider \"anthropic\" is missing required field \"model\""
);
err!(
    model_not_string,
    provider("anthropic", "    model: 1\n"),
    "Provider \"anthropic\" model must be a string"
);
err!(
    permission_prompts,
    provider("claude-cli", "    permission_prompts: bad\n"),
    "permission_prompts must be \"ui\" or \"none\" (omit the key to leave spawns unchanged)"
);
err!(
    permission_timeout_ms,
    provider("claude-cli", "    permission_timeout_ms: 0\n"),
    "permission_timeout_ms must be a positive integer of at most 600000 (default 60000)"
);
err!(
    base_url_required,
    provider("ollama", "    model: m\n"),
    "Provider \"ollama\" requires \"base_url\""
);
err!(
    allowed_api_key_sources,
    provider("claude-cli", "    allowed_api_key_sources: [\"\"]\n"),
    "allowed_api_key_sources must be an array of non-empty strings"
);
err!(
    token_command_shell,
    provider("anthropic", "    model: m\n    token_command: echo hi\n"),
    "Provider \"anthropic\" token_command must be an argv array (no shell string)"
);
err!(
    token_command_argv,
    provider("anthropic", "    model: m\n    token_command: []\n"),
    "Provider \"anthropic\" token_command must be a non-empty argv array of strings"
);
err!(
    token_ttl_ms,
    provider("anthropic", "    model: m\n    token_ttl_ms: 0\n"),
    "Provider \"anthropic\" token_ttl_ms must be a positive number"
);
err!(
    token_command_timeout_ms,
    provider(
        "anthropic",
        "    model: m\n    token_command_timeout_ms: 0\n"
    ),
    "Provider \"anthropic\" token_command_timeout_ms must be a positive number"
);
err!(
    models_catalog,
    provider(
        "vllm",
        "    model: m\n    base_url: http://127.0.0.1:8000\n    models: [\"\"]\n"
    ),
    "Provider \"vllm\" models must be an array of non-empty strings (static catalog floor)"
);
err!(
    models_ttl_ms,
    provider(
        "vllm",
        "    model: m\n    base_url: http://127.0.0.1:8000\n    models_ttl_ms: 0\n"
    ),
    "Provider \"vllm\" models_ttl_ms must be a positive number"
);
err!(
    max_tokens,
    provider("anthropic", "    model: m\n    max_tokens: 0\n"),
    "Provider \"anthropic\" max_tokens must be a positive number"
);

err!(
    both_memory_backends,
    memory(
        "  postgres:\n    connection_string: postgres://localhost/db\n  sqlite:\n    path: \":memory:\"\n"
    ),
    "\"postgres\" and \"sqlite\" cannot both be set — pick one memory backend"
);
err!(
    postgres_not_object,
    memory("  postgres: hello\n"),
    "\"memory.postgres\" must be an object"
);
err!(
    review_endpoint_removed,
    memory("  postgres:\n    review_endpoint: http://x\n"),
    "The background review loop was removed — compaction is the single consolidation path. Remove \"review_endpoint\"; for delegation-event persistence set \"delegation_tracking: true\"."
);
err!(
    review_model_removed,
    memory("  postgres:\n    review_model: m\n"),
    "The background review loop was removed. Remove \"review_model\" from memory.postgres."
);
err!(
    review_api_key_removed,
    memory("  postgres:\n    review_api_key: k\n"),
    "The background review loop was removed. Remove \"review_api_key\" from memory.postgres."
);
err!(
    delegation_tracking,
    memory("  postgres:\n    delegation_tracking: 1\n"),
    "\"delegation_tracking\" must be a boolean (true/false)"
);
err!(
    embed_token_shell,
    memory("  postgres:\n    embed_token_command: echo hi\n"),
    "memory.postgres embed_token_command must be an argv array (no shell string)"
);
err!(
    embed_token_argv,
    memory("  postgres:\n    embed_token_command: []\n"),
    "memory.postgres embed_token_command must be a non-empty argv array of strings"
);
err!(
    embed_token_ttl,
    memory("  postgres:\n    embed_token_ttl_ms: 0\n"),
    "memory.postgres embed_token_ttl_ms must be a positive number"
);
err!(
    embed_token_timeout,
    memory("  postgres:\n    embed_token_command_timeout_ms: 0\n"),
    "memory.postgres embed_token_command_timeout_ms must be a positive number"
);
err!(
    embed_wire_shape,
    memory("  postgres:\n    embed_wire_shape: nope\n"),
    "\"embed_wire_shape\" must be \"openai\" or \"native\""
);
err!(
    embed_expected_dims,
    memory("  postgres:\n    embed_expected_dims: 1\n"),
    "\"embed_expected_dims\" must equal the embedding column width (1024); any other value bricks halfvec inserts and vector search"
);
err!(
    sqlite_not_object,
    memory("  sqlite: hello\n"),
    "\"memory.sqlite\" must be an object"
);
err!(
    tagger_allow_protected_removals,
    memory("  sqlite:\n    path: \":memory:\"\n    tagger_allow_protected_removals: 1\n"),
    "\"tagger_allow_protected_removals\" must be a boolean"
);
err!(
    tagger_token_shell,
    memory("  sqlite:\n    path: \":memory:\"\n    tagger_token_command: echo hi\n"),
    "memory.sqlite tagger_token_command must be an argv array (no shell string)"
);
err!(
    tagger_token_argv,
    memory("  sqlite:\n    path: \":memory:\"\n    tagger_token_command: []\n"),
    "memory.sqlite tagger_token_command must be a non-empty argv array of strings"
);
err!(
    tagger_token_ttl,
    memory("  sqlite:\n    path: \":memory:\"\n    tagger_token_ttl_ms: 0\n"),
    "memory.sqlite tagger_token_ttl_ms must be a positive number"
);
err!(
    tagger_token_timeout,
    memory("  sqlite:\n    path: \":memory:\"\n    tagger_token_command_timeout_ms: 0\n"),
    "memory.sqlite tagger_token_command_timeout_ms must be a positive number"
);
err!(
    sqlite_path_missing,
    memory("  sqlite:\n    embed_model: m\n"),
    "\"memory.sqlite.path\" is required (file path or \":memory:\")"
);
err!(
    sqlite_path_empty,
    memory("  sqlite:\n    path: \"\"\n"),
    "\"memory.sqlite.path\" must be a non-empty file path"
);
err!(
    capture_not_object,
    memory("  capture: null\n"),
    "\"memory.capture\" must be an object"
);
err!(
    redaction_not_object,
    memory("  capture:\n    redaction: null\n"),
    "\"memory.capture.redaction\" must be an object"
);
err!(
    redaction_enabled,
    memory("  capture:\n    redaction:\n      enabled: 1\n"),
    "\"enabled\" must be a boolean"
);
err!(
    redaction_builtins,
    memory("  capture:\n    redaction:\n      builtins: 1\n"),
    "\"builtins\" must be a boolean"
);
err!(
    patterns_not_array,
    memory("  capture:\n    redaction:\n      patterns: nope\n"),
    "\"patterns\" must be an array of regex source strings"
);
err!(
    pattern_empty,
    memory("  capture:\n    redaction:\n      patterns: [\"\"]\n"),
    "Each pattern must be a non-empty string (JS regex source)"
);
err!(
    pattern_redos,
    memory("  capture:\n    redaction:\n      patterns: [\"(a+)+\"]\n"),
    "Pattern looks ReDoS-prone (nested quantifiers); rewrite without nested +/* groups"
);
err!(
    embedded_not_object,
    memory("  postgres:\n    embedded: null\n"),
    "\"memory.postgres.embedded\" must be an object"
);
err!(
    embedded_and_connection_string,
    memory(
        "  postgres:\n    connection_string: postgres://localhost/db\n    embedded:\n      data_dir: /tmp/pg\n"
    ),
    "\"embedded\" and \"connection_string\" cannot both be set — embedded owns the loopback URL"
);
err!(
    embedded_data_dir,
    memory("  postgres:\n    embedded:\n      data_dir: \"\"\n"),
    "\"data_dir\" must be a non-empty string"
);
err!(
    embedded_port,
    memory("  postgres:\n    embedded:\n      port: 0\n"),
    "\"port\" must be an integer between 1 and 65535"
);
err!(
    embedded_auto_migrate,
    memory("  postgres:\n    embedded:\n      auto_migrate: 1\n"),
    "\"auto_migrate\" must be a boolean"
);
err!(
    embedded_max_connections,
    memory("  postgres:\n    embedded:\n      max_connections: 0\n"),
    "\"max_connections\" must be a positive integer"
);

#[test]
fn invalid_regex_prefix() {
    let yaml = memory("  capture:\n    redaction:\n      patterns: [\"*\"]\n");
    let value = config::parse_yaml(&yaml).unwrap();
    let result = config::validate_config(&value);
    assert!(!result.valid);
    assert!(
        result
            .errors
            .iter()
            .any(|issue| issue.message.starts_with("Invalid regex: ")),
        "{:?}",
        result.errors
    );
}
