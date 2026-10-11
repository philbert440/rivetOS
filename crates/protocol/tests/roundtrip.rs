use protocol::{
    Attachment, CriterionSelfReport, DelegationRequest, DelegationResult, ErrorJson, ImagePart,
    InboundMessage, LlmChunk, LlmResponse, LlmUsage, Message, ParsedSessionId, ParsedTaskResult,
    PartialToolCall, QueuedMessage, SessionState, StreamEvent, TaskArtifact, TaskBudget,
    TaskResult, TaskUsage, TextPart, TokenUsage, ToolCall, VideoPart,
};
use serde::Serialize;
use serde::de::DeserializeOwned;

fn normalize_json_ws(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    let mut in_string = false;
    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if ch == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
        } else if !matches!(ch, ' ' | '\t' | '\n' | '\r') {
            out.push(ch);
        }
    }
    out
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
    assert_eq!(value, again, "{file}");
    assert_eq!(normalize_json_ws(&text), back, "{file}");
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
fn provider_error() {
    roundtrip::<ErrorJson>("provider_error.json");
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

#[test]
fn normalizer_keeps_number_spelling() {
    assert_ne!(normalize_json_ws("1000"), normalize_json_ws("1000.0"));
    assert_eq!(normalize_json_ws("{\n  \"n\": 1000\n}"), "{\"n\":1000}");
    assert_eq!(normalize_json_ws("{\"s\": \"1 000\"}"), "{\"s\":\"1 000\"}");
}
