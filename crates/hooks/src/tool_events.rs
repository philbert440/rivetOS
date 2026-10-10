use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use protocol::{ContentPart, StreamEvent, StreamEventType, ToolResult};
use serde_json::{Map, Value};

use crate::context::HookContext;
use crate::js_text::{js_slice, utf16_len};
use crate::pipeline::HookPipeline;
use crate::time_format::epoch_ms;

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<ToolResult, ToolExecError>> + Send>>;
pub type ToolFn = Arc<
    dyn Fn(Map<String, Value>, AbortSignal, ToolCallContext) -> ToolFuture + Send + Sync,
>;

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct ToolExecError {
    pub message: String,
}

impl ToolExecError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug)]
struct AbortState {
    aborted: AtomicBool,
}

#[derive(Clone, Debug)]
pub struct AbortSignal {
    inner: Arc<AbortState>,
}

impl PartialEq for AbortSignal {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl Eq for AbortSignal {}

impl Default for AbortSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl AbortSignal {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AbortState {
                aborted: AtomicBool::new(false),
            }),
        }
    }

    pub fn abort(&self) {
        self.inner.aborted.store(true, Ordering::Relaxed);
    }

    pub fn is_aborted(&self) -> bool {
        self.inner.aborted.load(Ordering::Relaxed)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolSession {
    pub agent_id: String,
    pub node_id: String,
    pub conversation_id: String,
    pub user_id: String,
    pub working_dir: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ToolCallContext {
    pub agent_id: Option<String>,
    pub working_dir: Option<String>,
    pub signal: AbortSignal,
    pub session: ToolSession,
}

pub struct PreparedTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub execute: ToolFn,
}

pub trait StreamSink: Send + Sync {
    fn emit(&self, event: &StreamEvent);
}

#[derive(Clone, Default)]
pub struct ToolBinding {
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub working_dir: Option<String>,
    pub node_id: Option<String>,
    pub user_id: Option<String>,
    pub hooks: Option<Arc<HookPipeline>>,
    pub stream: Option<Arc<dyn StreamSink>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolImage {
    pub data: Option<String>,
    pub url: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum ToolResultContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image-data")]
    ImageData {
        data: String,
        #[serde(rename = "mediaType")]
        media_type: String,
    },
    #[serde(rename = "image-url")]
    ImageUrl { url: String },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum ToolResultOutput {
    #[serde(rename = "text")]
    Text { value: String },
    #[serde(rename = "content")]
    Content { value: Vec<ToolResultContent> },
}

pub struct AiSdkTool {
    name: String,
    description: String,
    parameters: Value,
    execute_fn: ToolFn,
    binding: ToolBinding,
}

impl AiSdkTool {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn parameters(&self) -> &Value {
        &self.parameters
    }

    pub async fn execute(&self, input: &Value, signal: Option<AbortSignal>) -> ToolResult {
        let tool = PreparedTool {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
            execute: Arc::clone(&self.execute_fn),
        };
        execute_tool(&tool, input, &self.binding, signal).await
    }

    pub fn to_model_output(&self, output: &ToolResult) -> ToolResultOutput {
        to_tool_result_output(output)
    }
}

pub struct ToolSet {
    tools: BTreeMap<String, AiSdkTool>,
}

impl ToolSet {
    pub fn get(&self, name: &str) -> Option<&AiSdkTool> {
        self.tools.get(name)
    }

    pub fn names(&self) -> Vec<&str> {
        self.tools.keys().map(String::as_str).collect()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

pub fn to_ai_sdk_tools(tools: Vec<PreparedTool>, binding: ToolBinding) -> ToolSet {
    let mut set = BTreeMap::new();
    for tool in tools {
        let name = tool.name.clone();
        set.insert(
            name,
            AiSdkTool {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                execute_fn: tool.execute,
                binding: binding.clone(),
            },
        );
    }
    ToolSet { tools: set }
}

pub fn build_local_session(binding: &ToolBinding) -> ToolSession {
    let node_env = std::env::var("RIVETOS_NODE_ID").ok();
    let user_env = std::env::var("RIVETOS_USER_ID").ok();
    build_local_session_with_env(binding, node_env.as_deref(), user_env.as_deref())
}

pub fn build_local_session_with_env(
    binding: &ToolBinding,
    node_env: Option<&str>,
    user_env: Option<&str>,
) -> ToolSession {
    ToolSession {
        agent_id: binding
            .agent_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        node_id: binding.node_id.clone().unwrap_or_else(|| match node_env {
            Some(value) => value.to_string(),
            None => "local".to_string(),
        }),
        conversation_id: binding
            .session_id
            .clone()
            .unwrap_or_else(|| "ad-hoc".to_string()),
        user_id: binding.user_id.clone().unwrap_or_else(|| match user_env {
            Some(value) => value.to_string(),
            None => "owner".to_string(),
        }),
        working_dir: binding.working_dir.clone(),
        trace_id: binding.session_id.clone(),
    }
}

pub async fn execute_tool(
    tool: &PreparedTool,
    input: &Value,
    binding: &ToolBinding,
    signal: Option<AbortSignal>,
) -> ToolResult {
    let mut args = shape_args(input);
    if let Some(hooks) = binding.hooks.as_ref() {
        let mut before = HookContext::tool_before(tool.name.clone(), args);
        before.agent_id = binding.agent_id.clone();
        before.session_id = binding.session_id.clone();
        let _ = hooks.run(&mut before).await;
        if before.blocked == Some(true) {
            let reason = before
                .block_reason
                .unwrap_or_else(|| "Blocked by safety hook".to_string());
            return ToolResult::Text(format!("Blocked: {reason}"));
        }
        args = before.args.unwrap_or_default();
    }
    if let Some(stream) = binding.stream.as_ref() {
        let mut metadata = Map::new();
        metadata.insert("tool".to_string(), Value::String(tool.name.clone()));
        metadata.insert("args".to_string(), Value::Object(summarize_args(&args)));
        stream.emit(&StreamEvent {
            r#type: StreamEventType::ToolStart,
            content: format!("🔧 {}", tool.name),
            metadata: Some(metadata),
        });
    }
    let session = build_local_session(binding);
    let signal = signal.unwrap_or_default();
    let call_ctx = ToolCallContext {
        agent_id: binding.agent_id.clone(),
        working_dir: binding.working_dir.clone(),
        signal: signal.clone(),
        session,
    };
    let started = epoch_ms();
    let raw = match (tool.execute)(args.clone(), signal, call_ctx).await {
        Ok(result) => result,
        Err(err) => ToolResult::Text(format!("Error: {}", err.message)),
    };
    let elapsed = epoch_ms().saturating_sub(started);
    let text = tool_result_text(&raw);
    let is_error = tool_result_is_error(&raw);
    if let Some(stream) = binding.stream.as_ref() {
        let mark = if is_error { "❌" } else { "✅" };
        let preview = js_slice(&text, 0, Some(200));
        let mut metadata = Map::new();
        metadata.insert("tool".to_string(), Value::String(tool.name.clone()));
        stream.emit(&StreamEvent {
            r#type: StreamEventType::ToolResult,
            content: format!("{mark} {}: {preview}", tool.name),
            metadata: Some(metadata),
        });
    }
    if let Some(hooks) = binding.hooks.as_ref() {
        let mut after = HookContext::tool_after(
            tool.name.clone(),
            args,
            raw.clone(),
            elapsed,
            is_error,
        );
        after.agent_id = binding.agent_id.clone();
        after.session_id = binding.session_id.clone();
        let _ = hooks.run(&mut after).await;
    }
    raw
}

pub fn summarize_args(args: &Map<String, Value>) -> Map<String, Value> {
    let mut summary = Map::new();
    for (key, value) in args {
        if let Value::String(text) = value {
            if utf16_len(text) > 200 {
                let cut = js_slice(text, 0, Some(200));
                summary.insert(key.clone(), Value::String(format!("{cut}…")));
                continue;
            }
        }
        summary.insert(key.clone(), value.clone());
    }
    summary
}

pub fn tool_result_text(result: &ToolResult) -> String {
    match result {
        ToolResult::Text(text) => text.clone(),
        ToolResult::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

pub fn tool_result_images(result: &ToolResult) -> Vec<ToolImage> {
    match result {
        ToolResult::Text(_) => Vec::new(),
        ToolResult::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Image {
                    data,
                    url,
                    mime_type,
                } => Some(ToolImage {
                    data: data.clone(),
                    url: url.clone(),
                    mime_type: mime_type.clone(),
                }),
                _ => None,
            })
            .collect(),
    }
}

pub fn tool_result_has_images(result: &ToolResult) -> bool {
    match result {
        ToolResult::Text(_) => false,
        ToolResult::Parts(parts) => parts
            .iter()
            .any(|part| matches!(part, ContentPart::Image { .. })),
    }
}

pub fn tool_result_is_error(result: &ToolResult) -> bool {
    tool_result_text(result).starts_with("Error")
}

pub fn to_tool_result_output(result: &ToolResult) -> ToolResultOutput {
    if let ToolResult::Text(text) = result {
        return ToolResultOutput::Text { value: text.clone() };
    }
    if !tool_result_has_images(result) {
        return ToolResultOutput::Text {
            value: tool_result_text(result),
        };
    }
    let text = tool_result_text(result);
    let mut value = Vec::new();
    if !text.is_empty() {
        value.push(ToolResultContent::Text { text });
    }
    for image in tool_result_images(result) {
        if let Some(data) = present(image.data) {
            value.push(ToolResultContent::ImageData {
                data,
                media_type: image.mime_type.unwrap_or_else(|| "image/jpeg".to_string()),
            });
        } else if let Some(url) = present(image.url) {
            value.push(ToolResultContent::ImageUrl { url });
        }
    }
    ToolResultOutput::Content { value }
}

fn present(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn shape_args(input: &Value) -> Map<String, Value> {
    match input {
        Value::Object(map) => map.clone(),
        other => {
            let mut wrapped = Map::new();
            wrapped.insert("value".to_string(), other.clone());
            wrapped
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_local_session, build_local_session_with_env, summarize_args, to_tool_result_output,
        tool_result_has_images,
        tool_result_images, tool_result_is_error, tool_result_text, AbortSignal, ToolBinding,
        ToolResultContent, ToolResultOutput,
    };
    use protocol::{ContentPart, ToolResult};
    use serde_json::json;

    #[test]
    fn session_defaults_keep_empty_env_strings() {
        let binding = ToolBinding::default();
        let session = build_local_session_with_env(&binding, None, None);
        assert_eq!(session.agent_id, "unknown");
        assert_eq!(session.node_id, "local");
        assert_eq!(session.conversation_id, "ad-hoc");
        assert_eq!(session.user_id, "owner");
        assert_eq!(session.trace_id, None);
        let empty = build_local_session_with_env(&binding, Some(""), Some(""));
        assert_eq!(empty.node_id, "");
        assert_eq!(empty.user_id, "");
        let explicit = ToolBinding {
            agent_id: Some("owner".to_string()),
            session_id: Some("sess-1".to_string()),
            node_id: Some("node".to_string()),
            user_id: Some("user".to_string()),
            working_dir: Some("/tmp/work".to_string()),
            ..ToolBinding::default()
        };
        let set = build_local_session_with_env(&explicit, Some("ignored"), Some("ignored"));
        let via_process_env = build_local_session(&explicit);
        assert_eq!(via_process_env.agent_id, "owner");
        assert_eq!(via_process_env.node_id, "node");
        assert_eq!(set.agent_id, "owner");
        assert_eq!(set.node_id, "node");
        assert_eq!(set.conversation_id, "sess-1");
        assert_eq!(set.user_id, "user");
        assert_eq!(set.working_dir.as_deref(), Some("/tmp/work"));
        assert_eq!(set.trace_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn argument_summary_truncates_at_200_utf16_units() {
        let mut args = serde_json::Map::new();
        args.insert("short".to_string(), json!("ok"));
        args.insert("long".to_string(), json!("x".repeat(201)));
        args.insert("exact".to_string(), json!("y".repeat(200)));
        let summary = summarize_args(&args);
        let long = format!("{}…", "x".repeat(200));
        let exact = "y".repeat(200);
        assert_eq!(summary.get("short"), Some(&json!("ok")));
        assert_eq!(
            summary.get("long").and_then(|value| value.as_str()),
            Some(long.as_str())
        );
        assert_eq!(
            summary.get("exact").and_then(|value| value.as_str()),
            Some(exact.as_str())
        );
    }

    #[test]
    fn tool_result_helpers_and_model_output() {
        let text = ToolResult::Text("Error: boom".to_string());
        assert!(tool_result_is_error(&text));
        assert!(!tool_result_has_images(&text));
        assert!(tool_result_images(&text).is_empty());
        assert_eq!(
            to_tool_result_output(&text),
            ToolResultOutput::Text {
                value: "Error: boom".to_string()
            }
        );
        let plain = ToolResult::Text("Error".to_string());
        assert!(tool_result_is_error(&plain));
        assert!(!tool_result_is_error(&ToolResult::Text("ok".to_string())));
        let parts = ToolResult::Parts(vec![
            ContentPart::Text {
                text: "one".to_string(),
            },
            ContentPart::Text {
                text: " two".to_string(),
            },
            ContentPart::Video {
                data: None,
                url: Some("clip".to_string()),
                mime_type: None,
            },
        ]);
        assert_eq!(tool_result_text(&parts), "one two");
        assert!(!tool_result_has_images(&parts));
        assert_eq!(
            to_tool_result_output(&parts),
            ToolResultOutput::Text {
                value: "one two".to_string()
            }
        );
        let image = ToolResult::Parts(vec![
            ContentPart::Text {
                text: "snap:".to_string(),
            },
            ContentPart::Image {
                data: Some("aGVsbG8=".to_string()),
                url: None,
                mime_type: Some("image/png".to_string()),
            },
            ContentPart::Image {
                data: None,
                url: Some("https://cdn.example.com/a.jpg".to_string()),
                mime_type: None,
            },
            ContentPart::Image {
                data: Some("YWJjZA==".to_string()),
                url: Some("https://ignored.example".to_string()),
                mime_type: None,
            },
            ContentPart::Image {
                data: Some(String::new()),
                url: Some("https://cdn.example.com/empty.jpg".to_string()),
                mime_type: None,
            },
        ]);
        assert!(tool_result_has_images(&image));
        assert_eq!(tool_result_images(&image).len(), 4);
        assert_eq!(
            to_tool_result_output(&image),
            ToolResultOutput::Content {
                value: vec![
                    ToolResultContent::Text {
                        text: "snap:".to_string()
                    },
                    ToolResultContent::ImageData {
                        data: "aGVsbG8=".to_string(),
                        media_type: "image/png".to_string(),
                    },
                    ToolResultContent::ImageUrl {
                        url: "https://cdn.example.com/a.jpg".to_string()
                    },
                    ToolResultContent::ImageData {
                        data: "YWJjZA==".to_string(),
                        media_type: "image/jpeg".to_string(),
                    },
                    ToolResultContent::ImageUrl {
                        url: "https://cdn.example.com/empty.jpg".to_string()
                    },
                ]
            }
        );
        let signal = AbortSignal::new();
        assert!(!signal.is_aborted());
        signal.abort();
        assert!(signal.is_aborted());
        assert_eq!(signal, signal.clone());
        assert_ne!(signal, AbortSignal::new());
    }
}
