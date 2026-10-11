use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{Map, Value};
use transcripts::fsutil::{is_file, read_dir_names, read_lossy};
use transcripts::paths::encode_pi_cwd;
use transcripts::pi_turns_from_lines;
use transcripts::timeutil::parse_date_ms;
use transcripts::turn::Role;

use crate::drive::{DrivePlan, HistorySource, ScaffoldMode, SpawnOutcome, TurnCall, drive};
use crate::model::{
    AbortFlag, Capabilities, KillSlot, TaskSpec, den_message, den_thinking, den_tool_end,
    den_tool_start, log_event, open_handle, publish,
};
use crate::prompt::canonical_session_id;
use crate::registry::HarnessExecutor;
use crate::spawn::{
    KILL_GRACE_MS, SpawnRequest, StdinMode, child_env, exit_label, spawn_child, stderr_tail,
};
use crate::standard_helpers::{Env, ProcessEnv, home_path, num_value, object_str};

pub const PI_HARNESS_ID: &str = "pi";

pub struct PiFlags {
    pub model_id: Option<String>,
    pub resume_session_id: Option<String>,
    pub pin_session_id: Option<String>,
    pub session_dir: Option<String>,
    pub thinking: Option<String>,
    pub append_system_prompt: Option<String>,
}

pub fn build_pi_args(flags: &PiFlags, prompt: &str) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--mode".to_string(),
        "json".to_string(),
    ];
    if let Some(id) = flags.pin_session_id.as_deref().filter(|id| !id.is_empty()) {
        args.push("--session-id".to_string());
        args.push(id.to_string());
    } else if let Some(id) = flags
        .resume_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        args.push("--session".to_string());
        args.push(id.to_string());
    }
    if let Some(dir) = flags.session_dir.as_deref().filter(|dir| !dir.is_empty()) {
        args.push("--session-dir".to_string());
        args.push(dir.to_string());
    }
    if let Some(model) = flags.model_id.as_deref().filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(thinking) = flags
        .thinking
        .as_deref()
        .filter(|thinking| !thinking.is_empty())
    {
        args.push("--thinking".to_string());
        args.push(thinking.to_string());
    }
    if let Some(prompt) = flags
        .append_system_prompt
        .as_deref()
        .filter(|prompt| !prompt.is_empty())
    {
        args.push("--append-system-prompt".to_string());
        args.push(prompt.to_string());
    }
    args.push("--".to_string());
    args.push(crate::prompt::clamp_prompt(prompt));
    args
}

pub fn build_pi_child_env(
    base: &dyn Env,
    overrides: &[(String, Option<String>)],
) -> std::collections::BTreeMap<String, String> {
    child_env(base, overrides, &[], &[])
}

pub fn pi_resume_rejected(text: &str) -> bool {
    pi_re().is_some_and(|regex| regex.find(text).is_some())
}

fn pi_re() -> Option<&'static regress::Regex> {
    static RE: OnceLock<Option<regress::Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        regress::Regex::with_flags(
            r#"Session "[^"]*" (?:not found|was created under a different directory)|session not found"#,
            "i",
        )
        .ok()
    })
    .as_ref()
}

pub fn pi_home() -> PathBuf {
    home_path(&ProcessEnv).join(".pi").join("agent")
}

pub fn pi_sessions_root(home: &Path) -> PathBuf {
    home.join("sessions")
}

pub fn is_pi_native_id(id: &str) -> bool {
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

fn native_from_pi_filename(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".jsonl")?;
    let (_, id) = stem.rsplit_once('_')?;
    is_pi_native_id(id).then(|| id.to_string())
}

pub fn find_pi_session_file(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    if !is_pi_native_id(session_id) {
        return None;
    }
    let root = pi_sessions_root(home);
    if !cwd.is_empty() {
        let bucket = root.join(encode_pi_cwd(cwd));
        if let Some(names) = read_dir_names(&bucket) {
            for name in names {
                if native_from_pi_filename(&name).as_deref() == Some(session_id) {
                    let full = bucket.join(&name);
                    if is_file(&full) {
                        return Some(full);
                    }
                }
            }
        }
    }
    for (id, path) in walk_pi_sessions(home) {
        if id == session_id {
            return Some(path);
        }
    }
    None
}

