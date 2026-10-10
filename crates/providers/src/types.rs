use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::{LlmChunk, StreamEvent, ThinkingLevel};
use serde_json::{Map, Value};

use crate::error::ProviderError;
use crate::jsonutil::{canonical_pair, parse_schema};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub const UA_ANTHROPIC: &str =
    "ai-sdk/anthropic/3.0.105 ai-sdk/provider-utils/4.0.41 runtime/node.js/22";
pub const UA_XAI: &str = "ai-sdk/xai/3.0.114 ai-sdk/provider-utils/4.0.41 runtime/node.js/22";
pub const UA_GOOGLE: &str = "ai-sdk/google/3.0.103 ai-sdk/provider-utils/4.0.41 runtime/node.js/22";
pub const UA_OPENAI: &str =
    "ai-sdk/openai-compatible/2.0.63 ai-sdk/provider-utils/4.0.41 runtime/node.js/22";
pub const UA_OLLAMA: &str = "ai-sdk/provider-utils/4.0.41 runtime/node.js/22";
pub const UA_PROBE: &str = "node";
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
pub const TURN_TIMEOUT_MS: u64 = 1_800_000;
pub const XAI_TIMEOUT_MS: u64 = 3_600_000;

pub const ECHO_DESCRIPTION: &str = "Echo the arguments back as JSON.";
pub const COMPACT_DESCRIPTION: &str = "Summarize and compact conversation history to free context window space. Provide ranges of messages to replace with summaries. Message indices are 0-based positions in the conversation history (index 0 = first user or assistant message; system messages are excluded from indexing).";

const ECHO_SCHEMA: &str = r#"{"type":"object","properties":{"text":{"type":"string","description":"Text to echo back."},"n":{"type":"number","description":"A number to echo back."}},"required":["text"]}"#;
const COMPACT_SCHEMA: &str = r#"{"type":"object","properties":{"replacements":{"type":"array","description":"Message ranges to replace with summaries","items":{"type":"object","properties":{"start_index":{"type":"number","description":"Start index in conversation history (0-based, inclusive)"},"end_index":{"type":"number","description":"End index in conversation history (0-based, inclusive)"},"summary":{"type":"string","description":"Brief summary replacing these messages. Include key decisions, outcomes, and any information still relevant."}},"required":["start_index","end_index","summary"]}}},"required":["replacements"]}"#;

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

pub fn echo_tool() -> ToolDef {
    ToolDef {
        name: "echo".to_string(),
        description: ECHO_DESCRIPTION.to_string(),
        parameters: parse_schema(ECHO_SCHEMA),
    }
}

pub fn compact_tool() -> ToolDef {
    ToolDef {
        name: "compact_context".to_string(),
        description: COMPACT_DESCRIPTION.to_string(),
        parameters: parse_schema(COMPACT_SCHEMA),
    }
}

pub fn with_compact(mut tools: Vec<ToolDef>) -> Vec<ToolDef> {
    if !tools.iter().any(|tool| tool.name == "compact_context") {
        tools.push(compact_tool());
    }
    tools
}

#[derive(Debug, Clone)]
pub struct ReplayTool {
    pub id: String,
    pub name: String,
    pub arguments_json: String,
    pub arguments: Value,
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone)]
pub enum TurnMessage {
    User { text: String },
    Assistant {
        text: String,
        reasoning: String,
        anthropic_signature: Option<String>,
        xai_reasoning_id: Option<String>,
        tool_calls: Vec<ReplayTool>,
    },
    ToolResult {
        id: String,
        name: String,
        content: String,
    },
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub system: String,
    pub messages: Vec<TurnMessage>,
    pub tools: Vec<ToolDef>,
    pub thinking: ThinkingLevel,
    pub session_id: Option<String>,
    pub model_override: Option<String>,
    pub timeout: Duration,
    pub contains_images: bool,
}

