mod common;

use common::{BASE, runtime_body, with_base};

#[test]
fn valid_base_config() {
    let value = config::parse_yaml(BASE).unwrap();
    let result = config::validate_config(&value);
    assert!(result.valid, "{:?}", result.errors);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let text = config::format_validation_result(&result);
    assert_eq!(text, "\u{2705} Config is valid.");
    let loaded = config::load_str(BASE).unwrap();
    assert!(loaded.document.get("runtime").is_some());
    assert!(loaded.validation.valid);
}

#[test]
fn unknown_top_level_key_does_not_fail() {
    let yaml = with_base("hooks: 1\n");
    let value = config::parse_yaml(&yaml).unwrap();
    let result = config::validate_config(&value);
    assert!(result.valid, "{:?}", result.errors);
    assert!(result.warnings.iter().any(|issue| {
        issue.message == "Unknown top-level key \"hooks\" — will be ignored"
            && issue.path == "hooks"
    }));
    let text = config::format_validation_result(&result);
    assert_eq!(
        text,
        "Warnings:\n  \u{26a0}\u{fe0f}  [hooks] Unknown top-level key \"hooks\" — will be ignored\n\n\u{2705} Config is valid (1 warning)."
    );
}

#[test]
fn format_one_error() {
    let yaml = runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  experimental: nope\n");
    let value = config::parse_yaml(&yaml).unwrap();
    let result = config::validate_config(&value);
    assert_eq!(result.errors.len(), 1, "{:?}", result.errors);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let text = config::format_validation_result(&result);
    assert_eq!(
        text,
        "Errors:\n  \u{274c} [runtime.experimental] \"runtime.experimental\" must be a boolean\n\n\u{274c} Config has 1 error."
    );
}

#[test]
fn unset_env_ref_is_empty_and_not_a_hardcoded_key() {
    let yaml = "\
runtime:
  workspace: /tmp/ws
  default_agent: main
agents:
  main:
    provider: anthropic
providers:
  anthropic:
    model: claude-opus
    api_key: ${UNSET}
";
    let raw = config::parse_yaml(yaml).unwrap();
    let result = config::validate_config(&raw);
    assert!(result.valid, "{:?} {:?}", result.errors, result.warnings);
    assert!(
        result
            .warnings
            .iter()
            .all(|issue| !issue.message.contains("hardcoded"))
    );
    assert_eq!(
        raw.pointer("/providers/anthropic/api_key")
            .and_then(|value| value.as_str()),
        Some("${UNSET}")
    );
    let resolved = config::resolve_env_vars_with(&raw, |_| None);
    assert_eq!(
        resolved
            .pointer("/providers/anthropic/api_key")
            .and_then(|value| value.as_str()),
        Some("")
    );

    let disguised = "\
runtime:
  workspace: /tmp/ws
  default_agent: main
agents:
  main:
    provider: anthropic
providers:
  anthropic:
    model: claude-opus
    api_key: sk-abcdefghijklmnopqrstuvwxyz${UNSET}
";
    let raw = config::parse_yaml(disguised).unwrap();
    let result = config::validate_config(&raw);
    assert!(
        result
            .warnings
            .iter()
            .all(|issue| !issue.message.contains("hardcoded"))
    );
}

#[test]
fn sqlite_allowlist_warns_only_for_unknown_keys() {
    let mut body = String::from("  sqlite:\n");
    for key in config::KNOWN_MEMORY_SQLITE_KEYS {
        let line = match *key {
            "path" => "    path: \":memory:\"\n".to_string(),
            "tagger_allow_protected_removals" => {
                "    tagger_allow_protected_removals: true\n".to_string()
            }
            "tagger_token_command" => "    tagger_token_command: [\"bin\"]\n".to_string(),
            _ => format!("    {key}: x\n"),
        };
        body.push_str(&line);
    }
    body.push_str("    not_a_key: 1\n");
    let yaml = with_base(&format!("memory:\n{body}"));
    let value = config::parse_yaml(&yaml).unwrap();
    let result = config::validate_config(&value);
    assert!(result.valid, "{:?}", result.errors);
    assert!(
        result
            .warnings
            .iter()
            .any(|issue| { issue.message == "Unknown memory.sqlite key \"not_a_key\"" })
    );
    for key in config::KNOWN_MEMORY_SQLITE_KEYS {
        let unexpected = format!("Unknown memory.sqlite key \"{key}\"");
        assert!(
            result
                .warnings
                .iter()
                .all(|issue| issue.message != unexpected),
            "{unexpected} {:?}",
            result.warnings
        );
    }
}

#[test]
fn lenient_embedded_port_renders_got_json() {
    let bad = config::parse_yaml("memory:\n  postgres:\n    embedded:\n      port: 0\n").unwrap();
    let err = config::assert_embedded_port(&bad).unwrap_err();
    assert_eq!(
        err.to_string(),
        "memory.postgres.embedded.port must be an integer between 1 and 65535 (got 0)"
    );
    let text =
        config::parse_yaml("memory:\n  postgres:\n    embedded:\n      port: nope\n").unwrap();
    let err = config::assert_embedded_port(&text).unwrap_err();
    assert_eq!(
        err.to_string(),
        "memory.postgres.embedded.port must be an integer between 1 and 65535 (got \"nope\")"
    );
    let absent =
        config::parse_yaml("memory:\n  postgres:\n    embedded:\n      data_dir: /tmp/pg\n")
            .unwrap();
    assert!(config::assert_embedded_port(&absent).is_ok());
    let null_port =
        config::parse_yaml("memory:\n  postgres:\n    embedded:\n      port: null\n").unwrap();
    assert!(config::assert_embedded_port(&null_port).is_ok());
}

#[test]
fn cli_harness_empty_model_is_allowed() {
    let yaml = "\
runtime:
  workspace: /tmp/ws
  default_agent: main
agents:
  main:
    provider: claude-cli
providers:
  claude-cli:
    model: \"\"
";
    let value = config::parse_yaml(yaml).unwrap();
    let result = config::validate_config(&value);
    assert!(result.valid, "{:?} {:?}", result.errors, result.warnings);
}

#[test]
fn heartbeat_schedule_number_and_fractional_quiet_hours() {
    let yaml = runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - agent: main\n      schedule: 30\n      prompt: hi\n      quiet_hours:\n        start: 1.5\n        end: 2\n",
    );
    let value = config::parse_yaml(&yaml).unwrap();
    let result = config::validate_config(&value);
    assert!(result.valid, "{:?} {:?}", result.errors, result.warnings);
}

#[test]
fn validation_failure_does_not_resolve_env() {
    let err = config::load_str("[]\n").unwrap_err();
    assert_eq!(err.to_string(), "Config validation failed");
}

#[test]
fn init_tracing_can_be_called_twice() {
    config::init_tracing();
    config::init_tracing();
}
