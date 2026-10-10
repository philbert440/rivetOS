use std::sync::Arc;

use protocol::HookEventName;
use serde_json::{Map, Number, Value};

use crate::context::HookContext;
use crate::files::FileWriter;
use crate::handler::{BoxFuture, HookErrorMode, HookFailure, HookHandler, HookSignal};
use crate::js_text::js_slice;
use crate::pipeline::HookRegistration;
use crate::shell::{ShellError, ShellExecutor};
use crate::time_format::{fixed_1, group_en_us, utc_date};

const DAILY_NOTE_CAP: i64 = 2000;

#[derive(Clone, Default)]
pub struct SessionHooksContext {
    pub shell: Option<Arc<dyn ShellExecutor>>,
    pub file_writer: Option<Arc<dyn FileWriter>>,
    pub workspace_dir: Option<String>,
}

pub struct SessionHooksConfig {
    pub context: SessionHooksContext,
    pub session_start: Option<bool>,
    pub session_summary: Option<bool>,
    pub auto_commit: bool,
    pub pre_compact: Option<bool>,
    pub post_compact: Option<bool>,
}

pub fn create_session_start_hook(ctx: SessionHooksContext) -> HookRegistration {
    session_registration(
        "session:start-context",
        HookEventName::SessionStart,
        30,
        "Loads session context on start",
        move |hook_ctx| {
            let ctx = ctx.clone();
            Box::pin(async move { session_start(hook_ctx, &ctx).await })
        },
    )
}

pub fn create_session_summary_hook(ctx: SessionHooksContext) -> HookRegistration {
    session_registration(
        "session:end-summary",
        HookEventName::SessionEnd,
        50,
        "Writes session summary to daily notes",
        move |hook_ctx| {
            let ctx = ctx.clone();
            Box::pin(async move { session_summary(hook_ctx, &ctx).await })
        },
    )
}

pub fn create_auto_commit_hook(ctx: SessionHooksContext) -> HookRegistration {
    session_registration(
        "session:end-autocommit",
        HookEventName::SessionEnd,
        40,
        "Auto-commits pending workspace changes on session end",
        move |hook_ctx| {
            let ctx = ctx.clone();
            Box::pin(async move { auto_commit(hook_ctx, &ctx).await })
        },
    )
}

pub fn create_pre_compact_hook() -> HookRegistration {
    HookRegistration {
        id: "compact:preserve-context".to_string(),
        event: HookEventName::CompactBefore,
        handler: HookHandler::from_sync(pre_compact),
        priority: 30,
        on_error: HookErrorMode::Continue,
        agent_filter: None,
        tool_filter: None,
        description: Some(
            "Captures pre-compaction state for post-compaction verification".to_string(),
        ),
        enabled: true,
    }
}

pub fn create_post_compact_hook(ctx: SessionHooksContext) -> HookRegistration {
    session_registration(
        "compact:verify-context",
        HookEventName::CompactAfter,
        50,
        "Verifies context survived compaction and logs results",
        move |hook_ctx| {
            let ctx = ctx.clone();
            Box::pin(async move { post_compact(hook_ctx, &ctx).await })
        },
    )
}

pub fn create_session_hooks(config: SessionHooksConfig) -> Vec<HookRegistration> {
    let mut hooks = Vec::new();
    if config.session_start != Some(false) {
        hooks.push(create_session_start_hook(config.context.clone()));
    }
    if config.session_summary != Some(false) {
        hooks.push(create_session_summary_hook(config.context.clone()));
    }
    if config.auto_commit {
        hooks.push(create_auto_commit_hook(config.context.clone()));
    }
    if config.pre_compact != Some(false) {
        hooks.push(create_pre_compact_hook());
    }
    if config.post_compact != Some(false) {
        hooks.push(create_post_compact_hook(config.context));
    }
    hooks
}

fn session_registration<F>(
    id: &str,
    event: HookEventName,
    priority: i64,
    description: &str,
    function: F,
) -> HookRegistration
where
    F: for<'a> Fn(&'a mut HookContext) -> BoxFuture<'a, Result<HookSignal, HookFailure>>
        + Send
        + Sync
        + 'static,
{
    HookRegistration {
        id: id.to_string(),
        event,
        handler: HookHandler::from_future(function),
        priority,
        on_error: HookErrorMode::Continue,
        agent_filter: None,
        tool_filter: None,
        description: Some(description.to_string()),
        enabled: true,
    }
}

