use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{Map, Value};
use transcripts::fsutil::{is_file, read_dir_names, read_lossy};
use transcripts::qwen_turns_from_lines;
use transcripts::timeutil::parse_date_ms;
use transcripts::turn::Role;
use uuid::Uuid;

use crate::drive::{DrivePlan, HistorySource, ScaffoldMode, SpawnOutcome, TurnCall, drive};
use crate::model::{
    AbortFlag, Capabilities, KillSlot, TaskSpec, den_message, den_thinking, den_tool_end,
    den_tool_start, open_handle, publish,
};
use crate::prompt::canonical_session_id;
use crate::registry::HarnessExecutor;
use crate::spawn::{
    KILL_GRACE_MS, SpawnRequest, StdinMode, child_env, exit_label, spawn_child, stderr_tail,
};
use crate::standard_helpers::{Env, ProcessEnv, home_dir, num_value, object_str};

pub const QWEN_CODE_HARNESS_ID: &str = "qwen-code";

pub struct QwenFlags {
    pub model_id: Option<String>,
    pub resume_session_id: Option<String>,
    pub pin_session_id: Option<String>,
    pub append_system_prompt: Option<String>,
    pub max_session_turns: Option<u32>,
}

pub fn build_qwen_args(flags: &QwenFlags, prompt: &str) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        crate::prompt::clamp_prompt(prompt),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--approval-mode".to_string(),
        "yolo".to_string(),
    ];
    if let Some(id) = flags.pin_session_id.as_deref().filter(|id| !id.is_empty()) {
        args.push("--session-id".to_string());
        args.push(id.to_string());
    } else if let Some(id) = flags
        .resume_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        args.push("--resume".to_string());
        args.push(id.to_string());
    }
    if let Some(model) = flags.model_id.as_deref().filter(|model| !model.is_empty()) {
        args.push("-m".to_string());
        args.push(model.to_string());
    }
    if let Some(prompt) = flags
        .append_system_prompt
        .as_deref()
        .filter(|prompt| !prompt.is_empty())
    {
        args.push("--append-system-prompt".to_string());
        args.push(prompt.to_string());
    }
    if let Some(turns) = flags.max_session_turns {
        args.push("--max-session-turns".to_string());
        args.push(turns.to_string());
    }
    args
}

pub fn build_qwen_child_env(
    base: &dyn Env,
    overrides: &[(String, Option<String>)],
) -> std::collections::BTreeMap<String, String> {
    child_env(
        base,
        overrides,
        &[],
        &[(
            "QWEN_CODE_SUPPRESS_YOLO_WARNING".to_string(),
            "1".to_string(),
        )],
    )
}

pub fn qwen_resume_rejected(text: &str) -> bool {
    qwen_re().is_some_and(|regex| regex.find(text).is_some())
}

fn qwen_re() -> Option<&'static regress::Regex> {
    static RE: OnceLock<Option<regress::Regex>> = OnceLock::new();
    RE.get_or_init(|| regress::Regex::new(r"No saved session found with ID").ok())
        .as_ref()
}

pub fn qwen_home() -> PathBuf {
    home_dir().join(".qwen")
}

pub fn default_workspace_dir() -> PathBuf {
    home_dir().join(".rivetos").join("workspace")
}

pub fn encode_qwen_bucket(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    let base = if trimmed.is_empty() { "/" } else { trimmed };
    base.replace('/', "-")
}

pub fn is_qwen_native_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8, 4, 4, 4, 12];
    let mut index = 0;
    for (group, length) in groups.into_iter().enumerate() {
        if group > 0 {
            if bytes.get(index) != Some(&b'-') {
                return false;
            }
            index += 1;
        }
        for _ in 0..length {
            let Some(byte) = bytes.get(index) else {
                return false;
            };
            if !byte.is_ascii_hexdigit() {
                return false;
            }
            index += 1;
        }
    }
    true
}

