use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::error::StoreError;

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEntry {
    pub session_id: String,
    pub agent: String,
    pub channel: String,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<Map<String, Value>>,
    pub tool_result: Option<String>,
    pub metadata: Option<Map<String, Value>>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub agent: Option<String>,
    pub limit: Option<i64>,
    pub scope: Option<String>,
    pub user_id: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CaptureMessage {
    pub event_id: String,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<Value>,
    pub tool_result: Option<String>,
    pub metadata: Option<Map<String, Value>>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CaptureBatch {
    pub session_key: String,
    pub agent: String,
    pub channel: Option<String>,
    pub title: Option<String>,
    pub settings: Option<Map<String, Value>>,
    pub task_id: Option<String>,
    pub finalize: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub messages: Vec<CaptureMessage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectChoice {
    Default,
    Disabled,
    BasenameOnly,
}

#[derive(Debug, Clone)]
pub struct CaptureOptions {
    pub allow_filesystem: bool,
    pub owner_user_id: Option<String>,
    pub project: ProjectChoice,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self {
            allow_filesystem: true,
            owner_user_id: None,
            project: ProjectChoice::Default,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureResult {
    pub ok: bool,
    pub conversation_id: String,
    pub inserted: u64,
    pub skipped: u64,
}

#[derive(Debug, Clone, Default)]
pub struct BrowseFilter {
    pub role: Option<String>,
    pub agent: Option<String>,
    pub tool_name: Option<String>,
    pub tag: Option<String>,
    pub window: Option<String>,
    pub since: Option<String>,
    pub before: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ToolCallIn {
    pub id: Option<String>,
    pub name: String,
    pub input: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct IngestMessage {
    pub role: String,
    pub content: String,
    pub created_at: Option<String>,
    pub tool_calls: Vec<ToolCallIn>,
}

#[derive(Debug, Clone)]
pub struct IngestInput {
    pub session_id: String,
    pub messages: Vec<IngestMessage>,
    pub source: Option<String>,
    pub agent: Option<String>,
    pub persona: Option<String>,
    pub channel: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestOutput {
    pub session_id: String,
    pub ingested: u64,
    pub skipped: u64,
    pub ids: Vec<String>,
    pub source: String,
    pub agent: String,
    pub channel: String,
    pub persona: Option<String>,
    pub truncated: bool,
    pub full_content_length: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct StatsReport {
    pub dashboard: Value,
    pub markdown: String,
}

#[derive(Debug, Clone)]
pub struct HealthReport {
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
}

pub trait MemoryStore: Send + Sync {
    fn append(
        &self,
        entry: &MemoryEntry,
    ) -> impl std::future::Future<Output = Result<String, StoreError>> + Send;

    fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> impl std::future::Future<Output = Result<Value, StoreError>> + Send;

    fn get_context_for_turn(
        &self,
        query: &str,
        agent: &str,
        user_id: Option<&str>,
    ) -> impl std::future::Future<Output = Result<String, StoreError>> + Send;

    fn get_session_history(
        &self,
        session_id: &str,
        limit: Option<i64>,
    ) -> impl std::future::Future<Output = Result<Vec<HistoryMessage>, StoreError>> + Send;

    fn get_task_history(
        &self,
        task_id: &str,
        limit: Option<i64>,
    ) -> impl std::future::Future<Output = Result<Vec<HistoryMessage>, StoreError>> + Send;

    fn save_session_settings(
        &self,
        session_id: &str,
        settings: &Map<String, Value>,
    ) -> impl std::future::Future<Output = Result<(), StoreError>> + Send;

    fn load_session_settings(
        &self,
        session_id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Map<String, Value>>, StoreError>> + Send;

    fn capture(
        &self,
        batch: &CaptureBatch,
        options: &CaptureOptions,
    ) -> impl std::future::Future<Output = Result<CaptureResult, StoreError>> + Send;

    fn browse(
        &self,
        filter: &BrowseFilter,
    ) -> impl std::future::Future<Output = Result<Value, StoreError>> + Send;

    fn stats(&self) -> impl std::future::Future<Output = Result<StatsReport, StoreError>> + Send;

    fn health(
        &self,
        owner: bool,
    ) -> impl std::future::Future<Output = Result<HealthReport, StoreError>> + Send;

    fn tools(&self) -> Vec<ToolDescriptor>;

    fn tags(&self) -> impl std::future::Future<Output = Result<(), StoreError>> + Send;

    fn wiki(&self) -> Option<String>;

    fn ingest_session(
        &self,
        input: &IngestInput,
    ) -> impl std::future::Future<Output = Result<IngestOutput, StoreError>> + Send;

    fn get_full(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<String, StoreError>> + Send;
}
