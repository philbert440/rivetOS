use std::fmt;

use indexmap::IndexMap;
use protocol::JsNumber;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub fn make_step_id(label: &str, seq: i64) -> String {
    format!("{label}#{seq}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Json,
    File,
}

impl FieldType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Json => "json",
            Self::File => "file",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "string" => Some(Self::String),
            "number" => Some(Self::Number),
            "boolean" => Some(Self::Boolean),
            "json" => Some(Self::Json),
            "file" => Some(Self::File),
            _ => None,
        }
    }
}

impl fmt::Display for FieldType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Field {
    pub fn is_required(&self) -> bool {
        self.required != Some(false)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineStep {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBudgets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_runs: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowManifest {
    pub id: String,
    pub version: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input: Vec<Field>,
    pub output: Vec<Field>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<Vec<OutlineStep>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budgets: Option<WorkflowBudgets>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, rename = "maxTurns", skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<JsNumber>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            tools: None,
            model: None,
            max_turns: None,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentDef {
    pub name: String,
    pub path: String,
    pub prompt: String,
    pub config: AgentConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoadedWorkflow {
    pub dir: String,
    pub manifest: WorkflowManifest,
    pub run_path: String,
    pub agents: IndexMap<String, AgentDef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartedByType {
    Human,
    Agent,
    Workflow,
}

impl StartedByType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
            Self::Workflow => "workflow",
        }
    }
}

impl fmt::Display for StartedByType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartedBy {
    #[serde(rename = "type")]
    pub started_type: StartedByType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

impl StartedBy {
    pub fn new(started_type: StartedByType) -> Self {
        Self {
            started_type,
            id: None,
            extra: Map::new(),
        }
    }

    pub fn with_id(started_type: StartedByType, id: impl Into<String>) -> Self {
        Self {
            started_type,
            id: Some(id.into()),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentRef {
    pub run_id: String,
    pub step_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    PausedHuman,
    Done,
    Failed,
    Killed,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::PausedHuman => "paused_human",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Killed => "killed",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Killed)
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "running" => Some(Self::Running),
            "paused_human" => Some(Self::PausedHuman),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "killed" => Some(Self::Killed),
            _ => None,
        }
    }
}

impl fmt::Display for RunStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub workflow_id: String,
    pub version: String,
    pub started_by: StartedBy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<ParentRef>,
    pub case_dir: String,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Agent,
    Run,
    Human,
    Call,
    Done,
    Parallel,
}

impl StepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Run => "run",
            Self::Human => "human",
            Self::Call => "call",
            Self::Done => "done",
            Self::Parallel => "parallel",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "agent" => Some(Self::Agent),
            "run" => Some(Self::Run),
            "human" => Some(Self::Human),
            "call" => Some(Self::Call),
            "done" => Some(Self::Done),
            "parallel" => Some(Self::Parallel),
            _ => None,
        }
    }
}

impl fmt::Display for StepKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<JsNumber>,
    #[serde(default, rename = "costUsd", skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<JsNumber>,
}

impl StepUsage {
    pub fn tokens(tokens: f64) -> Self {
        Self {
            tokens: Some(JsNumber::from(tokens)),
            cost_usd: None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_none() && self.cost_usd.is_none()
    }

    pub fn token_f64(&self) -> Option<f64> {
        self.tokens.map(|value| value.as_f64())
    }

    pub fn cost_f64(&self) -> Option<f64> {
        self.cost_usd.map(|value| value.as_f64())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JournalEntry {
    #[serde(rename = "run_started", rename_all = "camelCase")]
    RunStarted {
        ts: String,
        run_id: String,
        workflow_id: String,
        version: String,
        input: Map<String, Value>,
        started_by: StartedBy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<ParentRef>,
    },
    #[serde(rename = "run_finished", rename_all = "camelCase")]
    RunFinished {
        ts: String,
        run_id: String,
        status: RunFinishedStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "step_started", rename_all = "camelCase")]
    StepStarted {
        ts: String,
        step_id: String,
        label: String,
        seq: i64,
        kind: StepKind,
    },
    #[serde(rename = "step_finished", rename_all = "camelCase")]
    StepFinished {
        ts: String,
        step_id: String,
        label: String,
        seq: i64,
        kind: StepKind,
        result: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<StepUsage>,
    },
    #[serde(rename = "step_failed", rename_all = "camelCase")]
    StepFailed {
        ts: String,
        step_id: String,
        label: String,
        seq: i64,
        kind: StepKind,
        error: String,
    },
    #[serde(rename = "gate_opened", rename_all = "camelCase")]
    GateOpened {
        ts: String,
        step_id: String,
        label: String,
        seq: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        fields: Vec<String>,
    },
    #[serde(rename = "gate_resolved", rename_all = "camelCase")]
    GateResolved {
        ts: String,
        step_id: String,
        label: String,
        seq: i64,
        values: Map<String, Value>,
    },
    #[serde(rename = "manifest_warn", rename_all = "camelCase")]
    ManifestWarn {
        ts: String,
        step_id: String,
        label: String,
        seq: i64,
        undeclared: Vec<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunFinishedStatus {
    Done,
    Failed,
    Killed,
}

impl RunFinishedStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Killed => "killed",
        }
    }
}

impl fmt::Display for RunFinishedStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl JournalEntry {
    pub fn entry_type(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "run_started",
            Self::RunFinished { .. } => "run_finished",
            Self::StepStarted { .. } => "step_started",
            Self::StepFinished { .. } => "step_finished",
            Self::StepFailed { .. } => "step_failed",
            Self::GateOpened { .. } => "gate_opened",
            Self::GateResolved { .. } => "gate_resolved",
            Self::ManifestWarn { .. } => "manifest_warn",
        }
    }

    pub fn label_seq(&self) -> Option<(&str, i64)> {
        match self {
            Self::StepStarted { label, seq, .. }
            | Self::StepFinished { label, seq, .. }
            | Self::StepFailed { label, seq, .. }
            | Self::GateOpened { label, seq, .. }
            | Self::GateResolved { label, seq, .. }
            | Self::ManifestWarn { label, seq, .. } => Some((label.as_str(), *seq)),
            Self::RunStarted { .. } | Self::RunFinished { .. } => None,
        }
    }

    pub fn to_json_line(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaseState {
    pub run: Run,
    pub fields: Map<String, Value>,
    pub document: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenGate {
    pub step_id: String,
    pub label: String,
    pub seq: i64,
    pub fields: Vec<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheSource {
    StepFinished,
    GateResolved,
}

impl CacheSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StepFinished => "step_finished",
            Self::GateResolved => "gate_resolved",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CachedStep {
    Hit { result: Value, from: CacheSource },
    Miss,
}

impl CachedStep {
    pub fn hit(&self) -> bool {
        matches!(self, Self::Hit { .. })
    }

    pub fn result(&self) -> Option<&Value> {
        match self {
            Self::Hit { result, .. } => Some(result),
            Self::Miss => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSummary {
    pub id: String,
    pub workflow_id: String,
    pub status: RunStatus,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub current: Option<String>,
    pub case_dir: String,
    pub nested: bool,
    pub parent_run_id: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunDetail {
    pub run: Run,
    pub fields: Map<String, Value>,
    pub journal: Vec<JournalEntry>,
    pub children: Vec<RunSummary>,
    pub open_gate: Option<OpenGate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDiagnostic {
    pub file: String,
    pub line: Option<i64>,
    pub severity: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowValidateResponse {
    pub ok: bool,
    pub diagnostics: Vec<WorkflowDiagnostic>,
}
