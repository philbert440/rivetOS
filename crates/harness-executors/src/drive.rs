use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures_util::Future;

use crate::model::{HandleParts, TaskEvent, UsageAcc, next_steer};
use crate::prompt::{
    HistoryMessage, build_task_scaffold, build_turn_prompt, failed_text, finish_from_text,
    killed_result, render_resume_transcript,
};
use crate::standard_helpers::now_ms;
use protocol::TaskResult;

use crate::model::TaskSpec;

#[derive(Clone, Debug)]
pub struct TurnCall {
    pub task_id: String,
    pub prompt: String,
    pub append_system_prompt: String,
    pub resume_native: Option<String>,
    pub message: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SpawnOutcome {
    pub text: String,
    pub native_id: Option<String>,
    pub error: Option<String>,
    pub resume_rejected: bool,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cost_usd: Option<f64>,
}

impl SpawnOutcome {
    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            text: String::new(),
            native_id: None,
            error: Some(error.into()),
            resume_rejected: false,
            input_tokens: 0.0,
            output_tokens: 0.0,
            cost_usd: None,
        }
    }

    pub fn rejected(error: impl Into<String>) -> Self {
        Self {
            text: String::new(),
            native_id: None,
            error: Some(error.into()),
            resume_rejected: true,
            input_tokens: 0.0,
            output_tokens: 0.0,
            cost_usd: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScaffoldMode {
    Inline,
    Append,
    AppendWithCwd,
}

pub type HistoryLoader =
    Arc<dyn Fn(&str, usize) -> Result<Vec<HistoryMessage>, String> + Send + Sync>;

pub struct HistorySource {
    pub get_task_history: Option<HistoryLoader>,
    pub get_session_history: Option<HistoryLoader>,
}

pub struct DrivePlan {
    pub harness: String,
    pub prefix: String,
    pub mode: ScaffoldMode,
    pub cwd: String,
    pub history: Option<Arc<HistorySource>>,
}

pub async fn drive<F, Fut>(
    spec: TaskSpec,
    parts: HandleParts,
    plan: DrivePlan,
    mut spawn: F,
) -> TaskResult
where
    F: FnMut(TurnCall) -> Fut,
    Fut: Future<Output = SpawnOutcome>,
{
    let DrivePlan {
        harness,
        prefix,
        mode,
        cwd,
        history,
    } = plan;
    let started = now_ms();
    let mut usage = UsageAcc::new();
    let scaffold = match mode {
        ScaffoldMode::Inline | ScaffoldMode::Append => build_task_scaffold(&spec, None),
        ScaffoldMode::AppendWithCwd => build_task_scaffold(&spec, Some(&cwd)),
    };
    let mut transcript = if spec.resume_message.is_some() {
        load_transcript(&spec, history.as_deref()).await
    } else {
        String::new()
    };
    let mut last_text = String::new();
    let mut last_error: Option<String> = None;
    let mut native: Option<String> = None;
    let mut message = Some(
        spec.resume_message
            .clone()
            .unwrap_or_else(|| spec.goal.clone()),
    );
    while let Some(current) = message.clone() {
        if parts.killed.load(Ordering::SeqCst) {
            break;
        }
        usage.turns += 1;
        parts.events.push(TaskEvent::TurnStart {
            ts: now_ms(),
            turn: usage.turns,
        });
        let inline = match mode {
            ScaffoldMode::Inline => scaffold.as_str(),
            ScaffoldMode::Append | ScaffoldMode::AppendWithCwd => "",
        };
        let prompt = build_turn_prompt(inline, &transcript, &current);
        let append = match mode {
            ScaffoldMode::Inline => String::new(),
            ScaffoldMode::Append | ScaffoldMode::AppendWithCwd => scaffold.clone(),
        };
        let mut outcome = spawn(TurnCall {
            task_id: spec.task_id.clone(),
            prompt,
            append_system_prompt: append,
            resume_native: native.clone(),
            message: current.clone(),
            model: spec.model.clone(),
            effort: spec.effort.clone(),
        })
        .await;
        if outcome.resume_rejected && !parts.killed.load(Ordering::SeqCst) {
            tracing::warn!(
                task_id = %spec.task_id,
                session_id = native.as_deref().unwrap_or(""),
                "task.resume.rejected"
            );
            let refused = native.as_deref().unwrap_or("");
            parts.events.push(crate::model::log_event(
                "warn",
                format!("{harness} refused to resume {refused} — starting a fresh session"),
            ));
            native = None;
            transcript = load_transcript(&spec, history.as_deref()).await;
            let prompt = build_turn_prompt(inline, &transcript, &current);
            let append = match mode {
                ScaffoldMode::Inline => String::new(),
                ScaffoldMode::Append | ScaffoldMode::AppendWithCwd => scaffold.clone(),
            };
            outcome = spawn(TurnCall {
                task_id: spec.task_id.clone(),
                prompt,
                append_system_prompt: append,
                resume_native: None,
                message: current,
                model: spec.model.clone(),
                effort: spec.effort.clone(),
            })
            .await;
        }
        if outcome.native_id.is_some() {
            native = outcome.native_id.clone();
        }
        usage.input_tokens += outcome.input_tokens;
        usage.output_tokens += outcome.output_tokens;
        if let Some(cost) = outcome.cost_usd {
            usage.cost_usd = Some(usage.cost_usd.unwrap_or(0.0) + cost);
        }
        usage.wall_clock_ms = now_ms().saturating_sub(started);
        parts.events.push(TaskEvent::TurnEnd {
            ts: now_ms(),
            turn: usage.turns,
            usage: usage.to_usage(),
            harness_session_id: crate::prompt::canonical_session_id(&prefix, native.as_deref()),
        });
        if !outcome.text.is_empty() {
            last_text = outcome.text;
        }
        if let Some(error) = outcome.error {
            last_error = Some(error);
            break;
        }
        transcript.clear();
        message = next_steer(&parts.steer_q);
    }
    usage.wall_clock_ms = now_ms().saturating_sub(started);
    if parts.killed.load(Ordering::SeqCst) {
        return killed_result(parts.kill_reason.lock().as_deref(), &last_text, &usage);
    }
    if let Some(error) = last_error {
        return failed_text(&error, &last_text, &usage);
    }
    finish_from_text(&last_text, &usage)
}

async fn load_transcript(spec: &TaskSpec, history: Option<&HistorySource>) -> String {
    let Some(history) = history else {
        return String::new();
    };
    let task_id = spec.task_id.clone();
    let task_cb = history.get_task_history.clone();
    let session_cb = history.get_session_history.clone();
    let loaded =
        tokio::task::spawn_blocking(move || fetch_history(&task_id, task_cb, session_cb)).await;
    match loaded {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "task.resume.rehydration.failed");
            String::new()
        }
        Err(_) => String::new(),
    }
}

fn fetch_history(
    task_id: &str,
    task_cb: Option<HistoryLoader>,
    session_cb: Option<HistoryLoader>,
) -> Result<String, String> {
    let limit = crate::prompt::RESUME_HISTORY_LIMIT;
    let rows = if let Some(task_cb) = task_cb {
        task_cb(task_id, limit)?
    } else if let Some(session_cb) = session_cb {
        session_cb(&format!("task:{task_id}"), limit)?
    } else {
        return Ok(String::new());
    };
    Ok(render_resume_transcript(&rows))
}