fn native_from_qwen_filename(name: &str) -> Option<String> {
    if name.ends_with(".runtime.json") {
        return None;
    }
    let stem = name.strip_suffix(".jsonl")?;
    is_qwen_native_id(stem).then(|| stem.to_string())
}

pub fn find_qwen_session_file(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    if !is_qwen_native_id(session_id) {
        return None;
    }
    let root = home.join("projects");
    if !cwd.is_empty() {
        let file = root
            .join(encode_qwen_bucket(cwd))
            .join("chats")
            .join(format!("{session_id}.jsonl"));
        if is_file(&file) {
            return Some(file);
        }
    }
    for (id, path) in walk_qwen_sessions(home) {
        if id == session_id {
            return Some(path);
        }
    }
    None
}

pub fn list_qwen_session_ids(home: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    for (id, _) in walk_qwen_sessions(home) {
        if !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    ids
}

fn walk_qwen_sessions(home: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let root = home.join("projects");
    let Some(projects) = read_dir_names(&root) else {
        return out;
    };
    for project in projects {
        if project.starts_with('.') {
            continue;
        }
        let chats = root.join(&project).join("chats");
        let Some(names) = read_dir_names(&chats) else {
            continue;
        };
        for name in names {
            let path = chats.join(&name);
            if is_file(&path)
                && let Some(id) = native_from_qwen_filename(&name)
            {
                out.push((id, path));
            }
        }
    }
    out
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QwenTurnFacts {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: f64,
    pub cache_read: f64,
    pub usage_records: u32,
    pub files: u32,
    pub malformed: u32,
}

pub fn qwen_transcript_files(session_file: &Path) -> Vec<PathBuf> {
    if is_file(session_file) {
        vec![session_file.to_path_buf()]
    } else {
        Vec::new()
    }
}

pub fn reconcile_qwen_turn(session_file: &Path, since_ms: i64) -> QwenTurnFacts {
    let mut facts = QwenTurnFacts::default();
    let mut kept = Vec::new();
    let mut telemetry: Vec<(f64, f64, f64)> = Vec::new();
    for file in qwen_transcript_files(session_file) {
        let Some(text) = read_lossy(&file) else {
            continue;
        };
        facts.files += 1;
        for raw in text.split('\n') {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            let Some(object) = transcripts::objects_from_text(line).into_iter().next() else {
                facts.malformed += 1;
                continue;
            };
            let time_ms = qwen_event_time_ms(&object);
            if time_ms.is_some_and(|time| time < since_ms) {
                continue;
            }
            if object.get("type").and_then(Value::as_str) == Some("assistant")
                && let Some(tokens) = usage_from_qwen_object(&object)
            {
                facts.input_tokens += tokens.0;
                facts.output_tokens += tokens.1;
                facts.cache_read += tokens.2;
                facts.usage_records += 1;
            } else if object.get("type").and_then(Value::as_str) == Some("system")
                && let Some(tokens) = usage_from_qwen_object(&object)
            {
                telemetry.push(tokens);
            }
            kept.push(object);
        }
    }
    let turns = qwen_turns_from_lines(&kept);
    let reader_records = turns
        .iter()
        .filter(|turn| turn.role == Role::Assistant && turn.usage.is_some())
        .count() as u32;
    if reader_records > 0 && reader_records == facts.usage_records {
        facts.input_tokens = 0.0;
        facts.output_tokens = 0.0;
        facts.cache_read = 0.0;
        facts.usage_records = 0;
        for turn in &turns {
            if turn.role != Role::Assistant {
                continue;
            }
            let Some(usage) = &turn.usage else {
                continue;
            };
            facts.input_tokens += usage.prompt_tokens as f64;
            facts.output_tokens += usage.completion_tokens as f64;
            facts.cache_read += usage.cached_tokens as f64;
            facts.usage_records += 1;
        }
    }
    if facts.usage_records == 0 {
        for (input, output, cache) in telemetry {
            facts.input_tokens += input;
            facts.output_tokens += output;
            facts.cache_read += cache;
            facts.usage_records += 1;
        }
    }
    facts.total_tokens = facts.input_tokens + facts.output_tokens;
    facts
}

fn qwen_event_time_ms(object: &Map<String, Value>) -> Option<i64> {
    if let Some(number) = object.get("timestamp").and_then(Value::as_i64) {
        return Some(number);
    }
    if let Some(number) = object.get("timestamp").and_then(Value::as_f64) {
        return Some(number as i64);
    }
    if let Some(text) = object.get("timestamp").and_then(Value::as_str) {
        return parse_date_ms(text);
    }
    None
}

pub fn tokens_from_qwen_usage(usage: &Map<String, Value>) -> (f64, f64, f64) {
    let input = first_num(
        usage,
        &[
            "input_tokens",
            "promptTokenCount",
            "input_token_count",
            "input",
        ],
    );
    let output = first_num(
        usage,
        &[
            "output_tokens",
            "candidatesTokenCount",
            "output_token_count",
            "output",
        ],
    );
    let cache = first_num(
        usage,
        &[
            "cache_read_input_tokens",
            "cachedContentTokenCount",
            "cached_content_token_count",
            "cacheRead",
        ],
    );
    (input, output, cache)
}

fn first_num(object: &Map<String, Value>, keys: &[&str]) -> f64 {
    for key in keys {
        let number = num_value(object.get(*key));
        if number != 0.0 {
            return number;
        }
    }
    0.0
}

fn usage_nonzero(tokens: (f64, f64, f64)) -> bool {
    tokens.0 != 0.0 || tokens.1 != 0.0 || tokens.2 != 0.0
}

fn usage_from_qwen_object(object: &Map<String, Value>) -> Option<(f64, f64, f64)> {
    let kind = object.get("type").and_then(Value::as_str)?;
    if kind == "assistant" {
        if let Some(message) = object.get("message").and_then(Value::as_object)
            && let Some(usage) = message.get("usage").and_then(Value::as_object)
        {
            let tokens = tokens_from_qwen_usage(usage);
            return usage_nonzero(tokens).then_some(tokens);
        }
        if let Some(usage) = object.get("usageMetadata").and_then(Value::as_object) {
            let tokens = tokens_from_qwen_usage(usage);
            return usage_nonzero(tokens).then_some(tokens);
        }
        return None;
    }
    if kind == "result" {
        let usage = object.get("usage").and_then(Value::as_object)?;
        let tokens = tokens_from_qwen_usage(usage);
        return usage_nonzero(tokens).then_some(tokens);
    }
    if kind == "system" {
        if object_str(object, "subtype") != Some("ui_telemetry") {
            return None;
        }
        let ui = object
            .get("systemPayload")
            .and_then(Value::as_object)
            .and_then(|payload| payload.get("uiEvent"))
            .and_then(Value::as_object)?;
        if object_str(ui, "event.name") != Some("qwen-code.api_response") {
            return None;
        }
        let tokens = tokens_from_qwen_usage(ui);
        return usage_nonzero(tokens).then_some(tokens);
    }
    None
}

pub fn is_fatal_qwen_result(object: &Map<String, Value>) -> bool {
    if object.get("is_error") == Some(&Value::Bool(true)) {
        return true;
    }
    object_str(object, "subtype") != Some("success")
}

struct QwenConsume {
    text: String,
    session_id: Option<String>,
    saw_terminal: bool,
    saw_text_delta: bool,
    saw_thinking_delta: bool,
    error: Option<String>,
    tool_names: HashMap<String, String>,
    started: HashSet<String>,
    stdout_input: f64,
    stdout_output: f64,
    stdout_records: u32,
    result_usage: Option<(f64, f64)>,
}

pub fn canonical_qwen_session_id(native: Option<&str>) -> Option<String> {
    canonical_session_id(QWEN_CODE_HARNESS_ID, native)
}

#[derive(Clone)]
pub struct QwenCodeExecutor {
    pub binary: String,
    pub model_id: Option<String>,
    pub cwd: Option<String>,
    pub qwen_home: Option<String>,
    pub max_session_turns: Option<u32>,
    pub kill_grace: Duration,
    pub env: Arc<dyn Env>,
    pub history: Option<Arc<HistorySource>>,
}

impl QwenCodeExecutor {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            model_id: None,
            cwd: None,
            qwen_home: None,
            max_session_turns: None,
            kill_grace: Duration::from_millis(KILL_GRACE_MS),
            env: Arc::new(ProcessEnv),
            history: None,
        }
    }
}

