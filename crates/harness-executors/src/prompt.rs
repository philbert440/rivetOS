use protocol::js::{JsValue, js_trim};
use protocol::{
    CriterionSelfReport, ParsedArtifact, ParsedCriterion, TaskArtifact, TaskResult, TaskVerdict,
    parse_session_id_str, parse_task_result,
};
use transcripts::value::{slice_text, text_units};

use crate::model::{AcceptanceCriterion, TaskSpec, UsageAcc, result_with_output};

pub const PROMPT_MAX_BYTES: usize = 96_000;
pub const EMPTY_PROMPT_PLACEHOLDER: &str = "(no instruction was provided for this turn)";
pub const RESUME_TRANSCRIPT_MAX_CHARS: usize = 24_000;
pub const RESUME_MESSAGE_MAX_CHARS: isize = 2_000;
pub const RESUME_HISTORY_LIMIT: usize = 1_000;

const FENCE: &str = "\
### Structured result (REQUIRED)
You must report a structured result (verdict/summary/artifacts/
criteriaSelfReport) at the end of the task. IMPORTANT: \"failed\" means
the task itself failed and cannot proceed. If you are pausing to wait
for input or a follow-up, use verdict \"completed\" with a summary of
progress so far — the session stays resumable.
End your FINAL message with a fenced code block labeled TASK_RESULT
containing this shape:

```TASK_RESULT
{
  \"verdict\": \"completed\" | \"failed\",
  \"summary\": \"one-paragraph summary of what you did\",
  \"artifacts\": [{ \"kind\": \"file\" | \"url\" | \"commit\" | \"message\", \"ref\": \"...\", \"note\": \"...\" }],
  \"criteriaSelfReport\": [{ \"id\": \"<criterion id>\", \"met\": true, \"evidence\": \"...\" }]
}
```";

pub fn task_result_fence_instructions() -> &'static str {
    FENCE
}

pub fn clamp_prompt(text: &str) -> String {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return EMPTY_PROMPT_PLACEHOLDER.to_string();
    }
    if trimmed.len() <= PROMPT_MAX_BYTES {
        return trimmed.to_string();
    }
    let head = utf8_prefix(trimmed, PROMPT_MAX_BYTES);
    format!("{head}\n\n…[prompt truncated by RivetOS at {PROMPT_MAX_BYTES} bytes]")
}

fn utf8_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let next = index + ch.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    &text[..end]
}

pub fn criteria_block(criteria: &[AcceptanceCriterion]) -> String {
    if criteria.is_empty() {
        return String::new();
    }
    let lines = criteria
        .iter()
        .map(|criterion| format!("- [{}] {}", criterion.id, criterion.description))
        .collect::<Vec<_>>()
        .join("\n");
    format!("### Acceptance criteria\n{lines}")
}

pub fn build_task_scaffold(spec: &TaskSpec, working_directory: Option<&str>) -> String {
    let mut parts = vec![
        "## Task Context".to_string(),
        "You are executing a delegated RivetOS task. Complete it thoroughly.".to_string(),
    ];
    if !spec.resolved_context.is_empty() {
        parts.push(format!("### Context\n{}", spec.resolved_context));
    }
    let criteria = criteria_block(&spec.acceptance_criteria);
    if !criteria.is_empty() {
        parts.push(criteria);
    }
    if let Some(cwd) = working_directory {
        parts.push(format!("Working directory: {cwd}"));
    }
    if let Some(extra) = spec.system_prompt_append.as_deref()
        && !extra.is_empty()
    {
        parts.push(extra.to_string());
    }
    parts.push(task_result_fence_instructions().to_string());
    parts.join("\n\n")
}

pub fn build_turn_prompt(scaffold: &str, transcript: &str, message: &str) -> String {
    let mut parts = Vec::new();
    if !scaffold.is_empty() {
        parts.push(scaffold.to_string());
    }
    if !transcript.is_empty() {
        parts.push(transcript.to_string());
    }
    parts.push(format!("## This turn\n{message}"));
    parts.join("\n\n")
}

#[derive(Clone, Debug)]
pub struct HistoryMessage {
    pub role: String,
    pub content: Option<String>,
}