pub fn list_pi_session_ids(home: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    for (id, _) in walk_pi_sessions(home) {
        if !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    ids
}

fn walk_pi_sessions(home: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let root = pi_sessions_root(home);
    let Some(entries) = read_dir_names(&root) else {
        return out;
    };
    for entry in entries {
        if entry.starts_with('.') {
            continue;
        }
        let full = root.join(&entry);
        if is_file(&full) {
            if let Some(id) = native_from_pi_filename(&entry) {
                out.push((id, full));
            }
            continue;
        }
        let Some(names) = read_dir_names(&full) else {
            continue;
        };
        for name in names {
            let path = full.join(&name);
            if is_file(&path)
                && let Some(id) = native_from_pi_filename(&name)
            {
                out.push((id, path));
            }
        }
    }
    out
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PiTurnEnd {
    pub reason: String,
    pub time_ms: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PiTurnFacts {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: f64,
    pub usage_records: u32,
    pub turn_ended: Option<PiTurnEnd>,
    pub files: u32,
    pub malformed: u32,
}

pub fn pi_transcript_files(session_file: &Path) -> Vec<PathBuf> {
    if is_file(session_file) {
        vec![session_file.to_path_buf()]
    } else {
        Vec::new()
    }
}

pub fn reconcile_pi_turn(session_file: &Path, since_ms: i64) -> PiTurnFacts {
    let mut facts = PiTurnFacts::default();
    let mut kept = Vec::new();
    for file in pi_transcript_files(session_file) {
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
            let time_ms = pi_event_time_ms(&object);
            if time_ms.is_some_and(|time| time < since_ms) {
                continue;
            }
            if let Some((input, output)) = usage_from_pi_object(&object) {
                facts.input_tokens += input;
                facts.output_tokens += output;
                facts.usage_records += 1;
            }
            if object.get("type").and_then(Value::as_str) == Some("message")
                && let Some(message) = object.get("message").and_then(Value::as_object)
                && object_str(message, "role") == Some("assistant")
                && let Some(reason) = object_str(message, "stopReason")
            {
                let ended = PiTurnEnd {
                    reason: reason.to_string(),
                    time_ms: time_ms.unwrap_or(0) as f64,
                };
                let replace = facts
                    .turn_ended
                    .as_ref()
                    .is_none_or(|current| ended.time_ms >= current.time_ms);
                if replace {
                    facts.turn_ended = Some(ended);
                }
            }
            kept.push(object);
        }
    }
    let turns = pi_turns_from_lines(&kept);
    let reader_records = turns
        .iter()
        .filter(|turn| turn.role == Role::Assistant && turn.usage.is_some())
        .count() as u32;
    if reader_records > 0 && reader_records == facts.usage_records {
        facts.input_tokens = 0.0;
        facts.output_tokens = 0.0;
        facts.usage_records = 0;
        for turn in turns {
            if turn.role != Role::Assistant {
                continue;
            }
            let Some(usage) = turn.usage else {
                continue;
            };
            facts.input_tokens += usage.prompt_tokens as f64;
            facts.output_tokens += usage.completion_tokens as f64;
            facts.usage_records += 1;
        }
    }
    facts.total_tokens = facts.input_tokens + facts.output_tokens;
    facts
}

fn pi_event_time_ms(object: &Map<String, Value>) -> Option<i64> {
    if let Some(number) = object.get("timestamp").and_then(Value::as_i64) {
        return Some(number);
    }
    if let Some(number) = object.get("timestamp").and_then(Value::as_f64) {
        return Some(number as i64);
    }
    if let Some(text) = object.get("timestamp").and_then(Value::as_str) {
        return parse_date_ms(text);
    }
    if object.get("type").and_then(Value::as_str) == Some("message")
        && let Some(message) = object.get("message").and_then(Value::as_object)
    {
        if let Some(number) = message.get("timestamp").and_then(Value::as_i64) {
            return Some(number);
        }
        if let Some(number) = message.get("timestamp").and_then(Value::as_f64) {
            return Some(number as i64);
        }
    }
    None
}

fn usage_from_pi_object(object: &Map<String, Value>) -> Option<(f64, f64)> {
    let kind = object.get("type").and_then(Value::as_str)?;
    if kind != "message" && kind != "message_end" && kind != "turn_end" {
        return None;
    }
    let message = object.get("message").and_then(Value::as_object)?;
    if object_str(message, "role") != Some("assistant") {
        return None;
    }
    if object_str(message, "stopReason") == Some("pending") {
        return None;
    }
    let usage = message.get("usage").and_then(Value::as_object)?;
    let tokens = tokens_from_pi_usage(usage);
    (tokens.0 != 0.0 || tokens.1 != 0.0).then_some(tokens)
}

pub fn tokens_from_pi_usage(usage: &Map<String, Value>) -> (f64, f64) {
    let input = first_num(
        usage,
        &["input", "input_tokens", "inputTokens", "promptTokens"],
    );
    let output = first_num(
        usage,
        &[
            "output",
            "output_tokens",
            "outputTokens",
            "completionTokens",
        ],
    );
    let cache_read = first_num(usage, &["cacheRead", "cache_read_tokens"]);
    let cache_write = first_num(usage, &["cacheWrite", "cache_write_tokens"]);
    (input + cache_read + cache_write, output)
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

pub fn is_fatal_pi_stop_reason(reason: Option<&str>) -> bool {
    matches!(
        reason.map(|reason| reason.to_lowercase()).as_deref(),
        Some("error" | "aborted")
    )
}

struct PiConsume {
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
}

pub fn canonical_pi_session_id(native: Option<&str>) -> Option<String> {
    canonical_session_id(PI_HARNESS_ID, native)
}

#[derive(Clone)]
pub struct PiExecutor {
    pub binary: String,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
    pub pi_home: Option<String>,
    pub kill_grace: Duration,
    pub env: Arc<dyn Env>,
    pub history: Option<Arc<HistorySource>>,
}

impl PiExecutor {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            model_id: None,
            effort: None,
            cwd: None,
            pi_home: None,
            kill_grace: Duration::from_millis(KILL_GRACE_MS),
            env: Arc::new(ProcessEnv),
            history: None,
        }
    }
}

impl HarnessExecutor for PiExecutor {
    fn name(&self) -> &str {
        PI_HARNESS_ID
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
                .pi_home
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(pi_home);
            let result = drive(
                spec,
                parts_for_task,
                DrivePlan {
                    harness: "pi".to_string(),
                    prefix: PI_HARNESS_ID.to_string(),
                    mode: ScaffoldMode::Append,
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
                    async move { run_pi_spawn(cfg, call, cwd, home, active, killed, events).await }
                },
            )
            .await;
            publish(&parts, result);
        });
        handle
    }
}