impl HarnessExecutor for QwenCodeExecutor {
    fn name(&self) -> &str {
        QWEN_CODE_HARNESS_ID
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::argv(false)
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
                .unwrap_or_else(|| default_workspace_dir().display().to_string());
            let home = cfg
                .qwen_home
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(qwen_home);
            let result = drive(
                spec,
                parts_for_task,
                DrivePlan {
                    harness: "qwen".to_string(),
                    prefix: QWEN_CODE_HARNESS_ID.to_string(),
                    mode: ScaffoldMode::AppendWithCwd,
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
                    async move { run_qwen_spawn(cfg, call, cwd, home, active, killed, events).await }
                },
            )
            .await;
            publish(&parts, result);
        });
        handle
    }
}

async fn run_qwen_spawn(
    cfg: QwenCodeExecutor,
    call: TurnCall,
    cwd: String,
    home: PathBuf,
    active: KillSlot,
    killed: Arc<std::sync::atomic::AtomicBool>,
    events: crate::model::EventQueue,
) -> SpawnOutcome {
    let pin = if call.resume_native.is_none() {
        Some(Uuid::new_v4().to_string())
    } else {
        None
    };
    let ids_before = if call.resume_native.is_none() {
        let home = home.clone();
        Some(
            tokio::task::spawn_blocking(move || list_qwen_session_ids(&home))
                .await
                .unwrap_or_default(),
        )
    } else {
        None
    };
    let mut spawned = match spawn_qwen(&cfg, &call, &cwd, pin.clone()).await {
        Ok(spawned) => spawned,
        Err(error) => return SpawnOutcome::failure(error),
    };
    *active.lock() = Some(spawned.share_kill());
    if killed.load(Ordering::SeqCst) {
        spawned.kill();
    }
    let mut state = QwenConsume {
        text: String::new(),
        session_id: None,
        saw_terminal: false,
        saw_text_delta: false,
        saw_thinking_delta: false,
        error: None,
        tool_names: HashMap::new(),
        started: HashSet::new(),
        stdout_input: 0.0,
        stdout_output: 0.0,
        stdout_records: 0,
        result_usage: None,
    };
    while let Some(line) = spawned.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(object) = value.as_object() else {
            continue;
        };
        if object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            continue;
        }
        consume_qwen_line(object, &mut state, &events);
    }
    let code = spawned.wait_exit().await;
    let stderr = spawned.stderr_text();
    let stdout = spawned.stdout_text();
    *active.lock() = None;
    spawned.kill();
    if call.resume_native.is_some()
        && qwen_resume_rejected(&stdout)
        && !killed.load(Ordering::SeqCst)
    {
        let refused = call.resume_native.unwrap_or_default();
        return SpawnOutcome {
            text: state.text,
            native_id: None,
            error: Some(format!("qwen refused to resume {refused}")),
            resume_rejected: true,
            input_tokens: 0.0,
            output_tokens: 0.0,
            cost_usd: None,
        };
    }
    if code != Some(0) && state.error.is_none() && !killed.load(Ordering::SeqCst) {
        state.error = Some(format!(
            "qwen CLI exited {}: {}",
            exit_label(code),
            stderr_tail(&stderr)
        ));
    }
    if !state.saw_terminal && state.error.is_none() && !killed.load(Ordering::SeqCst) {
        let tail = stderr_tail(&stderr);
        state.error = Some(if tail.is_empty() {
            "qwen CLI stream ended without a terminal event".to_string()
        } else {
            format!("qwen CLI stream ended without a terminal event: {tail}")
        });
    }
    if state.session_id.is_none() {
        state.session_id = call.resume_native.clone().or(pin);
        if state.session_id.is_none()
            && let Some(before) = ids_before.as_ref()
        {
            let home = home.clone();
            let before = before.clone();
            state.session_id = tokio::task::spawn_blocking(move || recover_qwen(&home, &before))
                .await
                .unwrap_or(None);
        }
    }
    let (input_tokens, output_tokens) = if state.stdout_records > 0 {
        (state.stdout_input, state.stdout_output)
    } else if let Some(usage) = state.result_usage {
        usage
    } else {
        let since = spawned.started_at_ms;
        let home_for_disk = home.clone();
        let cwd_for_disk = cwd.clone();
        let session_for_disk = state.session_id.clone();
        let facts = tokio::task::spawn_blocking(move || {
            let Some(session_id) = session_for_disk else {
                return QwenTurnFacts::default();
            };
            let Some(file) = find_qwen_session_file(&home_for_disk, &cwd_for_disk, &session_id)
            else {
                return QwenTurnFacts::default();
            };
            reconcile_qwen_turn(&file, since)
        })
        .await
        .unwrap_or_default();
        if facts.usage_records == 0 {
            tracing::warn!("task.usage.unreconciled");
        }
        (facts.input_tokens, facts.output_tokens)
    };
    SpawnOutcome {
        text: state.text,
        native_id: state.session_id,
        error: state.error,
        resume_rejected: false,
        input_tokens,
        output_tokens,
        cost_usd: None,
    }
}

