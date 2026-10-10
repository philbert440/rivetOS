use protocol::{
    ArtifactKind, ChannelErrorCode, CompactionPending, ConfigErrorCode, DelegationErrorCode,
    DelegationStatus, ErrorSeverity, HarnessErrorCode, HookEventName, LlmChunkType,
    LlmResponseType, MemoryErrorCode, MessageRole, RuntimeErrorCode, SilentResponse,
    StreamEventType, TaskExecutorKind, TaskStatus, TaskVerdict, ThinkingLevel, ToolErrorCode,
};

macro_rules! assert_wire_enum {
    ($ty:ty, $kind:literal) => {{
        for variant in <$ty>::ALL {
            let wire = variant.as_str();
            assert_eq!(variant.to_string(), wire);
            assert_eq!(wire.parse::<$ty>().unwrap(), variant);
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, serde_json::to_string(wire).unwrap());
            assert_eq!(serde_json::from_str::<$ty>(&json).unwrap(), variant);
        }
        let unknown = "not-a-real-wire-value";
        let err = unknown.parse::<$ty>().unwrap_err();
        let expected = format!("unknown {} value: {unknown}", $kind);
        assert_eq!(err.to_string(), expected);
        assert_eq!(err.kind, $kind);
        assert_eq!(err.value, unknown);
        let serde_err = serde_json::from_str::<$ty>(&format!("\"{unknown}\"")).unwrap_err();
        assert!(serde_err.to_string().contains(&expected), "{serde_err}");
    }};
}

#[test]
fn thinking_level_round_trips() {
    assert_wire_enum!(ThinkingLevel, "ThinkingLevel");
}

#[test]
fn stream_event_type_round_trips() {
    assert_wire_enum!(StreamEventType, "StreamEventType");
}

#[test]
fn compaction_pending_round_trips() {
    assert_wire_enum!(CompactionPending, "CompactionPending");
}

#[test]
fn attachment_type_round_trips() {
    assert_wire_enum!(protocol::events::AttachmentType, "AttachmentType");
}

#[test]
fn delegation_status_round_trips() {
    assert_wire_enum!(DelegationStatus, "DelegationStatus");
}

#[test]
fn silent_response_round_trips() {
    assert_wire_enum!(SilentResponse, "SilentResponse");
}

#[test]
fn llm_response_type_round_trips() {
    assert_wire_enum!(LlmResponseType, "LlmResponseType");
}

#[test]
fn llm_chunk_type_round_trips() {
    assert_wire_enum!(LlmChunkType, "LlmChunkType");
}

#[test]
fn hook_event_name_round_trips() {
    assert_wire_enum!(HookEventName, "HookEventName");
}

#[test]
fn error_severity_round_trips() {
    assert_wire_enum!(ErrorSeverity, "ErrorSeverity");
}

#[test]
fn channel_error_code_round_trips() {
    assert_wire_enum!(ChannelErrorCode, "ChannelErrorCode");
}

#[test]
fn memory_error_code_round_trips() {
    assert_wire_enum!(MemoryErrorCode, "MemoryErrorCode");
}

#[test]
fn config_error_code_round_trips() {
    assert_wire_enum!(ConfigErrorCode, "ConfigErrorCode");
}

#[test]
fn tool_error_code_round_trips() {
    assert_wire_enum!(ToolErrorCode, "ToolErrorCode");
}

#[test]
fn delegation_error_code_round_trips() {
    assert_wire_enum!(DelegationErrorCode, "DelegationErrorCode");
}

#[test]
fn runtime_error_code_round_trips() {
    assert_wire_enum!(RuntimeErrorCode, "RuntimeErrorCode");
}

#[test]
fn harness_error_code_round_trips() {
    assert_wire_enum!(HarnessErrorCode, "HarnessErrorCode");
}

#[test]
fn text_type_round_trips() {
    assert_wire_enum!(protocol::message::TextType, "TextType");
}

#[test]
fn image_type_round_trips() {
    assert_wire_enum!(protocol::message::ImageType, "ImageType");
}

#[test]
fn video_type_round_trips() {
    assert_wire_enum!(protocol::message::VideoType, "VideoType");
}

#[test]
fn message_role_round_trips() {
    assert_wire_enum!(MessageRole, "MessageRole");
}

#[test]
fn task_executor_kind_round_trips() {
    assert_wire_enum!(TaskExecutorKind, "TaskExecutorKind");
}

#[test]
fn task_status_round_trips() {
    assert_wire_enum!(TaskStatus, "TaskStatus");
}

#[test]
fn task_verdict_round_trips() {
    assert_wire_enum!(TaskVerdict, "TaskVerdict");
}

#[test]
fn artifact_kind_round_trips() {
    assert_wire_enum!(ArtifactKind, "ArtifactKind");
}
