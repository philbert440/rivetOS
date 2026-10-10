use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use protocol::MessageRole;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::env::{EnvLookup, ProcessEnv};
use crate::transport::CaptureUser;

pub type CaptureRole = MessageRole;

pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

pub type HttpExchange = Arc<dyn Fn(&str) -> Result<HttpReply, String> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureMessage {
    pub event_id: String,
    pub role: CaptureRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_args: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureBatch {
    pub session_key: String,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalize: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub messages: Vec<CaptureMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureResult {
    #[serde(default = "default_true")]
    pub ok: bool,
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub inserted: u64,
    #[serde(default)]
    pub skipped: u64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CaptureRedactionOptions {
    pub enabled: Option<bool>,
    pub builtins: Option<bool>,
    pub patterns: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub enum UserSource {
    #[default]
    FromEnv,
    Owner,
    Routed(CaptureUser),
}

pub struct CaptureWriterOptions {
    pub den_url: String,
    pub user: UserSource,
    pub spool_dir: Option<PathBuf>,
    pub log: Option<LogFn>,
    pub now_ms: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub max_chunk_bytes: Option<f64>,
    pub redaction: Option<CaptureRedactionOptions>,
    pub env: Arc<dyn EnvLookup>,
    pub ca_path: Option<PathBuf>,
    pub timeout: Duration,
    pub exchange: Option<HttpExchange>,
}

impl CaptureWriterOptions {
    pub fn new(den_url: impl Into<String>) -> Self {
        Self {
            den_url: den_url.into(),
            user: UserSource::FromEnv,
            spool_dir: None,
            log: None,
            now_ms: None,
            max_chunk_bytes: None,
            redaction: None,
            env: Arc::new(ProcessEnv),
            ca_path: None,
            timeout: Duration::from_secs(30),
            exchange: None,
        }
    }
}
