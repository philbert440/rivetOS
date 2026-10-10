use std::path::{Path, PathBuf};
use std::sync::Arc;

use protocol::{HookEventName, JsNumber};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use crate::context::HookContext;
use crate::handler::{BoxFuture, HookErrorMode, HookFailure, HookHandler, HookSignal};
use crate::js_text::{js_slice, utf16_len};
use crate::pipeline::HookRegistration;
use crate::time_format::iso_timestamp;

const SECRET_KEYS: &[&str] = &["password", "token", "secret", "api_key", "apiKey", "key"];
pub const AUDIT_STRING_CAP: usize = 500;

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct AuditError {
    pub message: String,
}

impl AuditError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for AuditError {
    fn from(err: std::io::Error) -> Self {
        Self::new(err.to_string())
    }
}

impl From<serde_json::Error> for AuditError {
    fn from(err: serde_json::Error) -> Self {
        Self::new(err.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub timestamp: String,
    pub event: HookEventName,
    pub tool_name: String,
    pub args: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

pub trait AuditWriter: Send + Sync {
    fn write<'a>(&'a self, entry: &'a AuditEntry) -> BoxFuture<'a, Result<(), AuditError>>;
}

pub fn sanitize_args(args: &Map<String, Value>) -> Map<String, Value> {
    let mut sanitized = Map::new();
    for (key, value) in args {
        if is_secret_key(key) {
            sanitized.insert(key.clone(), Value::String("[REDACTED]".to_string()));
        } else if let Value::String(text) = value {
            if utf16_len(text) > AUDIT_STRING_CAP {
                let len = utf16_len(text);
                let cut = js_slice(text, 0, Some(AUDIT_STRING_CAP as i64));
                sanitized.insert(key.clone(), Value::String(format!("{cut}… [{len} chars]")));
            } else {
                sanitized.insert(key.clone(), Value::String(text.clone()));
            }
        } else {
            sanitized.insert(key.clone(), value.clone());
        }
    }
    sanitized
}

fn is_secret_key(key: &str) -> bool {
    let folded = key.to_lowercase();
    SECRET_KEYS.iter().any(|candidate| *candidate == folded)
}

pub fn create_audit_hooks(writer: Arc<dyn AuditWriter>) -> Vec<HookRegistration> {
    let before_writer = Arc::clone(&writer);
    let after_writer = writer;
    vec![
        HookRegistration {
            id: "safety:audit-before".to_string(),
            event: HookEventName::ToolBefore,
            handler: HookHandler::from_future(move |ctx| {
                let writer = Arc::clone(&before_writer);
                Box::pin(async move { audit_before(ctx, writer.as_ref()).await })
            }),
            priority: 90,
            on_error: HookErrorMode::Continue,
            agent_filter: None,
            tool_filter: None,
            description: Some("Logs tool invocation to audit trail (before)".to_string()),
            enabled: true,
        },
        HookRegistration {
            id: "safety:audit-after".to_string(),
            event: HookEventName::ToolAfter,
            handler: HookHandler::from_future(move |ctx| {
                let writer = Arc::clone(&after_writer);
                Box::pin(async move { audit_after(ctx, writer.as_ref()).await })
            }),
            priority: 90,
            on_error: HookErrorMode::Continue,
            agent_filter: None,
            tool_filter: None,
            description: Some("Logs tool result to audit trail (after)".to_string()),
            enabled: true,
        },
    ]
}

async fn audit_before(
    ctx: &mut HookContext,
    writer: &dyn AuditWriter,
) -> Result<HookSignal, HookFailure> {
    let entry = AuditEntry {
        timestamp: iso_timestamp(),
        event: HookEventName::ToolBefore,
        tool_name: ctx.tool_name.clone().unwrap_or_default(),
        args: sanitize_args(ctx.args.as_ref().unwrap_or(&Map::new())),
        agent_id: ctx.agent_id.clone(),
        session_id: ctx.session_id.clone(),
        blocked: ctx.blocked,
        block_reason: ctx.block_reason.clone(),
        duration_ms: None,
        is_error: None,
    };
    writer
        .write(&entry)
        .await
        .map_err(|err| HookFailure::new(err.message))?;
    Ok(HookSignal::Continue)
}

async fn audit_after(
    ctx: &mut HookContext,
    writer: &dyn AuditWriter,
) -> Result<HookSignal, HookFailure> {
    let entry = AuditEntry {
        timestamp: iso_timestamp(),
        event: HookEventName::ToolAfter,
        tool_name: ctx.tool_name.clone().unwrap_or_default(),
        args: sanitize_args(ctx.args.as_ref().unwrap_or(&Map::new())),
        agent_id: ctx.agent_id.clone(),
        session_id: ctx.session_id.clone(),
        blocked: None,
        block_reason: None,
        duration_ms: ctx.duration_ms.map(JsNumber::from),
        is_error: ctx.is_error,
    };
    writer
        .write(&entry)
        .await
        .map_err(|err| HookFailure::new(err.message))?;
    Ok(HookSignal::Continue)
}

pub struct JsonlAuditWriter {
    workspace_dir: PathBuf,
}

impl JsonlAuditWriter {
    pub fn new(workspace_dir: impl Into<PathBuf>) -> Self {
        Self {
            workspace_dir: workspace_dir.into(),
        }
    }

    pub fn path_for(&self, day: &str) -> PathBuf {
        self.workspace_dir
            .join(".data")
            .join("audit")
            .join(format!("{day}.jsonl"))
    }
}

impl AuditWriter for JsonlAuditWriter {
    fn write<'a>(&'a self, entry: &'a AuditEntry) -> BoxFuture<'a, Result<(), AuditError>> {
        let path = self.path_for(&crate::time_format::utc_date());
        Box::pin(async move { append_jsonl(&path, entry).await })
    }
}

async fn append_jsonl(path: &Path, entry: &AuditEntry) -> Result<(), AuditError> {
    crate::deadline::within_deadline(append_jsonl_inner(path, entry), || {
        AuditError::new("audit write timed out")
    })
    .await
}

async fn append_jsonl_inner(path: &Path, entry: &AuditEntry) -> Result<(), AuditError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await?;
        }
    }
    let mut line = serde_json::to_string(entry)?;
    line.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    file.write_all(line.as_bytes()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sanitize_args;
    use serde_json::{json, Map, Value};

    #[test]
    fn secret_key_check_follows_the_typescript_set() {
        let mut args = Map::new();
        args.insert("token".to_string(), Value::String("super-secret-123".to_string()));
        args.insert("apiKey".to_string(), Value::String("abc".to_string()));
        args.insert("API_KEY".to_string(), Value::String("abc".to_string()));
        args.insert("api_key".to_string(), Value::String("abc".to_string()));
        args.insert("command".to_string(), Value::String("test".to_string()));
        args.insert(
            "nested".to_string(),
            json!({"token": "keep"}),
        );
        let sanitized = sanitize_args(&args);
        assert_eq!(
            sanitized.get("token"),
            Some(&Value::String("[REDACTED]".to_string()))
        );
        assert_eq!(
            sanitized.get("apiKey"),
            Some(&Value::String("abc".to_string()))
        );
        assert_eq!(
            sanitized.get("API_KEY"),
            Some(&Value::String("[REDACTED]".to_string()))
        );
        assert_eq!(
            sanitized.get("api_key"),
            Some(&Value::String("[REDACTED]".to_string()))
        );
        assert_eq!(
            sanitized.get("nested"),
            Some(&json!({"token": "keep"}))
        );
        let long = "x".repeat(1000);
        args.insert("content".to_string(), Value::String(long));
        let truncated = sanitize_args(&args);
        let expected = format!("{}… [1000 chars]", "x".repeat(500));
        assert_eq!(
            truncated.get("content").and_then(Value::as_str),
            Some(expected.as_str())
        );
    }

    #[test]
    fn duration_serializes_as_a_json_integer() {
        let entry = super::AuditEntry {
            timestamp: "2026-10-10T00:00:00.000Z".to_string(),
            event: protocol::HookEventName::ToolAfter,
            tool_name: "shell".to_string(),
            args: Map::new(),
            agent_id: None,
            session_id: None,
            blocked: None,
            block_reason: None,
            duration_ms: Some(protocol::JsNumber::from(42_i64)),
            is_error: Some(false),
        };
        let text = serde_json::to_string(&entry).expect("json");
        assert!(text.contains("\"durationMs\":42"));
        assert!(!text.contains("42.0"));
        assert!(!text.contains("agentId"));
        assert!(text.contains("\"isError\":false"));
    }
}
