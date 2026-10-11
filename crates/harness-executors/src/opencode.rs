use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{Map, Value};
use transcripts::db::{open_readonly, query_maps};
use transcripts::fsutil::node_resolve;
use transcripts::opencode_turns_from_messages;
use transcripts::turn::Role;

use crate::drive::{DrivePlan, HistorySource, ScaffoldMode, SpawnOutcome, TurnCall, drive};
use crate::model::{
    AbortFlag, Capabilities, KillSlot, TaskSpec, den_message, den_tool_end, den_tool_start,
    log_event, open_handle, publish,
};
use crate::prompt::{canonical_session_id, variant_for_effort};
use crate::registry::HarnessExecutor;
use crate::spawn::{
    KILL_GRACE_MS, SpawnRequest, StdinMode, child_env, exit_label, spawn_child, stderr_tail,
};
use crate::standard_helpers::{Env, ProcessEnv, home_path, json_str, num_value, object_str};

pub const OPENCODE_HARNESS_ID: &str = "opencode";

pub struct OpencodeFlags {
    pub model_id: Option<String>,
    pub resume_session_id: Option<String>,
    pub effort: Option<String>,
}

pub fn build_opencode_args(flags: &OpencodeFlags, prompt: &str) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if let Some(model) = flags.model_id.as_deref().filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(variant) = variant_for_effort(flags.effort.as_deref()) {
        args.push("--variant".to_string());
        args.push(variant);
    }
    if let Some(id) = flags
        .resume_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        args.push("--session".to_string());
        args.push(id.to_string());
    }
    args.push(crate::prompt::clamp_prompt(prompt));
    args
}

pub fn build_opencode_child_env(
    base: &dyn Env,
    overrides: &[(String, Option<String>)],
) -> std::collections::BTreeMap<String, String> {
    child_env(base, overrides, &[], &[])
}

pub fn opencode_resume_rejected(text: &str) -> bool {
    opencode_re().is_some_and(|regex| regex.find(text).is_some())
}

fn opencode_re() -> Option<&'static regress::Regex> {
    static RE: OnceLock<Option<regress::Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        regress::Regex::with_flags(r"no session|session(?:\s+\S+)*\s+not found", "i").ok()
    })
    .as_ref()
}

pub fn opencode_home(env: &dyn Env) -> PathBuf {
    if let Some(xdg) = env.var("XDG_DATA_HOME") {
        let trimmed = protocol::js::js_trim(&xdg);
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("opencode");
        }
    }
    home_path(env).join(".local").join("share").join("opencode")
}

pub fn opencode_db_path(home: &Path) -> PathBuf {
    home.join("opencode.db")
}

pub fn xdg_data_home_for(data_dir: &Path) -> PathBuf {
    if data_dir.file_name().and_then(|name| name.to_str()) == Some("opencode") {
        data_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| data_dir.to_path_buf())
    } else {
        data_dir.to_path_buf()
    }
}

