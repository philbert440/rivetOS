use protocol::{
    Attachment, CriterionSelfReport, DelegationRequest, DelegationResult, ErrorJson, ImagePart,
    InboundMessage, LlmChunk, LlmResponse, LlmUsage, Message, ParsedSessionId, ParsedTaskResult,
    PartialToolCall, QueuedMessage, SessionState, StreamEvent, TaskArtifact, TaskBudget,
    TaskResult, TaskUsage, TextPart, TokenUsage, ToolCall, VideoPart,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn assert_json_eq(left: &Value, right: &Value) {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            assert_eq!(left.len(), right.len(), "{left:?} vs {right:?}");
            for (key, value) in left {
                assert_json_eq(value, right.get(key).unwrap_or(&Value::Null));
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            assert_eq!(left.len(), right.len());
            for (left, right) in left.iter().zip(right) {
                assert_json_eq(left, right);
            }
        }
        (Value::Number(left), Value::Number(right)) => {
            assert_eq!(left.as_f64(), right.as_f64(), "{left} vs {right}");
        }
        _ => assert_eq!(left, right),
    }
}

fn roundtrip<T>(file: &str)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let path = format!("{}/tests/fixtures/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    let value: T = serde_json::from_str(&text).unwrap();
    let back = serde_json::to_string(&value).unwrap();
    let again: T = serde_json::from_str(&back).unwrap();
    assert_eq!(value, again);
    let original: Value = serde_json::from_str(&text).unwrap();
    let serialized: Value = serde_json::from_str(&back).unwrap();
    assert_json_eq(&original, &serialized);
}

#[test]
fn text_part() {
    roundtrip::<TextPart>("text_part.json");
}

#[test]
fn image_part() {
    roundtrip::<ImagePart>("image_part.json");
}

#[test]
fn video_part() {
    roundtrip::<VideoPart>("video_part.json");
}

#[test]
fn tool_call_keeps_thought_signature() {
    roundtrip::<ToolCall>("tool_call.json");
}

#[test]
fn message() {
    roundtrip::<Message>("message.json");
}

#[test]
fn stream_event() {
    roundtrip::<StreamEvent>("stream_event.json");
}

#[test]
fn session_state() {
    roundtrip::<SessionState>("session_state.json");
}

#[test]
fn attachment() {
    roundtrip::<Attachment>("attachment.json");
}

#[test]
fn inbound_message() {
    roundtrip::<InboundMessage>("inbound_message.json");
}

#[test]
fn queued_message() {
    roundtrip::<QueuedMessage>("queued_message.json");
}

#[test]
fn delegation_request() {
    roundtrip::<DelegationRequest>("delegation_request.json");
}

#[test]
fn delegation_result() {
    roundtrip::<DelegationResult>("delegation_result.json");
}

#[test]
fn token_usage() {
    roundtrip::<TokenUsage>("token_usage.json");
}

#[test]
fn llm_usage() {
    roundtrip::<LlmUsage>("llm_usage.json");
}

#[test]
fn llm_response() {
    roundtrip::<LlmResponse>("llm_response.json");
}

#[test]
fn partial_tool_call() {
    roundtrip::<PartialToolCall>("partial_tool_call.json");
}

#[test]
fn llm_chunk() {
    roundtrip::<LlmChunk>("llm_chunk.json");
}

#[test]
fn error_json() {
    roundtrip::<ErrorJson>("error_json.json");
}

#[test]
fn task_budget() {
    roundtrip::<TaskBudget>("task_budget.json");
}

#[test]
fn task_usage() {
    roundtrip::<TaskUsage>("task_usage.json");
}

#[test]
fn task_artifact() {
    roundtrip::<TaskArtifact>("task_artifact.json");
}

#[test]
fn criterion_self_report() {
    roundtrip::<CriterionSelfReport>("criterion_self_report.json");
}

#[test]
fn task_result() {
    roundtrip::<TaskResult>("task_result.json");
}