pub fn render_resume_transcript(history: &[HistoryMessage]) -> String {
    let mut lines = Vec::new();
    for message in history {
        if message.role != "user" && message.role != "assistant" {
            continue;
        }
        let Some(content) = message.content.as_deref() else {
            continue;
        };
        if js_trim(content).is_empty() {
            continue;
        }
        let body = if text_units(content) > RESUME_MESSAGE_MAX_CHARS as usize {
            format!(
                "{}\n…[truncated]",
                slice_text(content, 0, Some(RESUME_MESSAGE_MAX_CHARS))
            )
        } else {
            content.to_string()
        };
        lines.push(format!("[{}]\n{body}", message.role));
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut total = lines.iter().map(|line| text_units(line) + 2).sum::<usize>();
    let mut start = 0;
    while total > RESUME_TRANSCRIPT_MAX_CHARS && start + 1 < lines.len() {
        total -= text_units(&lines[start]) + 2;
        start += 1;
    }
    let dropped = if start > 0 {
        format!("({start} earlier message(s) omitted)\n\n")
    } else {
        String::new()
    };
    let kept = lines[start..].join("\n\n");
    format!("### Prior conversation (task resumed — do NOT redo completed work)\n{dropped}{kept}")
}

pub fn canonical_session_id(prefix: &str, native: Option<&str>) -> Option<String> {
    let native = native?;
    if native.is_empty() {
        return None;
    }
    if prefix == "opencode" && native.starts_with("opencode:") {
        return Some(native.to_string());
    }
    if parse_session_id_str(native).is_ok() {
        return Some(native.to_string());
    }
    if native != js_trim(native) {
        return Some(native.to_string());
    }
    Some(format!("{prefix}:{native}"))
}

pub fn variant_for_effort(effort: Option<&str>) -> Option<String> {
    let effort = effort?;
    if effort.is_empty() {
        return None;
    }
    let key = js_trim(effort).to_lowercase();
    if key.is_empty() {
        return None;
    }
    match key.as_str() {
        "low" | "minimal" => Some("minimal".to_string()),
        "medium" | "default" => None,
        "high" => Some("high".to_string()),
        "xhigh" | "max" => Some("max".to_string()),
        _ => None,
    }
}

fn task_artifacts(parsed: &[ParsedArtifact]) -> Vec<TaskArtifact> {
    parsed
        .iter()
        .filter_map(|item| {
            Some(TaskArtifact {
                kind: item.kind()?,
                r#ref: item.r#ref()?.to_string(),
                note: item.note().and_then(JsValue::as_str).map(str::to_string),
            })
        })
        .collect()
}

fn task_criteria(parsed: Option<Vec<ParsedCriterion>>) -> Option<Vec<CriterionSelfReport>> {
    parsed.map(|items| {
        items
            .iter()
            .filter_map(|item| {
                Some(CriterionSelfReport {
                    id: item.id()?.to_string(),
                    met: item.met()?,
                    evidence: item
                        .evidence()
                        .and_then(JsValue::as_str)
                        .map(str::to_string),
                })
            })
            .collect()
    })
}

pub fn finish_from_text(text: &str, usage: &UsageAcc) -> TaskResult {
    if let Some(parsed) = parse_task_result(text) {
        return result_with_output(
            TaskResult {
                verdict: parsed.verdict,
                summary: parsed.summary,
                output: parsed.output.clone(),
                artifacts: task_artifacts(&parsed.artifacts),
                criteria_self_report: task_criteria(parsed.criteria_self_report),
                usage: usage.to_usage(),
                error: None,
            },
            text,
        );
    }
    result_with_output(
        TaskResult {
            verdict: TaskVerdict::Completed,
            summary: text.to_string(),
            output: None,
            artifacts: Vec::new(),
            criteria_self_report: None,
            usage: usage.to_usage(),
            error: None,
        },
        text,
    )
}

pub fn killed_result(reason: Option<&str>, text: &str, usage: &UsageAcc) -> TaskResult {
    let summary = reason.unwrap_or("Killed").to_string();
    TaskResult {
        verdict: TaskVerdict::Killed,
        summary: summary.clone(),
        output: if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        },
        artifacts: Vec::new(),
        criteria_self_report: None,
        usage: usage.to_usage(),
        error: reason.map(str::to_string),
    }
}

pub fn failed_text(summary: &str, text: &str, usage: &UsageAcc) -> TaskResult {
    TaskResult {
        verdict: TaskVerdict::Failed,
        summary: summary.to_string(),
        output: if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        },
        artifacts: Vec::new(),
        criteria_self_report: None,
        usage: usage.to_usage(),
        error: Some(summary.to_string()),
    }
}
