use protocol::{
    ChannelErrorCode, ConfigErrorCode, DelegationErrorCode, ErrorBuild, ErrorSeverity,
    HarnessErrorCode, MemoryErrorCode, RuntimeErrorCode, ToolErrorCode, channel_error_json,
    config_error_json, delegation_error_json, harness_error_json, memory_error_json,
    provider_error_json, runtime_error_json, tool_error_json,
};
use serde_json::Map;

fn build(message: &str) -> ErrorBuild {
    ErrorBuild {
        message: message.to_string(),
        timestamp: 10,
        cause: None,
        stack: Some("stack".to_string()),
        context: Map::new(),
    }
}

#[test]
fn code_defaults_match_the_tables() {
    assert_eq!(
        ChannelErrorCode::ChannelDisconnected.defaults(),
        (ErrorSeverity::Transient, true)
    );
    assert_eq!(
        ChannelErrorCode::ChannelAuthFailed.defaults(),
        (ErrorSeverity::Fatal, false)
    );
    assert_eq!(
        MemoryErrorCode::MemoryEmbedFailed.defaults(),
        (ErrorSeverity::Warning, true)
    );
    assert_eq!(
        ConfigErrorCode::ConfigInvalid.defaults(),
        (ErrorSeverity::Fatal, false)
    );
    assert_eq!(
        ToolErrorCode::ToolTimeout.defaults(),
        (ErrorSeverity::Warning, true)
    );
    assert_eq!(
        ToolErrorCode::ToolBlocked.defaults(),
        (ErrorSeverity::Warning, false)
    );
    assert_eq!(
        DelegationErrorCode::DelegationTimeout.defaults(),
        (ErrorSeverity::Error, true)
    );
    assert_eq!(
        RuntimeErrorCode::RuntimeStartFailed.defaults(),
        (ErrorSeverity::Fatal, false)
    );
    assert_eq!(
        RuntimeErrorCode::RuntimeShutdownError.defaults(),
        (ErrorSeverity::Error, false)
    );
    for code in HarnessErrorCode::ALL {
        let (severity, retryable) = code.defaults();
        if code == HarnessErrorCode::TurnInFlight {
            assert_eq!((severity, retryable), (ErrorSeverity::Transient, true));
        } else {
            assert_eq!((severity, retryable), (ErrorSeverity::Error, false));
        }
        assert_eq!(code.as_str(), code.as_str().to_ascii_lowercase());
    }
}

#[test]
fn to_json_shape_round_trips() {
    let value = channel_error_json(
        ChannelErrorCode::ChannelSendFailed,
        build("send failed"),
        Some("c1"),
        None,
    );
    assert_eq!(value.name, "ChannelError");
    assert_eq!(value.code, "CHANNEL_SEND_FAILED");
    assert_eq!(
        value
            .context
            .get("channelId")
            .and_then(serde_json::Value::as_str),
        Some("c1")
    );
    assert!(value.context.get("platform").is_none());
    let text = serde_json::to_string(&value).unwrap();
    let again: protocol::ErrorJson = serde_json::from_str(&text).unwrap();
    assert_eq!(value, again);

    let harness = harness_error_json(
        HarnessErrorCode::InvalidSessionId,
        build("bad"),
        Some("claude-code"),
        Some(""),
    );
    assert_eq!(harness.code, "invalid_session_id");
    assert!(harness.context.get("sessionId").is_none());

    let memory = memory_error_json(MemoryErrorCode::MemoryMigrationFailed, build("mig"));
    assert_eq!(memory.code, "MEMORY_MIGRATION_FAILED");
    let config = config_error_json(
        ConfigErrorCode::ConfigMissing,
        build("gone"),
        Some("a.yaml"),
    );
    assert_eq!(
        config
            .context
            .get("path")
            .and_then(serde_json::Value::as_str),
        Some("a.yaml")
    );
    let tool = tool_error_json(ToolErrorCode::ToolNotFound, build("missing"), Some("shell"));
    assert_eq!(
        tool.context
            .get("toolName")
            .and_then(serde_json::Value::as_str),
        Some("shell")
    );
    let delegation = delegation_error_json(
        DelegationErrorCode::DelegationAgentNotFound,
        build("nope"),
        Some("a"),
        Some("b"),
    );
    assert_eq!(delegation.code, "DELEGATION_AGENT_NOT_FOUND");
    let runtime = runtime_error_json(RuntimeErrorCode::RuntimeShutdownError, build("stop"));
    assert_eq!(runtime.severity, ErrorSeverity::Error);
    assert!(!runtime.retryable);
}

#[test]
fn provider_http_json() {
    let value = provider_error_json("nope", 401, "anthropic", 10, None, None, Map::new());
    assert_eq!(value.code, "PROVIDER_HTTP_401");
    assert_eq!(value.severity, ErrorSeverity::Fatal);
    assert!(!value.retryable);
    assert_eq!(value.status_code, Some(401));
    let limited = provider_error_json("slow", 429, "xai", 10, None, None, Map::new());
    assert!(limited.retryable);
    assert_eq!(limited.severity, ErrorSeverity::Transient);
    let gateway = provider_error_json("down", 502, "xai", 10, None, None, Map::new());
    assert_eq!(gateway.severity, ErrorSeverity::Transient);
    assert!(!gateway.retryable);
    let overloaded = provider_error_json("over", 529, "xai", 10, None, None, Map::new());
    assert!(overloaded.retryable);
}
