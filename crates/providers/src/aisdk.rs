use std::collections::HashMap;

use protocol::{ContentPart, LlmChunk, LlmUsage, Message, MessageContent, MessageRole};
use serde_json::{Map, Value};

use crate::chunks::{
    done_chunk, error_chunk, reasoning_chunk, text_chunk, tool_delta, tool_done, tool_start, usage,
};

#[derive(Debug, Clone, PartialEq)]
pub enum AiImage {
    Data(String),
    Url(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AiUserPart {
    Text {
        text: String,
    },
    Image {
        image: AiImage,
        media_type: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum AiModelContent {
    Text(String),
    Parts(Vec<AiModelPart>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AiModelPart {
    Text {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        output: String,
    },
    Image {
        image: AiImage,
        media_type: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiModelMessage {
    pub role: String,
    pub content: AiModelContent,
}

#[derive(Debug, Clone)]
pub struct LooseToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct LooseMessage {
    pub role: String,
    pub content_text: Option<String>,
    pub content_parts: Option<Vec<ContentPart>>,
    pub tool_calls: Vec<LooseToolCall>,
    pub tool_call_id: Option<String>,
}

impl LooseMessage {
    pub fn from_protocol(message: &Message) -> Self {
        let (content_text, content_parts) = match &message.content {
            MessageContent::Text(text) => (Some(text.clone()), None),
            MessageContent::Parts(parts) => (None, Some(parts.clone())),
        };
        let tool_calls = message
            .tool_calls
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|call| LooseToolCall {
                id: call.id,
                name: call.name,
                arguments: js_object_to_json(&call.arguments),
            })
            .collect();
        let role = match message.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        Self {
            role: role.to_string(),
            content_text,
            content_parts,
            tool_calls,
            tool_call_id: message.tool_call_id.clone(),
        }
    }
}

pub fn extract_text_value(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("text")
            && let Some(text) = part.get("text").and_then(Value::as_str)
        {
            out.push_str(text);
        }
    }
    out
}

pub fn extract_text_message(message: &LooseMessage) -> String {
    if let Some(text) = &message.content_text {
        return text.clone();
    }
    let Some(parts) = &message.content_parts else {
        return String::new();
    };
    let mut out = String::new();
    for part in parts {
        if let ContentPart::Text { text } = part {
            out.push_str(text.to_utf8());
        }
    }
    out
}

pub fn parts_to_ai_sdk_user_content(parts: &[ContentPart]) -> Vec<AiUserPart> {
    let mut out = Vec::new();
    for part in parts {
        match part {
            ContentPart::Text { text } => {
                if !text.is_empty() {
                    out.push(AiUserPart::Text {
                        text: text.to_utf8().to_string(),
                    });
                }
            }
            ContentPart::Image {
                data,
                url,
                mime_type,
            } => {
                if let Some(data) = data {
                    let mime = mime_type
                        .clone()
                        .unwrap_or_else(|| "image/jpeg".to_string());
                    out.push(AiUserPart::Image {
                        image: AiImage::Data(format!("data:{mime};base64,{data}")),
                        media_type: mime_type.clone(),
                    });
                } else if let Some(url) = url {
                    out.push(AiUserPart::Image {
                        image: AiImage::Url(url.clone()),
                        media_type: mime_type.clone(),
                    });
                }
            }
            ContentPart::Video { .. } => {}
        }
    }
    out
}

pub fn convert_messages_to_ai_sdk(messages: &[LooseMessage]) -> Vec<AiModelMessage> {
    let mut names = HashMap::new();
    for message in messages {
        if message.role == "assistant" {
            for call in &message.tool_calls {
                names.insert(call.id.clone(), call.name.clone());
            }
        }
    }
    let mut result = Vec::new();
    for message in messages {
        if message.role == "tool" {
            let mut value = extract_text_message(message);
            if message.content_text.is_none()
                && let Some(parts) = &message.content_parts
            {
                let image_count = parts
                    .iter()
                    .filter(|part| matches!(part, ContentPart::Image { .. }))
                    .count();
                if image_count > 0 {
                    value.push_str(&format!(
                        "\n[{image_count} image(s) returned — see image content in context]"
                    ));
                }
            }
            let call_id = message.tool_call_id.clone().unwrap_or_default();
            let tool_name = names.get(&call_id).cloned().unwrap_or_default();
            result.push(AiModelMessage {
                role: "tool".to_string(),
                content: AiModelContent::Parts(vec![AiModelPart::ToolResult {
                    tool_call_id: call_id,
                    tool_name,
                    output: value,
                }]),
            });
        } else if message.role == "assistant" {
            let text = extract_text_message(message);
            if !message.tool_calls.is_empty() {
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(AiModelPart::Text { text });
                }
                for call in &message.tool_calls {
                    let input = tool_input(&call.arguments);
                    parts.push(AiModelPart::ToolCall {
                        tool_call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        input,
                    });
                }
                result.push(AiModelMessage {
                    role: "assistant".to_string(),
                    content: AiModelContent::Parts(parts),
                });
            } else if !text.is_empty() {
                result.push(AiModelMessage {
                    role: "assistant".to_string(),
                    content: AiModelContent::Text(text),
                });
            }
        } else if message.role == "user" {
            if let Some(parts) = &message.content_parts {
                let user_content = parts_to_ai_sdk_user_content(parts);
                if !user_content.is_empty() {
                    result.push(AiModelMessage {
                        role: "user".to_string(),
                        content: AiModelContent::Parts(
                            user_content
                                .into_iter()
                                .map(|part| match part {
                                    AiUserPart::Text { text } => AiModelPart::Text { text },
                                    AiUserPart::Image { image, media_type } => {
                                        AiModelPart::Image { image, media_type }
                                    }
                                })
                                .collect(),
                        ),
                    });
                } else {
                    let text = extract_text_message(message);
                    if !text.is_empty() {
                        result.push(AiModelMessage {
                            role: "user".to_string(),
                            content: AiModelContent::Text(text),
                        });
                    }
                }
            } else {
                let text = extract_text_message(message);
                if !text.is_empty() {
                    result.push(AiModelMessage {
                        role: "user".to_string(),
                        content: AiModelContent::Text(text),
                    });
                }
            }
        } else {
            let text = extract_text_message(message);
            if !text.is_empty() {
                result.push(AiModelMessage {
                    role: "system".to_string(),
                    content: AiModelContent::Text(text),
                });
            }
        }
    }
    result
}

fn js_object_to_json(object: &protocol::js::JsObject) -> Value {
    let mut map = Map::new();
    for (key, value) in object.iter() {
        map.insert(key.to_utf8().to_string(), js_to_json(value));
    }
    Value::Object(map)
}

fn js_to_json(value: &protocol::js::JsValue) -> Value {
    match value {
        protocol::js::JsValue::Null => Value::Null,
        protocol::js::JsValue::Bool(flag) => Value::Bool(*flag),
        protocol::js::JsValue::Number(number) => {
            let text = protocol::js::number_to_string(*number);
            serde_json::from_str(&text).unwrap_or(Value::Null)
        }
        protocol::js::JsValue::String(text) => Value::String(text.to_utf8().to_string()),
        protocol::js::JsValue::Array(items) => Value::Array(items.iter().map(js_to_json).collect()),
        protocol::js::JsValue::Object(object) => js_object_to_json(object),
    }
}

fn tool_input(arguments: &Value) -> Value {
    if let Some(text) = arguments.as_str() {
        match serde_json::from_str::<Value>(text) {
            Ok(value) => value,
            Err(_) => {
                let mut map = Map::new();
                map.insert("raw".to_string(), Value::from(text));
                Value::Object(map)
            }
        }
    } else {
        arguments.clone()
    }
}

#[derive(Debug, Clone)]
pub struct AiUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum AiSdkError {
    Error(String),
    Plain(String),
}

#[derive(Debug, Clone)]
pub struct AiSdkPart {
    pub kind: String,
    pub text: Option<String>,
    pub delta: Option<String>,
    pub id: Option<String>,
    pub tool_name: Option<String>,
    pub source_type: Option<String>,
    pub url: Option<String>,
    pub error: Option<AiSdkError>,
    pub usage: Option<AiUsage>,
    pub response_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AiSdkAccumulator {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub citations: Vec<String>,
    pub had_text_content: bool,
    pub response_id: Option<String>,
    pending: HashMap<String, u64>,
    next_index: u64,
}

impl AiSdkAccumulator {
    pub fn new() -> Self {
        Self {
            prompt_tokens: 0,
            completion_tokens: 0,
            reasoning_tokens: None,
            cached_tokens: None,
            citations: Vec::new(),
            had_text_content: false,
            response_id: None,
            pending: HashMap::new(),
            next_index: 0,
        }
    }

    pub fn usage(&self) -> LlmUsage {
        usage(
            self.prompt_tokens,
            self.completion_tokens,
            self.reasoning_tokens,
            self.cached_tokens,
        )
    }
}

impl Default for AiSdkAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

pub fn translate_ai_sdk_part(part: &AiSdkPart, acc: &mut AiSdkAccumulator) -> Vec<LlmChunk> {
    match part.kind.as_str() {
        "text-delta" => {
            if let Some(text) = part.text.as_deref()
                && !text.is_empty()
            {
                acc.had_text_content = true;
                return vec![text_chunk(text)];
            }
            Vec::new()
        }
        "reasoning-delta" => {
            if let Some(text) = part.text.as_deref()
                && !text.is_empty()
            {
                return vec![reasoning_chunk(text)];
            }
            Vec::new()
        }
        "tool-input-start" => {
            let Some(id) = part.id.as_deref() else {
                return Vec::new();
            };
            let index = acc.next_index;
            acc.next_index += 1;
            acc.pending.insert(id.to_string(), index);
            let name = part.tool_name.as_deref().unwrap_or("");
            vec![tool_start(index, id, name)]
        }
        "tool-input-delta" => {
            let Some(id) = part.id.as_deref() else {
                return Vec::new();
            };
            let Some(delta) = part.delta.as_deref() else {
                return Vec::new();
            };
            let index = acc.pending.get(id).copied().unwrap_or(0);
            vec![tool_delta(index, delta)]
        }
        "tool-input-end" => {
            let Some(id) = part.id.as_deref() else {
                return Vec::new();
            };
            let index = acc.pending.get(id).copied().unwrap_or(0);
            vec![tool_done(index)]
        }
        "source" => {
            if part.source_type.as_deref() == Some("url")
                && let Some(url) = part.url.as_deref()
                && !url.is_empty()
            {
                acc.citations.push(url.to_string());
            }
            Vec::new()
        }
        "finish-step" => {
            if let Some(usage) = &part.usage {
                acc.prompt_tokens = usage.input_tokens.unwrap_or(0);
                acc.completion_tokens = usage.output_tokens.unwrap_or(0);
                if let Some(reasoning) = usage.reasoning_tokens
                    && reasoning > 0
                {
                    acc.reasoning_tokens = Some(reasoning);
                }
                if let Some(cached) = usage.cache_read_tokens
                    && cached > 0
                {
                    acc.cached_tokens = Some(cached);
                }
            }
            if let Some(id) = part.response_id.as_deref()
                && !id.is_empty()
            {
                acc.response_id = Some(id.to_string());
            }
            Vec::new()
        }
        "error" => {
            let message = match &part.error {
                Some(AiSdkError::Error(message) | AiSdkError::Plain(message)) => message.clone(),
                None => "undefined".to_string(),
            };
            vec![error_chunk(&message)]
        }
        _ => Vec::new(),
    }
}

pub fn build_done_chunk(acc: &AiSdkAccumulator) -> LlmChunk {
    done_chunk(acc.usage(), &acc.citations)
}
