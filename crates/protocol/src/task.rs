use serde::de::Deserializer;
use serde::ser::Error;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use crate::JsNumber;
use crate::js::{JsObject, JsValue, from_serde};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBudget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_usd: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_wall_clock_ms: Option<JsNumber>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub input_tokens: JsNumber,
    pub output_tokens: JsNumber,
    pub total_tokens: JsNumber,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<JsNumber>,
    pub turns: JsNumber,
    pub wall_clock_ms: JsNumber,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactKind {
    File,
    Url,
    Commit,
    Message,
    Other(String),
}

impl ArtifactKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::File => "file",
            Self::Url => "url",
            Self::Commit => "commit",
            Self::Message => "message",
            Self::Other(value) => value,
        }
    }
}

impl Serialize for ArtifactKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ArtifactKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let text = String::deserialize(deserializer)?;
        Ok(artifact_kind_from(&text))
    }
}

fn artifact_kind_from(text: &str) -> ArtifactKind {
    match text {
        "file" => ArtifactKind::File,
        "url" => ArtifactKind::Url,
        "commit" => ArtifactKind::Commit,
        "message" => ArtifactKind::Message,
        other => ArtifactKind::Other(other.to_string()),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedArtifact {
    object: JsObject,
}

impl ParsedArtifact {
    pub fn kind(&self) -> Option<ArtifactKind> {
        self.object
            .get("kind")
            .and_then(JsValue::as_str)
            .map(artifact_kind_from)
    }

    pub fn r#ref(&self) -> Option<&str> {
        self.object.get("ref").and_then(JsValue::as_str)
    }

    pub fn note(&self) -> Option<&JsValue> {
        self.object.get("note")
    }
}

impl Serialize for ParsedArtifact {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serialize_preserved(&self.object, serializer)
    }
}

impl<'de> Deserialize<'de> for ParsedArtifact {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match from_serde(&value) {
            JsValue::Object(object) => Ok(Self { object }),
            _ => Err(serde::de::Error::custom("artifact")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCriterion {
    object: JsObject,
}

impl ParsedCriterion {
    pub fn id(&self) -> Option<&str> {
        self.object.get("id").and_then(JsValue::as_str)
    }

    pub fn met(&self) -> Option<bool> {
        self.object.get("met").and_then(JsValue::as_bool)
    }

    pub fn evidence(&self) -> Option<&JsValue> {
        self.object.get("evidence")
    }
}

impl Serialize for ParsedCriterion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serialize_preserved(&self.object, serializer)
    }
}

fn serialize_preserved<S>(object: &JsObject, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let text = crate::js::stringify(&JsValue::Object(object.clone()));
    match serde_json::value::RawValue::from_string(text) {
        Ok(raw) => raw.serialize(serializer),
        Err(err) => Err(S::Error::custom(err)),
    }
}

impl<'de> Deserialize<'de> for ParsedCriterion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match from_serde(&value) {
            JsValue::Object(object) => Ok(Self { object }),
            _ => Err(serde::de::Error::custom("criterion")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTaskResult {
    pub verdict: TaskVerdict,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub artifacts: Vec<ParsedArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria_self_report: Option<Vec<ParsedCriterion>>,
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
    let value = crate::js::parse(json).ok()?;
    validate_shape(&value)
}

fn fence_content_offset(after_marker: &str) -> Option<usize> {
    let prefix_end = after_marker
        .char_indices()
        .find(|(_, ch)| !crate::js::is_js_whitespace(*ch))
        .map(|(index, _)| index)
        .unwrap_or(after_marker.len());
    let prefix = &after_marker[..prefix_end];
    let newline = prefix.rfind('\n')?;
    Some(newline + 1)
}

fn validate_shape(raw: &JsValue) -> Option<ParsedTaskResult> {
    let obj = raw.as_object()?;
    let verdict_text = obj.get("verdict")?.as_str()?;
    let verdict = coerce_verdict(verdict_text)?;
    let summary = obj.get("summary")?.as_str()?.to_string();
    let output = obj
        .get("output")
        .and_then(JsValue::as_str)
        .map(str::to_string);
    let artifacts = collect_artifacts(obj.get("artifacts"))?;
    let criteria_self_report = collect_criteria(obj.get("criteriaSelfReport"))?;
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

fn collect_artifacts(value: Option<&JsValue>) -> Option<Vec<ParsedArtifact>> {
    let Some(items) = value.and_then(JsValue::as_array) else {
        return Some(Vec::new());
    };
    let mut artifacts = Vec::new();
    for item in items {
        if item.is_null() {
            return None;
        }
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("ref").is_some_and(JsValue::is_string)
            && object.get("kind").is_some_and(JsValue::is_string)
        {
            artifacts.push(ParsedArtifact {
                object: object.clone(),
            });
        }
    }
    Some(artifacts)
}

fn collect_criteria(value: Option<&JsValue>) -> Option<Option<Vec<ParsedCriterion>>> {
    let Some(items) = value.and_then(JsValue::as_array) else {
        return Some(None);
    };
    let mut criteria = Vec::new();
    for item in items {
        if item.is_null() {
            return None;
        }
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("id").is_some_and(JsValue::is_string)
            && object.get("met").is_some_and(JsValue::is_boolean)
        {
            criteria.push(ParsedCriterion {
                object: object.clone(),
            });
        }
    }
    Some(Some(criteria))
}