impl ChatRequest {
    pub fn simple(system: &str, user: &str, thinking: ThinkingLevel) -> Self {
        Self {
            system: system.to_string(),
            messages: vec![TurnMessage::User {
                text: user.to_string(),
            }],
            tools: vec![echo_tool(), compact_tool()],
            thinking,
            session_id: None,
            model_override: None,
            timeout: Duration::from_millis(TURN_TIMEOUT_MS),
            contains_images: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CapturedTool {
    pub id: String,
    pub name: String,
    pub raw_args: String,
    pub thought_signature: Option<String>,
    pub done: bool,
    pub index: u64,
}

#[derive(Debug, Clone, Default)]
pub struct StepCapture {
    pub text: String,
    pub reasoning: String,
    pub anthropic_signature: Option<String>,
    pub xai_reasoning_id: Option<String>,
    pub tools: Vec<CapturedTool>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub response_id: Option<String>,
    pub saw_text: bool,
}

impl StepCapture {
    pub fn replay_tools(&self) -> Vec<ReplayTool> {
        self.tools
            .iter()
            .map(|tool| {
                let (arguments_json, arguments) = canonical_pair(&tool.raw_args);
                ReplayTool {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                    arguments_json,
                    arguments,
                    thought_signature: tool.thought_signature.clone(),
                }
            })
            .collect()
    }
}

pub struct ChatStream {
    pub capture: Arc<Mutex<StepCapture>>,
    pub inner: Pin<Box<dyn futures_util::Stream<Item = Result<LlmChunk, ProviderError>> + Send>>,
}

impl futures_util::Stream for ChatStream {
    type Item = Result<LlmChunk, ProviderError>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn get_model(&self) -> String;
    fn set_model(&self, model: String);
    fn set_base_url(&self, _url: String) {}
    fn context_window(&self) -> u64;
    fn max_output_tokens(&self) -> u64;
    fn stream_chat<'a>(&'a self, request: ChatRequest) -> BoxFuture<'a, Result<ChatStream, ProviderError>>;
    fn is_available<'a>(&'a self) -> BoxFuture<'a, bool>;
    fn list_models<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>, ProviderError>> {
        let model = self.get_model();
        Box::pin(async move { Ok(vec![model]) })
    }
}

pub fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

pub fn summarize_args(value: &Value) -> Value {
    match value {
        Value::String(text) if text.chars().count() > 200 => {
            let truncated: String = text.chars().take(200).collect();
            Value::String(format!("{truncated}…"))
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                out.insert(key.clone(), summarize_args(child));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(summarize_args).collect()),
        other => other.clone(),
    }
}

pub fn text_event(kind: protocol::StreamEventType, content: &str) -> StreamEvent {
    StreamEvent {
        r#type: kind,
        content: content.to_string(),
        metadata: None,
    }
}

pub fn tool_start_event(name: &str, args: &Value) -> StreamEvent {
    let mut metadata = Map::new();
    metadata.insert("tool".to_string(), Value::from(name));
    metadata.insert("args".to_string(), summarize_args(args));
    StreamEvent {
        r#type: protocol::StreamEventType::ToolStart,
        content: format!("🔧 {name}"),
        metadata: Some(metadata),
    }
}

pub fn tool_result_event(name: &str, text: &str, is_error: bool) -> StreamEvent {
    let mark = if is_error { "❌" } else { "✅" };
    let sliced: String = text.chars().take(200).collect();
    let mut metadata = Map::new();
    metadata.insert("tool".to_string(), Value::from(name));
    StreamEvent {
        r#type: protocol::StreamEventType::ToolResult,
        content: format!("{mark} {name}: {sliced}"),
        metadata: Some(metadata),
    }
}

pub fn execute_tool(name: &str, canonical: &str) -> (String, bool) {
    let text = if name == "echo" {
        canonical.to_string()
    } else if name == "compact_context" {
        "compacted".to_string()
    } else {
        format!("Error: unknown tool {name}")
    };
    let is_error = text.starts_with("Error");
    (text, is_error)
}