async fn session_start(
    hook_ctx: &mut HookContext,
    ctx: &SessionHooksContext,
) -> Result<HookSignal, HookFailure> {
    hook_ctx.metadata.insert(
        "sessionStartTime".to_string(),
        Value::Number(Number::from(hook_ctx.timestamp)),
    );
    if let Some(platform) = hook_ctx.platform.clone() {
        hook_ctx
            .metadata
            .insert("platform".to_string(), Value::String(platform));
    }
    if let Some(user_id) = hook_ctx.user_id.clone() {
        hook_ctx
            .metadata
            .insert("userId".to_string(), Value::String(user_id));
    }
    if let (Some(writer), Some(workspace)) = (ctx.file_writer.clone(), ctx.workspace_dir.clone()) {
        let path = daily_note_path(&workspace);
        if let Ok(Some(note)) = writer.read(&path).await {
            if !note.is_empty() {
                hook_ctx.metadata.insert(
                    "dailyContext".to_string(),
                    Value::String(js_slice(&note, 0, Some(DAILY_NOTE_CAP))),
                );
            }
        }
    }
    Ok(HookSignal::Continue)
}

async fn session_summary(
    hook_ctx: &mut HookContext,
    ctx: &SessionHooksContext,
) -> Result<HookSignal, HookFailure> {
    let (Some(writer), Some(workspace)) = (ctx.file_writer.clone(), ctx.workspace_dir.clone())
    else {
        return Ok(HookSignal::Continue);
    };
    let now = clock_hhmm().await;
    let mut lines = vec![
        String::new(),
        format!("## Session ended {now}"),
        format!("- Agent: {}", hook_ctx.agent_id.as_deref().unwrap_or("unknown")),
    ];
    if let Some(turns) = hook_ctx.turn_count.filter(|value| *value != 0) {
        lines.push(format!("- Turns: {turns}"));
    }
    if let Some(totals) = hook_ctx.total_tokens.clone() {
        let total = i128::from(totals.prompt) + i128::from(totals.completion);
        lines.push(format!(
            "- Tokens: {} ({} in / {} out)",
            group_i128(total),
            group_en_us(totals.prompt),
            group_en_us(totals.completion)
        ));
    }
    lines.push(String::new());
    let body = lines.join("\n");
    let path = daily_note_path(&workspace);
    let written = writer.append(&path, &body).await.is_ok();
    hook_ctx
        .metadata
        .insert("summaryWritten".to_string(), Value::Bool(written));
    Ok(HookSignal::Continue)
}

async fn auto_commit(
    hook_ctx: &mut HookContext,
    ctx: &SessionHooksContext,
) -> Result<HookSignal, HookFailure> {
    let (Some(shell), Some(workspace)) = (ctx.shell.clone(), ctx.workspace_dir.clone()) else {
        return Ok(HookSignal::Continue);
    };
    match commit_workspace(hook_ctx, shell.as_ref(), &workspace).await {
        Ok(value) => {
            hook_ctx.metadata.insert("autoCommit".to_string(), value);
        }
        Err(err) => {
            hook_ctx.metadata.insert(
                "autoCommit".to_string(),
                serde_json::json!({
                    "status": "error",
                    "message": err.message,
                }),
            );
        }
    }
    Ok(HookSignal::Continue)
}

async fn commit_workspace(
    hook_ctx: &HookContext,
    shell: &dyn ShellExecutor,
    workspace: &str,
) -> Result<Value, ShellError> {
    let status = shell
        .exec("git status --porcelain", Some(workspace))
        .await?;
    if protocol::js::js_trim(&status.stdout).is_empty() {
        return Ok(serde_json::json!({
            "status": "clean",
            "message": "No uncommitted changes",
        }));
    }
    shell.exec("git add -A", Some(workspace)).await?;
    let agent = hook_ctx.agent_id.as_deref().unwrap_or("unknown");
    let turns = hook_ctx.turn_count.unwrap_or(0);
    let command = format!("git commit -m \"auto: session end ({agent}, {turns} turns)\"");
    let commit = shell.exec(&command, Some(workspace)).await?;
    let status_text = if commit.exit_code == 0 {
        "committed"
    } else {
        "failed"
    };
    Ok(serde_json::json!({
        "status": status_text,
        "output": js_slice(&commit.stdout, 0, Some(200)),
    }))
}

