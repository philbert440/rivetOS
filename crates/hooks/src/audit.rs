use std::path::{Path, PathBuf};
use std::sync::Arc;

use protocol::js::{JsObject, JsString, JsValue};
use protocol::{HookEventName, JsNumber};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use crate::context::HookContext;
use crate::handler::{BoxFuture, HookErrorMode, HookFailure, HookHandler, HookSignal};
use crate::pipeline::HookRegistration;

const SECRET_KEYS: &[&str] = &["password", "token", "secret", "api_key", "apiKey", "key"];
pub const AUDIT_STRING_CAP: usize = 500;

fn now_iso() -> String {
    protocol::js::to_iso_string(protocol::js::date_now()).unwrap_or_default()
}

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
    pub args: JsValue,
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

pub fn sanitize_args(args: &Map<String, Value>) -> JsValue {
    let mut sanitized = JsObject::new();
    for (key, value) in args {
        let stored = if is_secret_key(key) {
            JsValue::from_text("[REDACTED]")
        } else if let Value::String(text) = value {
            let units: Vec<u16> = text.encode_utf16().collect();
            if units.len() > AUDIT_STRING_CAP {
                let mut cut = units[..AUDIT_STRING_CAP].to_vec();
                let suffix = format!("… [{} chars]", units.len());
                cut.extend(suffix.encode_utf16());
                JsValue::String(JsString::from_units(cut))
            } else {
                JsValue::String(JsString::from_units(units))
            }
        } else {
            protocol::js::from_serde(value)
        };
        sanitized.insert(JsString::from_text(key), stored);
    }
    JsValue::Object(sanitized)
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
        timestamp: now_iso(),
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
        timestamp: now_iso(),
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
    utc_day: Option<String>,
}

impl JsonlAuditWriter {
    pub fn new(workspace_dir: impl Into<PathBuf>) -> Self {
        Self {
            workspace_dir: workspace_dir.into(),
            utc_day: None,
        }
    }

    pub fn with_utc_day(mut self, day: impl Into<String>) -> Self {
        self.utc_day = Some(day.into());
        self
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
        let day = self
            .utc_day
            .clone()
            .unwrap_or_else(crate::time_format::utc_date);
        let path = self.path_for(&day);
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
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await?;
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
    use protocol::js::{JsObject, JsValue, from_serde, stringify};
    use serde_json::{Map, Number, Value, json};

    fn text_at(value: &JsValue, key: &str) -> Option<String> {
        value.get(key).and_then(JsValue::as_str).map(str::to_string)
    }

    #[test]
    fn secret_key_check_follows_the_typescript_set() {
        let mut args = Map::new();
        args.insert(
            "token".to_string(),
            Value::String("super-secret-123".to_string()),
        );
        args.insert("apiKey".to_string(), Value::String("abc".to_string()));
        args.insert("API_KEY".to_string(), Value::String("abc".to_string()));
        args.insert("api_key".to_string(), Value::String("abc".to_string()));
        args.insert("command".to_string(), Value::String("test".to_string()));
        args.insert("nested".to_string(), json!({"token": "keep"}));
        let sanitized = sanitize_args(&args);
        assert_eq!(text_at(&sanitized, "token").as_deref(), Some("[REDACTED]"));
        assert_eq!(text_at(&sanitized, "apiKey").as_deref(), Some("abc"));
        assert_eq!(
            text_at(&sanitized, "API_KEY").as_deref(),
            Some("[REDACTED]")
        );
        assert_eq!(
            text_at(&sanitized, "api_key").as_deref(),
            Some("[REDACTED]")
        );
        assert_eq!(
            sanitized.get("nested").map(stringify),
            Some(stringify(&from_serde(&json!({"token": "keep"}))))
        );
        let long = "x".repeat(1000);
        args.insert("content".to_string(), Value::String(long));
        let truncated = sanitize_args(&args);
        let expected = format!("{}… [1000 chars]", "x".repeat(500));
        assert_eq!(
            text_at(&truncated, "content").as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn arguments_stringify_like_javascript() {
        let mut args = Map::new();
        args.insert(
            "amount".to_string(),
            Value::Number(Number::from_f64(1.0).expect("finite")),
        );
        args.insert("10".to_string(), Value::String("a".to_string()));
        args.insert("2".to_string(), Value::String("b".to_string()));
        let text = format!("{}😀", "a".repeat(499));
        args.insert("note".to_string(), Value::String(text));
        let sanitized = sanitize_args(&args);
        let wire = stringify(&sanitized);
        assert!(
            wire.starts_with(r#"{"2":"b","10":"a","#),
            "array-index keys are emitted before other keys, in numeric order"
        );
        assert!(
            wire.contains(r#""amount":1"#) && !wire.contains("1.0"),
            "JSON.stringify prints the integer 1 for the binary64 value 1"
        );
        assert!(
            wire.contains(r#"\ud83d… [501 chars]"#) && !wire.contains("\\ude00"),
            "slice(0, 500) keeps the lone high surrogate of an emoji that starts at unit 499"
        );
    }

    #[test]
    fn duration_serializes_as_a_json_integer() {
        let entry = super::AuditEntry {
            timestamp: "2026-10-10T00:00:00.000Z".to_string(),
            event: protocol::HookEventName::ToolAfter,
            tool_name: "shell".to_string(),
            args: JsValue::Object(JsObject::new()),
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
        assert!(text.contains("\"args\":{}"));
        let mut units = vec![u16::from(b'a'); 499];
        units.push(0xD83D);
        units.extend("… [501 chars]".encode_utf16());
        let mut object = JsObject::new();
        object.insert(
            protocol::js::JsString::from_text("note"),
            JsValue::String(protocol::js::JsString::from_units(units)),
        );
        let entry = super::AuditEntry {
            args: JsValue::Object(object),
            ..entry
        };
        let line = serde_json::to_string(&entry).expect("json");
        assert!(line.contains(r"\ud83d"));
        let parsed: super::AuditEntry = serde_json::from_str(&line).expect("parse");
        assert_eq!(parsed.args, entry.args);
    }
}
