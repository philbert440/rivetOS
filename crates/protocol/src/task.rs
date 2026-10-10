use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TASK_RESULT_FENCE: &str = "TASK_RESULT";

crate::wire_enum! {
    pub enum TaskExecutorKind {
        ChatLoop => "chat-loop",
        HarnessSession => "harness-session",
        Mesh => "mesh",
    }
}

crate::wire_enum! {
    pub enum TaskStatus {
        Queued => "queued",
        Running => "running",
        AwaitingInput => "awaiting-input",
        Completed => "completed",
        Failed => "failed",
        Killed => "killed",
        Timeout => "timeout",
    }
}

crate::wire_enum! {
    pub enum TaskVerdict {
        Completed => "completed",
        Failed => "failed",
        Killed => "killed",
        Timeout => "timeout",
        BudgetExceeded => "budget-exceeded",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBudget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_wall_clock_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub turns: f64,
    pub wall_clock_ms: f64,
}

crate::wire_enum! {
    pub enum ArtifactKind {
        File => "file",
        Url => "url",
        Commit => "commit",
        Message => "message",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {
    pub kind: ArtifactKind,
    #[serde(rename = "ref")]
    pub r#ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriterionSelfReport {
    pub id: String,
    pub met: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub verdict: TaskVerdict,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub artifacts: Vec<TaskArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria_self_report: Option<Vec<CriterionSelfReport>>,
    pub usage: TaskUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTaskResult {
    pub verdict: TaskVerdict,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub artifacts: Vec<TaskArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria_self_report: Option<Vec<CriterionSelfReport>>,
}

pub fn parse_task_result(text: &str) -> Option<ParsedTaskResult> {
    let marker = format!("```{TASK_RESULT_FENCE}");
    let mut last_body: Option<&str> = None;
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find(&marker) {
        let marker_at = search_from + rel;
        let after = &text[marker_at + marker.len()..];
        if let Some(body_off) = fence_content_offset(after) {
            let body = &after[body_off..];
            if let Some(close) = body.find("```") {
                last_body = Some(&body[..close]);
                let next = marker_at + marker.len() + body_off + close + 3;
                if next <= search_from {
                    break;
                }
                search_from = next;
                continue;
            }
        }
        let next = marker_at + marker.len();
        if next <= search_from {
            break;
        }
        search_from = next;
    }
    parse_task_result_json(last_body?)
}

pub fn parse_task_result_json(json: &str) -> Option<ParsedTaskResult> {
    let value = serde_json::from_str::<Value>(json).ok()?;
    validate_shape(&value)
}

fn fence_content_offset(after_marker: &str) -> Option<usize> {
    let prefix_end = after_marker
        .char_indices()
        .find(|(_, ch)| !ch.is_whitespace())
        .map(|(index, _)| index)
        .unwrap_or(after_marker.len());
    let prefix = &after_marker[..prefix_end];
    let newline = prefix.rfind('\n')?;
    Some(newline + 1)
}

fn validate_shape(raw: &Value) -> Option<ParsedTaskResult> {
    let obj = raw.as_object()?;
    let verdict_text = obj.get("verdict")?.as_str()?;
    let verdict = coerce_verdict(verdict_text)?;
    let summary = obj.get("summary")?.as_str()?.to_string();
    let output = match obj.get("output") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    let artifacts = match obj.get("artifacts") {
        Some(Value::Array(items)) => items.iter().filter_map(parse_artifact).collect(),
        _ => Vec::new(),
    };
    let criteria_self_report = match obj.get("criteriaSelfReport") {
        Some(Value::Array(items)) => Some(items.iter().filter_map(parse_criterion).collect()),
        _ => None,
    };
    Some(ParsedTaskResult {
        verdict,
        summary,
        output,
        artifacts,
        criteria_self_report,
    })
}

fn coerce_verdict(verdict: &str) -> Option<TaskVerdict> {
    match verdict.parse::<TaskVerdict>().ok()? {
        TaskVerdict::Completed => Some(TaskVerdict::Completed),
        TaskVerdict::Failed
        | TaskVerdict::Killed
        | TaskVerdict::Timeout
        | TaskVerdict::BudgetExceeded => Some(TaskVerdict::Failed),
    }
}

fn parse_artifact(value: &Value) -> Option<TaskArtifact> {
    let obj = value.as_object()?;
    let kind = obj.get("kind")?.as_str()?.parse().ok()?;
    let r#ref = obj.get("ref")?.as_str()?.to_string();
    let note = match obj.get("note") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    Some(TaskArtifact { kind, r#ref, note })
}

fn parse_criterion(value: &Value) -> Option<CriterionSelfReport> {
    let obj = value.as_object()?;
    let id = obj.get("id")?.as_str()?.to_string();
    let met = obj.get("met")?.as_bool()?;
    let evidence = match obj.get("evidence") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    Some(CriterionSelfReport { id, met, evidence })
}