fn pre_compact(ctx: &mut HookContext) -> Result<HookSignal, HookFailure> {
    let mut snapshot = Map::new();
    match ctx.message_count {
        Some(count) => {
            snapshot.insert("messageCount".to_string(), Value::Number(Number::from(count)));
        }
        None => {
            snapshot.insert("messageCount".to_string(), Value::Null);
        }
    }
    snapshot.insert(
        "timestamp".to_string(),
        Value::Number(Number::from(ctx.timestamp)),
    );
    ctx.metadata
        .insert("preCompactSnapshot".to_string(), Value::Object(snapshot));
    Ok(HookSignal::Continue)
}

async fn post_compact(
    hook_ctx: &mut HookContext,
    ctx: &SessionHooksContext,
) -> Result<HookSignal, HookFailure> {
    let count = snapshot_message_count(&hook_ctx.metadata);
    let original = match count {
        Some(value) => Value::Number(Number::from(value)),
        None => Value::String("unknown".to_string()),
    };
    let ratio = match count {
        Some(value) if value != 0 => match hook_ctx.remaining_messages {
            Some(left) => format!(
                "{}%",
                fixed_1((1.0 - (left as f64) / (value as f64)) * 100.0)
            ),
            None => "NaN%".to_string(),
        },
        _ => "unknown".to_string(),
    };
    let mut result = Map::new();
    result.insert("originalMessages".to_string(), original);
    if let Some(remaining) = hook_ctx.remaining_messages {
        result.insert(
            "remainingMessages".to_string(),
            Value::Number(Number::from(remaining)),
        );
    }
    result.insert(
        "summaryGenerated".to_string(),
        Value::Bool(hook_ctx.summary.as_ref().is_some_and(|text| !text.is_empty())),
    );
    result.insert("compressionRatio".to_string(), Value::String(ratio));
    hook_ctx
        .metadata
        .insert("compactionResult".to_string(), Value::Object(result));
    if let (Some(writer), Some(workspace)) = (ctx.file_writer.clone(), ctx.workspace_dir.clone()) {
        let now = clock_hhmm().await;
        let count_text = match count {
            Some(value) => value.to_string(),
            None => "?".to_string(),
        };
        let remaining_text = match hook_ctx.remaining_messages {
            Some(value) => value.to_string(),
            None => "undefined".to_string(),
        };
        let summary = if hook_ctx.summary.as_ref().is_some_and(|text| !text.is_empty()) {
            "yes"
        } else {
            "no"
        };
        let entry = format!(
            "\n### Compaction {now}\n- Messages: {count_text} → {remaining_text}\n- Summary: {summary}\n"
        );
        let path = daily_note_path(&workspace);
        let _ = writer.append(&path, &entry).await;
    }
    Ok(HookSignal::Continue)
}

fn snapshot_message_count(metadata: &Map<String, Value>) -> Option<i64> {
    metadata
        .get("preCompactSnapshot")
        .and_then(Value::as_object)
        .and_then(|snapshot| snapshot.get("messageCount"))
        .and_then(Value::as_i64)
}

fn daily_note_path(workspace: &str) -> String {
    format!("{workspace}/memory/{}.md", utc_date())
}

async fn clock_hhmm() -> String {
    match tokio::task::spawn_blocking(crate::time_format::local_hhmm).await {
        Ok(text) => text,
        Err(_) => chrono::Utc::now().format("%H:%M").to_string(),
    }
}

fn group_i128(value: i128) -> String {
    let negative = value < 0;
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (index, ch) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let mut text: String = grouped.chars().rev().collect();
    if negative {
        text.insert(0, '-');
    }
    text
}