async fn run_pi_spawn(
    cfg: PiExecutor,
    call: TurnCall,
    cwd: String,
    home: PathBuf,
    active: KillSlot,
    killed: Arc<std::sync::atomic::AtomicBool>,
    events: crate::model::EventQueue,
) -> SpawnOutcome {
    let ids_before = if call.resume_native.is_none() {
        let home = home.clone();
        Some(
            tokio::task::spawn_blocking(move || list_pi_session_ids(&home))
                .await
                .unwrap_or_default(),
        )
    } else {
        None
    };
    let mut spawned = match spawn_pi(&cfg, &call, &cwd).await {
        Ok(spawned) => spawned,
        Err(error) => return SpawnOutcome::failure(error),
    };
    *active.lock() = Some(spawned.share_kill());
    if killed.load(Ordering::SeqCst) {
        spawned.kill();
    }
    let mut state = PiConsume {
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
        consume_pi_line(object, &mut state, &events);
    }
    let code = spawned.wait_exit().await;
    let stderr = spawned.stderr_text();
    *active.lock() = None;
    spawned.kill();
    if code != Some(0) && state.error.is_none() && !killed.load(Ordering::SeqCst) {
        state.error = Some(format!(
            "pi CLI exited {}: {}",
            exit_label(code),
            stderr_tail(&stderr)
        ));
    }
    if !state.saw_terminal && state.error.is_none() && !killed.load(Ordering::SeqCst) {
        state.error = Some("pi CLI stream ended without a terminal event".to_string());
    }
    if state.error.is_some() && pi_resume_rejected(&stderr) && call.resume_native.is_some() {
        return SpawnOutcome {
            text: state.text,
            native_id: state.session_id,
            error: state.error,
            resume_rejected: true,
            input_tokens: 0.0,
            output_tokens: 0.0,
            cost_usd: None,
        };
    }
    if state.session_id.is_none() {
        state.session_id = call.resume_native.clone();
        if state.session_id.is_none()
            && let Some(before) = ids_before.as_ref()
        {
            let home = home.clone();
            let before = before.clone();
            state.session_id = tokio::task::spawn_blocking(move || recover_pi(&home, &before))
                .await
                .unwrap_or(None);
        }
    }
    let (input_tokens, output_tokens) = if state.stdout_records > 0 {
        (state.stdout_input, state.stdout_output)
    } else {
        let since = spawned.started_at_ms;
        let home_for_disk = home.clone();
        let cwd_for_disk = cwd.clone();
        let session_for_disk = state.session_id.clone();
        let facts = tokio::task::spawn_blocking(move || {
            let Some(session_id) = session_for_disk else {
                return PiTurnFacts::default();
            };
            let Some(file) = find_pi_session_file(&home_for_disk, &cwd_for_disk, &session_id)
            else {
                return PiTurnFacts::default();
            };
            reconcile_pi_turn(&file, since)
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

fn recover_pi(home: &Path, ids_before: &[String]) -> Option<String> {
    let fresh: Vec<String> = list_pi_session_ids(home)
        .into_iter()
        .filter(|id| !ids_before.contains(id))
        .collect();
    (fresh.len() == 1).then(|| fresh[0].clone())
}

fn consume_pi_line(
    object: &Map<String, Value>,
    state: &mut PiConsume,
    events: &crate::model::EventQueue,
) {
    if let Some((input, output)) = usage_from_pi_object(object) {
        state.stdout_input = input;
        state.stdout_output = output;
        state.stdout_records += 1;
    }
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "session" {
        if let Some(id) = object_str(object, "id")
            .or_else(|| object_str(object, "session_id"))
            .or_else(|| object_str(object, "sessionId"))
        {
            state.session_id = Some(id.to_string());
        }
        return;
    }
    if kind == "agent_end" || kind == "agent_settled" || kind == "turn_end" {
        state.saw_terminal = true;
        if kind == "turn_end"
            && let Some(message) = object.get("message").and_then(Value::as_object)
            && let Some(stop) = object_str(message, "stopReason")
            && is_fatal_pi_stop_reason(Some(stop))
        {
            state
                .error
                .get_or_insert_with(|| format!("pi stopReason: {stop}"));
        }
        return;
    }
    if kind == "error" {
        if let Some(message) = object_str(object, "message") {
            events.push(log_event("warn", format!("pi error event: {message}")));
        }
        return;
    }
    if kind == "message_update" {
        let Some(inner) = object
            .get("assistantMessageEvent")
            .and_then(Value::as_object)
        else {
            return;
        };
        let inner_type = object_str(inner, "type").unwrap_or("");
        if inner_type == "text_start" {
            if !state.text.is_empty() {
                state.text.push('\n');
            }
            return;
        }
        if inner_type == "text_delta"
            && let Some(delta) = object_str(inner, "delta")
        {
            state.saw_text_delta = true;
            state.text.push_str(delta);
            events.push(den_message(delta));
            return;
        }
        if inner_type == "thinking_delta"
            && let Some(delta) = object_str(inner, "delta")
        {
            state.saw_thinking_delta = true;
            events.push(den_thinking(delta));
            return;
        }
        if matches!(
            inner_type,
            "toolcall_start" | "toolcall_end" | "tool_call_start" | "tool_call_end"
        ) {
            emit_pi_tool_start(inner, state, events);
        }
        return;
    }
    if kind == "message_start" || kind == "message_end" {
        let Some(message) = object.get("message").and_then(Value::as_object) else {
            return;
        };
        let role = object_str(message, "role").unwrap_or("");
        if role == "toolResult" || role == "tool_result" {
            if kind == "message_end" {
                emit_pi_tool_end(message, state, events);
            }
            return;
        }
        if role != "assistant" || kind != "message_end" {
            return;
        }
        if let Some(stop) = object_str(message, "stopReason")
            && is_fatal_pi_stop_reason(Some(stop))
        {
            state
                .error
                .get_or_insert_with(|| format!("pi stopReason: {stop}"));
        }
        let content = message.get("content");
        let items = content_items(content);
        for item in items {
            let item_type = object_str(&item, "type").unwrap_or("");
            if item_type == "text"
                && let Some(text) = object_str(&item, "text")
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
                && let Some(text) = object_str(&item, "thinking")
            {
                if state.saw_thinking_delta || text.is_empty() {
                    continue;
                }
                events.push(den_thinking(text));
            } else if matches!(item_type, "toolCall" | "tool_call" | "toolUse" | "tool_use") {
                emit_pi_tool_start(&item, state, events);
            } else if matches!(item_type, "toolResult" | "tool_result") {
                emit_pi_tool_end(&item, state, events);
            }
        }
    }
}

fn content_items(content: Option<&Value>) -> Vec<Map<String, Value>> {
    match content {
        Some(Value::String(text)) if !text.is_empty() => {
            let mut item = Map::new();
            item.insert("type".to_string(), Value::String("text".to_string()));
            item.insert("text".to_string(), Value::String(text.clone()));
            vec![item]
        }
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_object().cloned())
            .collect(),
        _ => Vec::new(),
    }
}

fn emit_pi_tool_start(
    rec: &Map<String, Value>,
    state: &mut PiConsume,
    events: &crate::model::EventQueue,
) {
    let nested = rec
        .get("content")
        .and_then(Value::as_object)
        .or_else(|| rec.get("partial").and_then(Value::as_object))
        .or_else(|| rec.get("toolCall").and_then(Value::as_object));
    let name = object_str(rec, "name")
        .or_else(|| object_str(rec, "toolName"))
        .or_else(|| nested.and_then(|nested| object_str(nested, "name")))
        .or_else(|| nested.and_then(|nested| object_str(nested, "toolName")));
    let Some(name) = name else {
        return;
    };
    let id = object_str(rec, "id")
        .or_else(|| object_str(rec, "toolCallId"))
        .or_else(|| nested.and_then(|nested| object_str(nested, "id")))
        .or_else(|| nested.and_then(|nested| object_str(nested, "toolCallId")));
    if let Some(id) = id {
        state.tool_names.insert(id.to_string(), name.to_string());
    }
    let key = id.unwrap_or(name).to_string();
    if !state.started.insert(key) {
        return;
    }
    events.push(den_tool_start(name));
}

fn emit_pi_tool_end(
    rec: &Map<String, Value>,
    state: &mut PiConsume,
    events: &crate::model::EventQueue,
) {
    let id = object_str(rec, "toolCallId").or_else(|| object_str(rec, "id"));
    let named = object_str(rec, "toolName")
        .or_else(|| object_str(rec, "name"))
        .or_else(|| id.and_then(|id| state.tool_names.get(id).map(String::as_str)))
        .map(str::to_string);
    if let (Some(id), Some(named)) = (id, named.as_deref()) {
        state.tool_names.insert(id.to_string(), named.to_string());
    }
    events.push(den_tool_end(named));
}

async fn spawn_pi(
    cfg: &PiExecutor,
    call: &TurnCall,
    cwd: &str,
) -> Result<crate::spawn::Spawned, String> {
    let effort = call.effort.clone().or_else(|| cfg.effort.clone());
    let model = call.model.clone().or_else(|| cfg.model_id.clone());
    let session_dir = cfg
        .pi_home
        .as_ref()
        .map(|home| Path::new(home).join("sessions").display().to_string());
    let args = build_pi_args(
        &PiFlags {
            model_id: model,
            resume_session_id: call.resume_native.clone(),
            pin_session_id: None,
            session_dir,
            thinking: effort,
            append_system_prompt: Some(call.append_system_prompt.clone())
                .filter(|text| !text.is_empty()),
        },
        &call.prompt,
    );
    let overrides = vec![
        ("RIVETOS_TASK_ID".to_string(), Some(call.task_id.clone())),
        ("RIVETOS_SESSION_KEY".to_string(), None),
        (
            "RIVETOS_DEN_HOOK_DISABLED".to_string(),
            Some("1".to_string()),
        ),
    ];
    let env = build_pi_child_env(cfg.env.as_ref(), &overrides);
    tracing::info!(task_id = %call.task_id, message_len = call.message.len(), "task.spawn");
    spawn_child(SpawnRequest {
        binary: &cfg.binary,
        args: &args,
        cwd: Some(cwd),
        env: &env,
        stdin: StdinMode::Ignore,
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
