use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;
use transcripts::fsutil::{is_dir, is_file, node_resolve, read_dir_names, read_lossy};

use crate::drive::{DrivePlan, HistorySource, ScaffoldMode, SpawnOutcome, TurnCall, drive};
use crate::model::{
    AbortFlag, Capabilities, KillSlot, TaskSpec, den_message, den_tool_end, den_tool_start,
    log_event, open_handle, publish,
};
use crate::prompt::{canonical_session_id, clamp_prompt};
use crate::registry::HarnessExecutor;
use crate::spawn::{
    KILL_GRACE_MS, SpawnRequest, StdinMode, child_env, exit_label, spawn_child, stderr_tail,
};
use crate::standard_helpers::{Env, ProcessEnv, home_dir, num_value, sha256_hex};

pub const KIMI_HARNESS_ID: &str = "kimi-code";

pub struct KimiFlags {
    pub model_id: Option<String>,
    pub resume_session_id: Option<String>,
}

pub fn build_kimi_args(flags: &KimiFlags, prompt: &str) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(id) = flags
        .resume_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        args.push("-S".to_string());
        args.push(id.to_string());
    }
    if let Some(model) = flags.model_id.as_deref().filter(|model| !model.is_empty()) {
        args.push("-m".to_string());
        args.push(model.to_string());
    }
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());
    args.push("-p".to_string());
    args.push(clamp_prompt(prompt));
    args
}

pub fn build_kimi_child_env(
    base: &dyn Env,
    overrides: &[(String, Option<String>)],
) -> std::collections::BTreeMap<String, String> {
    child_env(
        base,
        overrides,
        &["KIMI_MODEL_OUTPUT_FORMAT", "KIMI_CODE_LEGACY_FLAG"],
        &[],
    )
}

pub fn kimi_resume_rejected(text: &str) -> bool {
    kimi_re().is_some_and(|regex| regex.find(text).is_some())
}

fn kimi_re() -> Option<&'static regress::Regex> {
    static RE: OnceLock<Option<regress::Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        regress::Regex::with_flags(
            r#"Session "[^"]*" (?:not found|was created under a different directory)"#,
            "i",
        )
        .ok()
    })
    .as_ref()
}