fn recover_qwen(home: &Path, ids_before: &[String]) -> Option<String> {
    let fresh: Vec<String> = list_qwen_session_ids(home)
        .into_iter()
        .filter(|id| !ids_before.contains(id))
        .collect();
    (fresh.len() == 1).then(|| fresh[0].clone())
}

fn consume_qwen_line(
    object: &Map<String, Value>,
    state: &mut QwenConsume,
    events: &crate::model::EventQueue,
) {
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "system" {
        let subtype = object.get("subtype").and_then(Value::as_str);
        if (subtype.is_none() || subtype == Some("init"))
            && let Some(id) = object_str(object, "session_id")
                .or_else(|| object_str(object, "sessionId"))
                .or_else(|| object_str(object, "id"))
        {
            state.session_id = Some(id.to_string());
        }
        return;
    }
    if kind == "result" {
        state.saw_terminal = true;
        if is_fatal_qwen_result(object) {
            let subtype = object_str(object, "subtype").unwrap_or("error");
            state
                .error
                .get_or_insert_with(|| format!("qwen result: {subtype}"));
        }
        if let Some(tokens) = usage_from_qwen_object(object) {
            state.result_usage = Some((tokens.0, tokens.1));
        }
        return;
    }
    if kind == "stream_event" {
        let Some(inner) = object.get("event").and_then(Value::as_object) else {
            return;
        };
        let inner_type = object_str(inner, "type").unwrap_or("");
        if inner_type == "content_block_start" {
            let block = inner.get("content_block").and_then(Value::as_object);
            if block.and_then(|block| object_str(block, "type")) == Some("text")
                && !state.text.is_empty()
            {
                state.text.push('\n');
            }
            return;
        }
        if inner_type != "content_block_delta" {
            return;
        }
        let Some(delta) = inner.get("delta").and_then(Value::as_object) else {
            return;
        };
        let delta_type = object_str(delta, "type").unwrap_or("");
        if delta_type == "text_delta"
            && let Some(text) = object_str(delta, "text")
        {
            state.saw_text_delta = true;
            state.text.push_str(text);
            events.push(den_message(text));
        } else if delta_type == "thinking_delta"
            && let Some(text) = object_str(delta, "thinking")
        {
            state.saw_thinking_delta = true;
            events.push(den_thinking(text));
        }
        return;
    }
    if kind == "assistant" {
        if let Some(tokens) = usage_from_qwen_object(object) {
            state.stdout_input = tokens.0;
            state.stdout_output = tokens.1;
            state.stdout_records += 1;
        }
        let content = object
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array);
        let Some(content) = content else {
            return;
        };
        for item in content {
            let Some(item) = item.as_object() else {
                continue;
            };
            let item_type = object_str(item, "type").unwrap_or("");
            if item_type == "text"
                && let Some(text) = object_str(item, "text")
            {
                if state.saw_text_delta || text.is_empty() {
                    continue;
                }
                if !state.text.is_empty() {
                    state.text.push('\n');
                }
                state.text.push_str(text);
                events.push(den_message(text));
            } else if item_type == "thinking"
                && let Some(text) = object_str(item, "thinking")
            {
                if state.saw_thinking_delta || text.is_empty() {
                    continue;
                }
                events.push(den_thinking(text));
            } else if item_type == "tool_use" {
                emit_qwen_tool_start(item, state, events);
            }
        }
        return;
    }
    if kind == "user" {
        let content = object
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array);
        let Some(content) = content else {
            return;
        };
        for item in content {
            let Some(item) = item.as_object() else {
                continue;
            };
            if object_str(item, "type") == Some("tool_result") {
                emit_qwen_tool_end(item, state, events);
            }
        }
    }
}

