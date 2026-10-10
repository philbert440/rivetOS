use serde::de::{self, Deserializer};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::JsNumber;
use crate::message::{Message, ToolCall};

fn omit_false(value: &bool) -> bool {
    !*value
}

crate::wire_enum! {
    pub enum ThinkingLevel {
        Off => "off",
        Low => "low",
        Medium => "medium",
        High => "high",
        XHigh => "xhigh",
    }
}

crate::wire_enum! {
    pub enum StreamEventType {
        Text => "text",
        Reasoning => "reasoning",
        ToolStart => "tool_start",
        ToolResult => "tool_result",
        Status => "status",
        Interrupt => "interrupt",
        Done => "done",
        Error => "error",
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

crate::wire_enum! {
    pub enum CompactionPending {
        Soft40 => "soft-40",
        Soft70 => "soft-70",
        Hard => "hard",
    }
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
    pub compaction_count: JsNumber,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_pending: Option<CompactionPending>,
    pub nudges_fired: Vec<JsNumber>,
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
    pub width: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<JsNumber>,
}

crate::wire_enum! {
    pub enum AttachmentType {
        Photo => "photo",
        Voice => "voice",
        Document => "document",
        Video => "video",
    }
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
    pub timestamp: JsNumber,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub message: InboundMessage,
    pub received_at: JsNumber,
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
    pub timeout_ms: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "omit_false")]
    pub no_delegation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

crate::wire_enum! {
    pub enum DelegationStatus {
        Completed => "completed",
        Failed => "failed",
        Timeout => "timeout",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub agent: String,
    pub provider: String,
    pub model: String,
    pub prompt_tokens: JsNumber,
    pub completion_tokens: JsNumber,
    pub timestamp: JsNumber,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationResult {
    pub status: DelegationStatus,
    pub response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_used: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<JsNumber>,
}

crate::wire_enum! {
    pub enum SilentResponse {
        NoReply => "NO_REPLY",
        HeartbeatOk => "HEARTBEAT_OK",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsage {
    pub prompt_tokens: JsNumber,
    pub completion_tokens: JsNumber,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_tokens: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<JsNumber>,
}

crate::wire_enum! {
    pub enum LlmResponseType {
        Text => "text",
        ToolCalls => "tool_calls",
    }
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

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum JsonField<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PartialToolCall {
    pub id: JsonField<String>,
    pub name: JsonField<String>,
    pub arguments: JsonField<Map<String, Value>>,
    pub thought_signature: JsonField<String>,
    pub index: JsonField<JsNumber>,
    order: Vec<String>,
}

const PARTIAL_TOOL_CALL_KEYS: &[&str] = &["id", "name", "arguments", "thoughtSignature", "index"];

impl PartialToolCall {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_id(mut self, id: impl Into<String>) -> Self {
        self.id = JsonField::Value(id.into());
        self
    }

    pub fn set_name(mut self, name: impl Into<String>) -> Self {
        self.name = JsonField::Value(name.into());
        self
    }

    pub fn set_arguments(mut self, arguments: Map<String, Value>) -> Self {
        self.arguments = JsonField::Value(arguments);
        self
    }

    pub fn set_thought_signature(mut self, signature: impl Into<String>) -> Self {
        self.thought_signature = JsonField::Value(signature.into());
        self
    }

    pub fn set_index(mut self, index: impl Into<JsNumber>) -> Self {
        self.index = JsonField::Value(index.into());
        self
    }
}

fn field_is_present<T>(field: &JsonField<T>) -> bool {
    !matches!(field, JsonField::Absent)
}

fn partial_key_present(key: &str, call: &PartialToolCall) -> bool {
    match key {
        "id" => field_is_present(&call.id),
        "name" => field_is_present(&call.name),
        "arguments" => field_is_present(&call.arguments),
        "thoughtSignature" => field_is_present(&call.thought_signature),
        "index" => field_is_present(&call.index),
        _ => false,
    }
}

fn write_partial_entry<S>(map: &mut S, key: &str, call: &PartialToolCall) -> Result<(), S::Error>
where
    S: SerializeMap,
{
    match key {
        "id" => write_field(map, key, &call.id),
        "name" => write_field(map, key, &call.name),
        "arguments" => write_field(map, key, &call.arguments),
        "thoughtSignature" => write_field(map, key, &call.thought_signature),
        "index" => write_field(map, key, &call.index),
        _ => Ok(()),
    }
}

fn write_field<S, T>(map: &mut S, key: &str, field: &JsonField<T>) -> Result<(), S::Error>
where
    S: SerializeMap,
    T: Serialize,
{
    match field {
        JsonField::Absent => Ok(()),
        JsonField::Null => map.serialize_entry(key, &Value::Null),
        JsonField::Value(value) => map.serialize_entry(key, value),
    }
}

impl Serialize for PartialToolCall {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut keys = Vec::new();
        for key in &self.order {
            if partial_key_present(key, self) && !keys.iter().any(|seen: &String| seen == key) {
                keys.push(key.clone());
            }
        }
        for key in PARTIAL_TOOL_CALL_KEYS {
            if partial_key_present(key, self) && !keys.iter().any(|seen| seen == key) {
                keys.push((*key).to_string());
            }
        }
        let mut map = serializer.serialize_map(Some(keys.len()))?;
        for key in &keys {
            write_partial_entry(&mut map, key, self)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for PartialToolCall {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        let mut order = Vec::new();
        for key in map.keys() {
            if !PARTIAL_TOOL_CALL_KEYS.contains(&key.as_str()) {
                return Err(de::Error::unknown_field(key, PARTIAL_TOOL_CALL_KEYS));
            }
            order.push(key.clone());
        }
        Ok(PartialToolCall {
            id: read_json_field(&map, "id")?,
            name: read_json_field(&map, "name")?,
            arguments: read_json_field(&map, "arguments")?,
            thought_signature: read_json_field(&map, "thoughtSignature")?,
            index: read_json_field(&map, "index")?,
            order,
        })
    }
}

fn read_json_field<T, E>(map: &Map<String, Value>, key: &str) -> Result<JsonField<T>, E>
where
    T: de::DeserializeOwned,
    E: de::Error,
{
    match map.get(key) {
        None => Ok(JsonField::Absent),
        Some(Value::Null) => Ok(JsonField::Null),
        Some(value) => T::deserialize(value)
            .map(JsonField::Value)
            .map_err(E::custom),
    }
}

crate::wire_enum! {
    pub enum LlmChunkType {
        Text => "text",
        Reasoning => "reasoning",
        ToolCallStart => "tool_call_start",
        ToolCallDelta => "tool_call_delta",
        ToolCallDone => "tool_call_done",
        Status => "status",
        Done => "done",
        Error => "error",
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
