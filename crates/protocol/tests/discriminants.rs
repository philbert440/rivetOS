use protocol::{DelegationResult, HookEventName, LlmChunkType, SilentResponse, StreamEventType};
use serde_json::json;

#[test]
fn hook_event_names_are_exact() {
    let expected = [
        "provider:before",
        "provider:after",
        "provider:error",
        "tool:before",
        "tool:after",
        "session:start",
        "session:end",
        "turn:before",
        "turn:after",
        "turn:reflect",
        "skill:before",
        "skill:after",
        "compact:before",
        "compact:after",
        "delegation:before",
        "delegation:after",
    ];
    assert_eq!(HookEventName::ALL.len(), expected.len());
    for (event, wire) in HookEventName::ALL.into_iter().zip(expected) {
        assert_eq!(serde_json::to_value(event).unwrap(), json!(wire));
        let parsed: HookEventName = serde_json::from_value(json!(wire)).unwrap();
        assert_eq!(parsed, event);
    }
}

#[test]
fn stream_event_types_use_underscores() {
    for event in StreamEventType::ALL {
        assert_eq!(serde_json::to_value(event).unwrap(), json!(event.as_str()));
        assert!(!event.as_str().contains(':'));
        assert!(!event.as_str().contains('-'));
    }
    assert_eq!(StreamEventType::ToolStart.as_str(), "tool_start");
}

#[test]
fn llm_chunk_types_are_exact() {
    for event in LlmChunkType::ALL {
        assert_eq!(serde_json::to_value(event).unwrap(), json!(event.as_str()));
    }
    assert_eq!(LlmChunkType::ToolCallStart.as_str(), "tool_call_start");
}

#[test]
fn silent_responses() {
    assert_eq!(
        serde_json::to_value(SilentResponse::NoReply).unwrap(),
        json!("NO_REPLY")
    );
    assert_eq!(
        serde_json::to_value(SilentResponse::HeartbeatOk).unwrap(),
        json!("HEARTBEAT_OK")
    );
}

#[test]
fn delegation_status_rejects_cached() {
    let err = serde_json::from_str::<DelegationResult>(r#"{"status":"cached","response":"x"}"#);
    assert!(err.is_err());
}