pub fn kimi_home(env: &dyn Env) -> PathBuf {
    if let Some(explicit) = env.get("KIMI_CODE_HOME") {
        let trimmed = protocol::js::js_trim(&explicit);
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home_dir().join(".kimi-code")
}

pub fn work_dir_hash(cwd: &str) -> String {
    let hex = sha256_hex(cwd.as_bytes());
    hex.get(..12).unwrap_or(&hex).to_string()
}

pub fn find_bucket_dir(root: &Path, cwd: &str) -> Option<PathBuf> {
    let suffix = format!("_{}", work_dir_hash(cwd));
    let names = read_dir_names(root)?;
    names.into_iter().find_map(|name| {
        if name.starts_with("wd_") && name.ends_with(&suffix) {
            Some(root.join(name))
        } else {
            None
        }
    })
}

#[derive(Clone, Debug)]
pub struct SessionIndexEntry {
    pub session_id: String,
    pub session_dir: String,
    pub work_dir: Option<String>,
}

pub fn read_session_index(home: &Path) -> Vec<SessionIndexEntry> {
    let Some(text) = read_lossy(&home.join("session_index.jsonl")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(row) = value.as_object() else {
            continue;
        };
        let Some(session_id) = row.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let Some(session_dir) = row.get("sessionDir").and_then(Value::as_str) else {
            continue;
        };
        let work_dir = row
            .get("workDir")
            .and_then(Value::as_str)
            .map(str::to_string);
        out.push(SessionIndexEntry {
            session_id: session_id.to_string(),
            session_dir: session_dir.to_string(),
            work_dir,
        });
    }
    out
}

pub fn resolve_session_dir(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    if let Some(indexed) = read_session_index(home)
        .into_iter()
        .find(|entry| entry.session_id == session_id)
    {
        let path = PathBuf::from(&indexed.session_dir);
        if is_dir(&path) {
            return Some(path);
        }
    }
    let bucket = find_bucket_dir(&home.join("sessions"), cwd)?;
    let guess = bucket.join(session_id);
    if is_dir(&guess) { Some(guess) } else { None }
}

pub fn list_session_ids(home: &Path, cwd: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for entry in read_session_index(home) {
        if let Some(work_dir) = &entry.work_dir
            && !paths_equal(work_dir, cwd)
        {
            continue;
        }
        if !ids.iter().any(|id| id == &entry.session_id) {
            ids.push(entry.session_id);
        }
    }
    if let Some(bucket) = find_bucket_dir(&home.join("sessions"), cwd)
        && let Some(names) = read_dir_names(&bucket)
    {
        for name in names {
            if name.starts_with("session_") && !ids.iter().any(|id| id == &name) {
                ids.push(name);
            }
        }
    }
    ids
}

fn paths_equal(left: &str, right: &str) -> bool {
    node_resolve(Path::new("/"), left) == node_resolve(Path::new("/"), right)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WireTurnEnd {
    pub reason: String,
    pub turn_id: Option<f64>,
    pub duration_ms: Option<f64>,
    pub time_ms: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WireTurnFacts {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: f64,
    pub usage_records: u32,
    pub turn_ended: Option<WireTurnEnd>,
    pub files: u32,
    pub malformed: u32,
}

pub fn wire_files_for(session_dir: &Path) -> Vec<PathBuf> {
    let Some(slots) = read_dir_names(&session_dir.join("agents")) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = slots
        .into_iter()
        .map(|slot| session_dir.join("agents").join(slot).join("wire.jsonl"))
        .filter(|path| is_file(path))
        .collect();
    files.sort_by(|left, right| {
        let left_main = path_has_main(left);
        let right_main = path_has_main(right);
        right_main.cmp(&left_main)
    });
    files
}

fn path_has_main(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == "main")
}

pub fn reconcile_turn(session_dir: &Path, since_ms: i64) -> WireTurnFacts {
    let mut facts = WireTurnFacts::default();
    let floor = since_ms as f64;
    for file in wire_files_for(session_dir) {
        let Some(text) = read_lossy(&file) else {
            continue;
        };
        facts.files += 1;
        let is_main = path_has_main(&file);
        for raw in text.split('\n') {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(_) => {
                    facts.malformed += 1;
                    continue;
                }
            };
            let Some(record) = value.as_object() else {
                facts.malformed += 1;
                continue;
            };
            let Some(time_ms) = record.get("time").and_then(Value::as_f64) else {
                continue;
            };
            if time_ms < floor {
                continue;
            }
            if record.get("type").and_then(Value::as_str) == Some("usage.record")
                && record.get("usageScope").and_then(Value::as_str) == Some("turn")
            {
                if let Some(usage) = record.get("usage").and_then(Value::as_object) {
                    facts.input_tokens += num_value(usage.get("inputOther"))
                        + num_value(usage.get("inputCacheRead"))
                        + num_value(usage.get("inputCacheCreation"));
                    facts.output_tokens += num_value(usage.get("output"));
                    facts.usage_records += 1;
                }
                continue;
            }
            if is_main
                && record.get("type").and_then(Value::as_str) == Some("turn.ended")
                && let Some(reason) = record.get("reason").and_then(Value::as_str)
            {
                let ended = WireTurnEnd {
                    reason: reason.to_string(),
                    turn_id: record.get("turnId").and_then(Value::as_f64),
                    duration_ms: record.get("durationMs").and_then(Value::as_f64),
                    time_ms,
                };
                let replace = facts
                    .turn_ended
                    .as_ref()
                    .is_none_or(|current| ended.time_ms >= current.time_ms);
                if replace {
                    facts.turn_ended = Some(ended);
                }
            }
        }
    }
    facts.total_tokens = facts.input_tokens + facts.output_tokens;
    facts
}

#[derive(Clone)]
pub struct KimiCodeExecutor {
    pub binary: String,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
    pub kimi_home: Option<String>,
    pub kill_grace: Duration,
    pub env: Arc<dyn Env>,
    pub history: Option<Arc<HistorySource>>,
}

impl KimiCodeExecutor {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            model_id: None,
            effort: None,
            cwd: None,
            kimi_home: None,
            kill_grace: Duration::from_millis(KILL_GRACE_MS),
            env: Arc::new(ProcessEnv),
            history: None,
        }
    }
}

impl HarnessExecutor for KimiCodeExecutor {
    fn name(&self) -> &str {
        KIMI_HARNESS_ID
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::argv(true)
    }

