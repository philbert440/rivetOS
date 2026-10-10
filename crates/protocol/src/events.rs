use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::message::{Message, ToolCall};

fn omit_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThinkingLevel {
    #[serde(rename = "off")]
    Off,
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "medium")]
    Medium,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "xhigh")]
    XHigh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StreamEventType {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "reasoning")]
    Reasoning,
    #[serde(rename = "tool_start")]
    ToolStart,
    #[serde(rename = "tool_result")]
    ToolResult,
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "interrupt")]
    Interrupt,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "error")]
    Error,
}

impl StreamEventType {
    pub const ALL: [StreamEventType; 8] = [
        StreamEventType::Text,
        StreamEventType::Reasoning,
        StreamEventType::ToolStart,
        StreamEventType::ToolResult,
        StreamEventType::Status,
        StreamEventType::Interrupt,
        StreamEventType::Done,
        StreamEventType::Error,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            StreamEventType::Text => "text",
            StreamEventType::Reasoning => "reasoning",
            StreamEventType::ToolStart => "tool_start",
            StreamEventType::ToolResult => "tool_result",
            StreamEventType::Status => "status",
            StreamEventType::Interrupt => "interrupt",
            StreamEventType::Done => "done",
            StreamEventType::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub r#type: StreamEventType,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompactionPending {
    #[serde(rename = "soft-40")]
    Soft40,
    #[serde(rename = "soft-70")]
    Soft70,
    #[serde(rename = "hard")]
    Hard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub id: String,
    pub thinking: ThinkingLevel,
    pub reasoning_visible: bool,
    pub tools_visible: bool,
    pub history: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    pub compaction_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_pending: Option<CompactionPending>,
    pub nudges_fired: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    #[serde(rename = "type")]
    pub r#type: AttachmentType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttachmentType {
    #[serde(rename = "photo")]
    Photo,
    #[serde(rename = "voice")]
    Voice,
    #[serde(rename = "document")]
    Document,
    #[serde(rename = "video")]
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundMessage {
    pub id: String,
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub channel_id: String,
    pub chat_type: String,
    pub text: String,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub message: InboundMessage,
    pub received_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRequest {
    pub from_agent: String,
    pub to_agent: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "omit_false")]
    pub no_delegation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DelegationStatus {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "timeout")]
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub agent: String,
    pub provider: String,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationResult {
    pub status: DelegationStatus,
    pub response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_used: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SilentResponse {
    #[serde(rename = "NO_REPLY")]
    NoReply,
    #[serde(rename = "HEARTBEAT_OK")]
    HeartbeatOk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LlmResponseType {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "tool_calls")]
    ToolCalls,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmResponse {
    #[serde(rename = "type")]
    pub r#type: LlmResponseType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<LlmUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialToolCall {
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<Map<String, Value>>,
    pub thought_signature: Option<String>,
    pub index: Option<i64>,
    order: Vec<String>,
}

const PARTIAL_TOOL_CALL_KEYS: &[&str] = &["id", "name", "arguments", "thoughtSignature", "index"];

fn write_partial_field(map: &mut Map<String, Value>, key: &str, call: &PartialToolCall) {
    if map.contains_key(key) {
        return;
    }
    let value = match key {
        "id" => call.id.clone().map(Value::String),
        "name" => call.name.clone().map(Value::String),
        "arguments" => call.arguments.clone().map(Value::Object),
        "thoughtSignature" => call.thought_signature.clone().map(Value::String),
        "index" => call.index.map(|index| Value::Number(index.into())),
        _ => None,
    };
    if let Some(value) = value {
        map.insert(key.to_string(), value);
    }
}

impl Serialize for PartialToolCall {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = Map::new();
        for key in &self.order {
            write_partial_field(&mut map, key, self);
        }
        for key in PARTIAL_TOOL_CALL_KEYS {
            write_partial_field(&mut map, key, self);
        }
        map.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PartialToolCall {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        let mut order = Vec::new();
        for (key, value) in &map {
            if value.is_null() {
                continue;
            }
            if !PARTIAL_TOOL_CALL_KEYS.contains(&key.as_str()) {
                return Err(de::Error::unknown_field(key, PARTIAL_TOOL_CALL_KEYS));
            }
            order.push(key.clone());
        }
        Ok(PartialToolCall {
            id: optional_string(&map, "id")?,
            name: optional_string(&map, "name")?,
            arguments: optional_object(&map, "arguments")?,
            thought_signature: optional_string(&map, "thoughtSignature")?,
            index: optional_i64(&map, "index")?,
            order,
        })
    }
}

fn optional_string<E: de::Error>(map: &Map<String, Value>, key: &str) -> Result<Option<String>, E> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => String::deserialize(value).map(Some).map_err(E::custom),
    }
}

fn optional_i64<E: de::Error>(map: &Map<String, Value>, key: &str) -> Result<Option<i64>, E> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => i64::deserialize(value).map(Some).map_err(E::custom),
    }
}

fn optional_object<E: de::Error>(
    map: &Map<String, Value>,
    key: &str,
) -> Result<Option<Map<String, Value>>, E> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Map::<String, Value>::deserialize(value)
            .map(Some)
            .map_err(E::custom),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LlmChunkType {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "reasoning")]
    Reasoning,
    #[serde(rename = "tool_call_start")]
    ToolCallStart,
    #[serde(rename = "tool_call_delta")]
    ToolCallDelta,
    #[serde(rename = "tool_call_done")]
    ToolCallDone,
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "error")]
    Error,
}

impl LlmChunkType {
    pub const ALL: [LlmChunkType; 8] = [
        LlmChunkType::Text,
        LlmChunkType::Reasoning,
        LlmChunkType::ToolCallStart,
        LlmChunkType::ToolCallDelta,
        LlmChunkType::ToolCallDone,
        LlmChunkType::Status,
        LlmChunkType::Done,
        LlmChunkType::Error,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            LlmChunkType::Text => "text",
            LlmChunkType::Reasoning => "reasoning",
            LlmChunkType::ToolCallStart => "tool_call_start",
            LlmChunkType::ToolCallDelta => "tool_call_delta",
            LlmChunkType::ToolCallDone => "tool_call_done",
            LlmChunkType::Status => "status",
            LlmChunkType::Done => "done",
            LlmChunkType::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChunk {
    #[serde(rename = "type")]
    pub r#type: LlmChunkType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<PartialToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<LlmUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