fn emit_qwen_tool_start(
    rec: &Map<String, Value>,
    state: &mut QwenConsume,
    events: &crate::model::EventQueue,
) {
    let Some(name) = object_str(rec, "name") else {
        return;
    };
    let id = object_str(rec, "id");
    if let Some(id) = id {
        state.tool_names.insert(id.to_string(), name.to_string());
    }
    let key = id.unwrap_or(name).to_string();
    if !state.started.insert(key) {
        return;
    }
    events.push(den_tool_start(name));
}

fn emit_qwen_tool_end(
    rec: &Map<String, Value>,
    state: &mut QwenConsume,
    events: &crate::model::EventQueue,
) {
    let id = object_str(rec, "tool_use_id").or_else(|| object_str(rec, "id"));
    let named = object_str(rec, "name")
        .or_else(|| id.and_then(|id| state.tool_names.get(id).map(String::as_str)))
        .map(str::to_string);
    if let (Some(id), Some(named)) = (id, named.as_deref()) {
        state.tool_names.insert(id.to_string(), named.to_string());
    }
    events.push(den_tool_end(named));
}

async fn spawn_qwen(
    cfg: &QwenCodeExecutor,
    call: &TurnCall,
    cwd: &str,
    pin: Option<String>,
) -> Result<crate::spawn::Spawned, String> {
    let model = call.model.clone().or_else(|| cfg.model_id.clone());
    let turns = call_max_turns(call, cfg);
    let args = build_qwen_args(
        &QwenFlags {
            model_id: model,
            resume_session_id: call.resume_native.clone(),
            pin_session_id: pin,
            append_system_prompt: Some(call.append_system_prompt.clone())
                .filter(|text| !text.is_empty()),
            max_session_turns: turns,
        },
        &call.prompt,
    );
    let overrides = vec![
        ("RIVETOS_TASK_ID".to_string(), Some(call.task_id.clone())),
        ("RIVETOS_SESSION_KEY".to_string(), None),
    ];
    let env = build_qwen_child_env(cfg.env.as_ref(), &overrides);
    tracing::info!(task_id = %call.task_id, message_len = call.message.len(), "task.spawn");
    spawn_child(SpawnRequest {
        binary: &cfg.binary,
        args: &args,
        cwd: Some(cwd),
        env: &env,
        stdin: StdinMode::Ignore,
        kill_grace: cfg.kill_grace,
        capture_stdout: true,
    })
    .await
    .map_err(|error| format!("Failed to spawn {}: {error}", cfg.binary))
}

fn call_max_turns(call: &TurnCall, cfg: &QwenCodeExecutor) -> Option<u32> {
    let _ = call.message.len();
    cfg.max_session_turns
}