pub fn effective_opencode_home(home: &Path) -> PathBuf {
    if home.file_name().and_then(|name| name.to_str()) == Some("opencode") {
        home.to_path_buf()
    } else {
        home.join("opencode")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedOpencodeEvent {
    pub kind: &'static str,
    pub session_id: Option<String>,
    pub text: String,
    pub tool: Option<String>,
    pub tool_call_id: Option<String>,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub has_usage: bool,
    pub error: Option<String>,
}

pub fn parse_opencode_event(row: &Value) -> Option<ParsedOpencodeEvent> {
    let row = row.as_object()?;
    let kind_name = row.get("type").and_then(Value::as_str).unwrap_or("");
    let part = row.get("part").and_then(Value::as_object);
    let session_id = session_id_of(row, part);
    let part_type = part.and_then(|part| object_str(part, "type"));
    let role = object_str(row, "role");
    if kind_name == "text" || part_type == Some("text") {
        let text = object_str(row, "text")
            .or_else(|| part.and_then(|part| object_str(part, "text")))
            .unwrap_or("")
            .to_string();
        return Some(ParsedOpencodeEvent {
            text,
            ..blank("text", session_id)
        });
    }
    if kind_name == "reasoning" || kind_name == "thinking" || part_type == Some("reasoning") {
        return Some(blank("other", session_id));
    }
    let is_tool = kind_name == "tool"
        || kind_name == "tool_use"
        || kind_name == "tool_result"
        || kind_name == "tool-result"
        || part_type == Some("tool");
    if is_tool {
        let tool = object_str(row, "tool")
            .or_else(|| part.and_then(|part| object_str(part, "tool")))
            .unwrap_or("tool")
            .to_string();
        let tool_call_id = object_str(row, "callID")
            .or_else(|| object_str(row, "toolCallId"))
            .or_else(|| object_str(row, "tool_call_id"))
            .or_else(|| object_str(row, "id"))
            .or_else(|| {
                part.and_then(|part| object_str(part, "callID").or_else(|| object_str(part, "id")))
            })
            .map(str::to_string);
        let state = part
            .and_then(|part| part.get("state"))
            .and_then(Value::as_object)
            .or_else(|| row.get("state").and_then(Value::as_object));
        let status = state.and_then(|state| object_str(state, "status"));
        let ended = kind_name == "tool_result"
            || kind_name == "tool-result"
            || status == Some("completed")
            || status == Some("error");
        let kind = if ended { "tool-end" } else { "tool-start" };
        return Some(ParsedOpencodeEvent {
            tool: Some(tool),
            tool_call_id,
            ..blank(kind, session_id)
        });
    }
    if kind_name == "step-finish"
        || kind_name == "step_finish"
        || kind_name == "step.finish"
        || kind_name == "usage"
    {
        let tokens = row
            .get("tokens")
            .and_then(Value::as_object)
            .or_else(|| part.and_then(|part| part.get("tokens").and_then(Value::as_object)));
        if let Some(tokens) = tokens {
            let (input, output) = tokens_to_usage(tokens);
            return Some(ParsedOpencodeEvent {
                input_tokens: input,
                output_tokens: output,
                has_usage: true,
                ..blank("usage", session_id)
            });
        }
        return Some(blank("other", session_id));
    }
    if role == Some("assistant")
        && let Some(tokens) = row.get("tokens").and_then(Value::as_object)
    {
        let (input, output) = tokens_to_usage(tokens);
        return Some(ParsedOpencodeEvent {
            input_tokens: input,
            output_tokens: output,
            has_usage: true,
            ..blank("usage", session_id)
        });
    }
    if kind_name == "error" || kind_name == "session.error" {
        let nested = row.get("error").and_then(Value::as_object);
        let message = object_str(row, "message")
            .or_else(|| nested.and_then(|error| object_str(error, "message")))
            .unwrap_or("opencode error")
            .to_string();
        return Some(ParsedOpencodeEvent {
            error: Some(message),
            ..blank("error", session_id)
        });
    }
    if kind_name == "session"
        || kind_name == "session.created"
        || kind_name == "step-start"
        || kind_name == "step_start"
    {
        let kind = if session_id.is_some() {
            "session"
        } else {
            "other"
        };
        return Some(blank(kind, session_id));
    }
    Some(blank("other", session_id))
}

fn blank(kind: &'static str, session_id: Option<String>) -> ParsedOpencodeEvent {
    ParsedOpencodeEvent {
        kind,
        session_id,
        text: String::new(),
        tool: None,
        tool_call_id: None,
        input_tokens: 0.0,
        output_tokens: 0.0,
        has_usage: false,
        error: None,
    }
}

fn session_id_of(row: &Map<String, Value>, part: Option<&Map<String, Value>>) -> Option<String> {
    json_str(row.get("sessionID"))
        .or_else(|| object_str(row, "sessionId").map(str::to_string))
        .or_else(|| object_str(row, "session_id").map(str::to_string))
        .or_else(|| {
            row.get("session")
                .and_then(Value::as_object)
                .and_then(|session| object_str(session, "id"))
                .map(str::to_string)
        })
        .or_else(|| {
            part.and_then(|part| {
                object_str(part, "sessionID")
                    .or_else(|| object_str(part, "sessionId"))
                    .or_else(|| object_str(part, "session_id"))
                    .map(str::to_string)
            })
        })
}

fn tokens_to_usage(tokens: &Map<String, Value>) -> (f64, f64) {
    let cache = tokens.get("cache").and_then(Value::as_object);
    let input = num_value(tokens.get("input"))
        + cache
            .map(|cache| num_value(cache.get("read")))
            .unwrap_or(0.0)
        + cache
            .map(|cache| num_value(cache.get("write")))
            .unwrap_or(0.0);
    let output = num_value(tokens.get("output")) + num_value(tokens.get("reasoning"));
    (input, output)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpencodeTurnEnd {
    pub reason: String,
    pub time_ms: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpencodeTurnFacts {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: f64,
    pub usage_records: u32,
    pub turn_ended: Option<OpencodeTurnEnd>,
    pub files: u32,
    pub malformed: u32,
}

pub fn reconcile_opencode_turn(home: &Path, session_id: &str, since_ms: i64) -> OpencodeTurnFacts {
    let mut facts = OpencodeTurnFacts::default();
    let Some(conn) = open_readonly(&opencode_db_path(home)) else {
        return facts;
    };
    let Some(rows) = query_maps(
        &conn,
        "SELECT data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC",
        &[&session_id],
    ) else {
        return facts;
    };
    let mut kept = Vec::new();
    for row in &rows {
        facts.files += 1;
        let parsed = parse_message_data(row.get("data"));
        let Some(data) = parsed else {
            facts.malformed += 1;
            continue;
        };
        if object_str(&data, "role") != Some("assistant") {
            continue;
        }
        let time_ms = message_time_ms(&data, row.get("time_created"));
        let Some(time_ms) = time_ms else {
            continue;
        };
        if time_ms < since_ms {
            continue;
        }
        let Some(tokens) = data.get("tokens").and_then(Value::as_object) else {
            continue;
        };
        let (input, output) = tokens_to_usage(tokens);
        facts.input_tokens += input;
        facts.output_tokens += output;
        facts.usage_records += 1;
        let ended = OpencodeTurnEnd {
            reason: "completed".to_string(),
            time_ms: time_ms as f64,
        };
        let replace = facts
            .turn_ended
            .as_ref()
            .is_none_or(|current| ended.time_ms >= current.time_ms);
        if replace {
            facts.turn_ended = Some(ended);
        }
        kept.push(data);
    }
    let reader = opencode_turns_from_messages(&kept, &HashMap::new());
    let reader_records = reader
        .iter()
        .filter(|turn| turn.role == Role::Assistant && turn.usage.is_some())
        .count() as u32;
    if reader_records > 0 && reader_records == facts.usage_records {
        facts.input_tokens = 0.0;
        facts.output_tokens = 0.0;
        facts.usage_records = 0;
        for turn in reader {
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

fn parse_message_data(raw: Option<&Value>) -> Option<Map<String, Value>> {
    match raw {
        Some(Value::Object(object)) => Some(object.clone()),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(trimmed)
                .ok()
                .and_then(|value| value.as_object().cloned())
        }
        _ => None,
    }
}

fn message_time_ms(data: &Map<String, Value>, column: Option<&Value>) -> Option<i64> {
    let time = data.get("time").and_then(Value::as_object);
    if let Some(completed) = time.and_then(|time| json_i64(time.get("completed"))) {
        return Some(completed);
    }
    if let Some(created) = time.and_then(|time| json_i64(time.get("created"))) {
        return Some(created);
    }
    json_i64(column)
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number as i64))
}

pub fn list_opencode_session_ids(home: &Path, cwd: &str) -> Vec<String> {
    let Some(conn) = open_readonly(&opencode_db_path(home)) else {
        return Vec::new();
    };
    let Some(rows) = query_maps(&conn, "SELECT id, directory FROM session", &[]) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for row in rows {
        let Some(id) = object_str(&row, "id") else {
            continue;
        };
        if let Some(dir) = object_str(&row, "directory")
            && !paths_equal(dir, cwd)
        {
            continue;
        }
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

pub fn newest_opencode_session_after(home: &Path, cwd: &str, since_ms: i64) -> Option<String> {
    let conn = open_readonly(&opencode_db_path(home))?;
    let rows = query_maps(
        &conn,
        "SELECT id, directory, time_created FROM session WHERE time_created >= ? ORDER BY time_created DESC",
        &[&since_ms],
    )?;
    for row in rows {
        let Some(id) = object_str(&row, "id") else {
            continue;
        };
        if let Some(dir) = object_str(&row, "directory")
            && !paths_equal(dir, cwd)
        {
            continue;
        }
        return Some(id.to_string());
    }
    None
}

fn paths_equal(left: &str, right: &str) -> bool {
    node_resolve(Path::new("/"), left) == node_resolve(Path::new("/"), right)
}

pub fn canonical_opencode_session_id(native: Option<&str>) -> Option<String> {
    let native = native?;
    if native.is_empty() {
        return None;
    }
    if native.starts_with("opencode:") {
        return Some(native.to_string());
    }
    canonical_session_id(OPENCODE_HARNESS_ID, Some(native))
}

#[derive(Clone)]
pub struct OpencodeExecutor {
    pub binary: String,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
    pub opencode_home: Option<String>,
    pub kill_grace: Duration,
    pub env: Arc<dyn Env>,
    pub history: Option<Arc<HistorySource>>,
}

impl OpencodeExecutor {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            model_id: None,
            effort: None,
            cwd: None,
            opencode_home: None,
            kill_grace: Duration::from_millis(KILL_GRACE_MS),
            env: Arc::new(ProcessEnv),
            history: None,
        }
    }
}

impl HarnessExecutor for OpencodeExecutor {
    fn name(&self) -> &str {
        OPENCODE_HARNESS_ID
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
                .opencode_home
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| opencode_home(cfg.env.as_ref()));
            let home = effective_opencode_home(&home);
            let result =
                drive(
                    spec,
                    parts_for_task,
                    DrivePlan {
                        harness: "opencode".to_string(),
                        prefix: OPENCODE_HARNESS_ID.to_string(),
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
                        async move {
                            run_opencode_spawn(cfg, call, cwd, home, active, killed, events).await
                        }
                    },
                )
                .await;
            publish(&parts, result);
        });
        handle
    }
}

async fn run_opencode_spawn(
    cfg: OpencodeExecutor,
    call: TurnCall,
    cwd: String,
    home: PathBuf,
    active: KillSlot,
    killed: Arc<std::sync::atomic::AtomicBool>,
    events: crate::model::EventQueue,
) -> SpawnOutcome {
    let mut spawned = match spawn_opencode(&cfg, &call, &cwd).await {
        Ok(spawned) => spawned,
        Err(error) => return SpawnOutcome::failure(error),
    };
    *active.lock() = Some(spawned.share_kill());
    if killed.load(Ordering::SeqCst) {
        spawned.kill();
    }
    let mut text = String::new();
    let mut session_id: Option<String> = None;
    let mut stream_input = 0.0;
    let mut stream_output = 0.0;
    let mut stream_records = 0u32;
    let mut tool_names: HashMap<String, String> = HashMap::new();
    while let Some(line) = spawned.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(ev) = parse_opencode_event(&value) else {
            continue;
        };
        if ev.session_id.is_some() {
            session_id = ev.session_id.clone();
        }
        if ev.kind == "text" && !ev.text.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&ev.text);
            events.push(den_message(&ev.text));
            continue;
        }
        if ev.kind == "tool-start" && ev.tool.is_some() {
            if let (Some(id), Some(tool)) = (&ev.tool_call_id, &ev.tool) {
                tool_names.insert(id.clone(), tool.clone());
            }
            if let Some(tool) = &ev.tool {
                events.push(den_tool_start(tool));
            }
            continue;
        }
        if ev.kind == "tool-end" {
            let name = ev
                .tool_call_id
                .as_ref()
                .and_then(|id| tool_names.get(id).cloned())
                .or_else(|| ev.tool.clone());
            if let (Some(id), Some(tool)) = (&ev.tool_call_id, &ev.tool)
                && !tool_names.contains_key(id)
            {
                tool_names.insert(id.clone(), tool.clone());
                events.push(den_tool_start(tool));
            }
            events.push(den_tool_end(name));
            continue;
        }
        if ev.kind == "usage" && ev.has_usage {
            stream_input += ev.input_tokens;
            stream_output += ev.output_tokens;
            stream_records += 1;
            continue;
        }
        if ev.kind == "error" && ev.error.is_some() {
            events.push(log_event(
                "warn",
                format!("opencode: {}", ev.error.unwrap_or_default()),
            ));
        }
    }
    let code = spawned.wait_exit().await;
    let stderr = spawned.stderr_text();
    *active.lock() = None;
    spawned.kill();
    let mut error = None;
    if code != Some(0) && !killed.load(Ordering::SeqCst) {
        error = Some(format!(
            "opencode CLI exited {}: {}",
            exit_label(code),
            stderr_tail(&stderr)
        ));
    }
    if code != Some(0)
        && call.resume_native.is_some()
        && opencode_resume_rejected(&format!("{stderr}\n{text}"))
        && !killed.load(Ordering::SeqCst)
    {
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
    let since = spawned.started_at_ms;
    if session_id.is_none() && call.resume_native.is_none() {
        let home = home.clone();
        let cwd = cwd.clone();
        session_id =
            tokio::task::spawn_blocking(move || newest_opencode_session_after(&home, &cwd, since))
                .await
                .unwrap_or(None);
    }
    if session_id.is_none() {
        session_id = call.resume_native.clone();
    }
    if session_id.is_none() && error.is_none() && !killed.load(Ordering::SeqCst) {
        error = Some("opencode CLI stream ended without a session id".to_string());
    }
    let home_for_disk = home.clone();
    let session_for_disk = session_id.clone();
    let facts = tokio::task::spawn_blocking(move || {
        let Some(session_id) = session_for_disk else {
            return OpencodeTurnFacts::default();
        };
        reconcile_opencode_turn(&home_for_disk, &session_id, since)
    })
    .await
    .unwrap_or_default();
    let (input_tokens, output_tokens) = if facts.usage_records > 0 {
        (facts.input_tokens, facts.output_tokens)
    } else if stream_records > 0 {
        (stream_input, stream_output)
    } else {
        tracing::warn!("task.usage.unreconciled");
        (0.0, 0.0)
    };
    let _ = call.message.len();
    SpawnOutcome {
        text,
        native_id: session_id,
        error,
        resume_rejected: false,
        input_tokens,
        output_tokens,
        cost_usd: None,
    }
}

async fn spawn_opencode(
    cfg: &OpencodeExecutor,
    call: &TurnCall,
    cwd: &str,
) -> Result<crate::spawn::Spawned, String> {
    let effort = call.effort.clone().or_else(|| cfg.effort.clone());
    let model = call.model.clone().or_else(|| cfg.model_id.clone());
    let args = build_opencode_args(
        &OpencodeFlags {
            model_id: model,
            resume_session_id: call.resume_native.clone(),
            effort,
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
    if let Some(home) = &cfg.opencode_home {
        overrides.push((
            "XDG_DATA_HOME".to_string(),
            Some(xdg_data_home_for(Path::new(home)).display().to_string()),
        ));
    }
    let env = build_opencode_child_env(cfg.env.as_ref(), &overrides);
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