    fn start(&self, spec: TaskSpec, abort: AbortFlag) -> crate::model::TaskHandle {
        let cfg = self.clone();
        let (handle, parts) = open_handle(None);
        let kill_now = handle.kill_hook();
        if let Some(reason) = abort.arm({
            let kill_now = Arc::clone(&kill_now);
            Arc::new(move |reason: String| kill_now(&reason))
        }) {
            kill_now(&reason);
        }
        let events = parts.events.clone();
        let active = Arc::clone(&parts.active);
        let killed = Arc::clone(&parts.killed);
        let parts_for_task = parts.clone();
        tokio::spawn(async move {
            let cwd = spec
                .working_dir
                .clone()
                .or_else(|| cfg.cwd.clone())
                .unwrap_or_else(current_dir);
            let home = cfg
                .kimi_home
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| kimi_home(cfg.env.as_ref()));
            let result = drive(
                spec,
                parts_for_task,
                DrivePlan {
                    harness: "kimi".to_string(),
                    prefix: KIMI_HARNESS_ID.to_string(),
                    mode: ScaffoldMode::Inline,
                    cwd: cwd.clone(),
                    history: cfg.history.clone(),
                },
                |call| {
                    let cfg = cfg.clone();
                    let cwd = cwd.clone();
                    let home = home.clone();
                    let active = Arc::clone(&active);
                    let killed = Arc::clone(&killed);
                    let events = events.clone();
                    async move { run_kimi_spawn(cfg, call, cwd, home, active, killed, events).await }
                },
            )
            .await;
            publish(&parts, result);
        });
        handle
    }
}

async fn run_kimi_spawn(
    cfg: KimiCodeExecutor,
    call: TurnCall,
    cwd: String,
    home: PathBuf,
    active: KillSlot,
    killed: Arc<std::sync::atomic::AtomicBool>,
    events: crate::model::EventQueue,
) -> SpawnOutcome {
    let ids_before = if call.resume_native.is_none() {
        let home = home.clone();
        let cwd = cwd.clone();
        Some(
            tokio::task::spawn_blocking(move || list_session_ids(&home, &cwd))
                .await
                .unwrap_or_default(),
        )
    } else {
        None
    };
    let model = call.model.clone().or_else(|| cfg.model_id.clone());
    let effort = call.effort.clone().or_else(|| cfg.effort.clone());
    let mut spawned = match spawn_kimi(&cfg, &call, &cwd, model, effort).await {
        Ok(spawned) => spawned,
        Err(error) => return SpawnOutcome::failure(error),
    };
    *active.lock() = Some(spawned.share_kill());
    if killed.load(Ordering::SeqCst) {
        spawned.kill();
    }
    let mut text = String::new();
    let mut session_id: Option<String> = None;
    let mut saw_resume_hint = false;
    let mut tool_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    while let Some(line) = spawned.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(row) = value.as_object() else {
            continue;
        };
        let role = row.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "assistant" {
            if let Some(content) = row.get("content").and_then(Value::as_str)
                && !content.is_empty()
            {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(content);
                events.push(den_message(content));
            }
            if let Some(calls) = row.get("tool_calls").and_then(Value::as_array) {
                for call_value in calls {
                    let Some(call_row) = call_value.as_object() else {
                        continue;
                    };
                    let name = call_row
                        .get("function")
                        .and_then(Value::as_object)
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str);
                    let Some(name) = name else {
                        continue;
                    };
                    if let Some(id) = call_row.get("id").and_then(Value::as_str) {
                        tool_names.insert(id.to_string(), name.to_string());
                    }
                    events.push(den_tool_start(name));
                }
            }
            continue;
        }
        if role == "tool" {
            let id = row.get("tool_call_id").and_then(Value::as_str);
            let tool = id.and_then(|id| tool_names.get(id).cloned());
            events.push(den_tool_end(tool));
            continue;
        }
        if role == "meta" {
            let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "session.resume_hint" {
                if let Some(id) = row.get("session_id").and_then(Value::as_str)
                    && !id.is_empty()
                {
                    session_id = Some(id.to_string());
                }
                saw_resume_hint = true;
            } else if kind == "turn.step.retrying" {
                let detail = row
                    .get("error_message")
                    .and_then(Value::as_str)
                    .unwrap_or("provider error");
                events.push(log_event("warn", format!("kimi retrying a step: {detail}")));
            }
        }
    }
    let code = spawned.wait_exit().await;
    let stderr = spawned.stderr_text();
    *active.lock() = None;
    spawned.kill();
    let mut error = None;
    if code != Some(0) && !killed.load(Ordering::SeqCst) {
        error = Some(format!(
            "kimi CLI exited {}: {}",
            exit_label(code),
            stderr_tail(&stderr)
        ));
    }
    if !saw_resume_hint && error.is_none() && !killed.load(Ordering::SeqCst) {
        error = Some("kimi CLI stream ended without a session resume_hint".to_string());
    }
    if error.is_some() && kimi_resume_rejected(&stderr) && call.resume_native.is_some() {
        return SpawnOutcome {
            text,
            native_id: session_id,
            error,
            resume_rejected: true,
            input_tokens: 0.0,
            output_tokens: 0.0,
            cost_usd: None,
        };
    }
    if session_id.is_none() {
        session_id = call.resume_native.clone();
        if session_id.is_none()
            && let Some(before) = ids_before.as_ref()
        {
            let home = home.clone();
            let cwd = cwd.clone();
            let before = before.clone();
            session_id = tokio::task::spawn_blocking(move || recover_one(&home, &cwd, &before))
                .await
                .unwrap_or(None);
        }
    }
    let since = spawned.started_at_ms;
    let home_for_disk = home.clone();
    let session_for_disk = session_id.clone();
    let cwd_for_disk = cwd.clone();
    let facts = tokio::task::spawn_blocking(move || {
        let Some(session_id) = session_for_disk else {
            return WireTurnFacts::default();
        };
        let Some(dir) = resolve_session_dir(&home_for_disk, &cwd_for_disk, &session_id) else {
            return WireTurnFacts::default();
        };
        reconcile_turn(&dir, since)
    })
    .await
    .unwrap_or_default();
    if facts.usage_records == 0 {
        tracing::warn!("task.usage.unreconciled");
    }
    SpawnOutcome {
        text,
        native_id: session_id,
        error,
        resume_rejected: false,
        input_tokens: facts.input_tokens,
        output_tokens: facts.output_tokens,
        cost_usd: None,
    }
}