#[test]
fn parsed_task_result() {
    roundtrip::<ParsedTaskResult>("parsed_task_result.json");
}

#[test]
fn parsed_session_id() {
    roundtrip::<ParsedSessionId>("parsed_session_id.json");
}

#[test]
fn optional_message_fields_are_omitted() {
    let message: Message = serde_json::from_str(r#"{"role":"user","content":"hi"}"#).unwrap();
    let value = serde_json::to_value(&message).unwrap();
    let object = value.as_object().unwrap();
    assert!(!object.contains_key("toolCalls"));
    assert!(!object.contains_key("toolCallId"));
}

fn key_order_signature(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let parts = map
                .iter()
                .map(|(key, child)| format!("{key}:{}", key_order_signature(child)))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{parts}}}")
        }
        Value::Array(items) => {
            let parts = items
                .iter()
                .map(key_order_signature)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{parts}]")
        }
        _ => String::new(),
    }
}

fn assert_fixture_key_order<T>(file: &str)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let path = format!("{}/tests/fixtures/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    let fixture: Value = serde_json::from_str(&text).unwrap();
    let value: T = serde_json::from_str(&text).unwrap();
    let serialized = serde_json::to_value(&value).unwrap();
    assert_eq!(
        key_order_signature(&fixture),
        key_order_signature(&serialized),
        "{file}"
    );
    assert_json_eq(&fixture, &serialized);
    let compact = serde_json::to_string(&serialized).unwrap();
    let again: Value = serde_json::from_str(&compact).unwrap();
    assert_eq!(key_order_signature(&fixture), key_order_signature(&again));
}

macro_rules! key_order {
    ($($name:ident, $ty:ty, $file:literal);* $(;)?) => {
        $(
            #[test]
            fn $name() {
                assert_fixture_key_order::<$ty>($file);
            }
        )*
    };
}

key_order! {
    text_part_keys_match_fixture, TextPart, "text_part.json";
    image_part_keys_match_fixture, ImagePart, "image_part.json";
    video_part_keys_match_fixture, VideoPart, "video_part.json";
    tool_call_keys_match_fixture, ToolCall, "tool_call.json";
    message_keys_match_fixture, Message, "message.json";
    stream_event_keys_match_fixture, StreamEvent, "stream_event.json";
    session_state_keys_match_fixture, SessionState, "session_state.json";
    attachment_keys_match_fixture, Attachment, "attachment.json";
    inbound_message_keys_match_fixture, InboundMessage, "inbound_message.json";
    queued_message_keys_match_fixture, QueuedMessage, "queued_message.json";
    delegation_request_keys_match_fixture, DelegationRequest, "delegation_request.json";
    delegation_result_keys_match_fixture, DelegationResult, "delegation_result.json";
    token_usage_keys_match_fixture, TokenUsage, "token_usage.json";
    llm_usage_keys_match_fixture, LlmUsage, "llm_usage.json";
    llm_response_keys_match_fixture, LlmResponse, "llm_response.json";
    partial_tool_call_keys_match_fixture, PartialToolCall, "partial_tool_call.json";
    llm_chunk_keys_match_fixture, LlmChunk, "llm_chunk.json";
    error_json_keys_match_fixture, ErrorJson, "error_json.json";
    task_budget_keys_match_fixture, TaskBudget, "task_budget.json";
    task_usage_keys_match_fixture, TaskUsage, "task_usage.json";
    task_artifact_keys_match_fixture, TaskArtifact, "task_artifact.json";
    criterion_self_report_keys_match_fixture, CriterionSelfReport, "criterion_self_report.json";
    task_result_keys_match_fixture, TaskResult, "task_result.json";
    parsed_task_result_keys_match_fixture, ParsedTaskResult, "parsed_task_result.json";
    parsed_session_id_keys_match_fixture, ParsedSessionId, "parsed_session_id.json";
}