fn recover_one(home: &Path, cwd: &str, ids_before: &[String]) -> Option<String> {
    let fresh: Vec<String> = list_session_ids(home, cwd)
        .into_iter()
        .filter(|id| !ids_before.contains(id))
        .collect();
    (fresh.len() == 1).then(|| fresh[0].clone())
}

async fn spawn_kimi(
    cfg: &KimiCodeExecutor,
    call: &TurnCall,
    cwd: &str,
    model: Option<String>,
    effort: Option<String>,
) -> Result<crate::spawn::Spawned, String> {
    let args = build_kimi_args(
        &KimiFlags {
            model_id: model,
            resume_session_id: call.resume_native.clone(),
        },
        &call.prompt,
    );
    let mut overrides = vec![
        ("RIVETOS_TASK_ID".to_string(), Some(call.task_id.clone())),
        ("RIVETOS_SESSION_KEY".to_string(), None),
        (
            "RIVETOS_DEN_HOOK_DISABLED".to_string(),
            Some("1".to_string()),
        ),
    ];
    if let Some(home) = &cfg.kimi_home {
        overrides.push(("KIMI_CODE_HOME".to_string(), Some(home.clone())));
    }
    if let Some(effort) = effort {
        overrides.push(("KIMI_MODEL_THINKING_EFFORT".to_string(), Some(effort)));
    }
    let env = build_kimi_child_env(cfg.env.as_ref(), &overrides);
    tracing::info!(task_id = %call.task_id, "task.spawn");
    spawn_child(SpawnRequest {
        binary: &cfg.binary,
        args: &args,
        cwd: Some(cwd),
        env: &env,
        stdin: StdinMode::PipeEof,
        kill_grace: cfg.kill_grace,
        capture_stdout: false,
    })
    .await
    .map_err(|error| format!("Failed to spawn {}: {error}", cfg.binary))
}

fn current_dir() -> String {
    std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

pub fn canonical_kimi_session_id(native: Option<&str>) -> Option<String> {
    canonical_session_id(KIMI_HARNESS_ID, native)
}
