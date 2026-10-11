use parking_lot::Mutex;
use std::collections::HashSet;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use crate::{HttpExchange, iso_now, system_hostname, unix_ms_now};
use protocol::host::Env;
use protocol::js::{JsString, JsValue};
use serde_json::{Map, Value};
use tokio::sync::Notify;

use crate::transcript::{
    HookEventOptions, HookEventResult, IngestOptions, IngestResult, ingest_hook_event,
    ingest_transcript, resolve_hook_event_id, resolve_task_context,
};

pub const DEFAULT_WORKER_DEADLINE_MS: u64 = 120_000;
pub const DEFAULT_SPOOL_MAX_ATTEMPTS: u64 = 5;
pub const MAX_SWEEP_FILES: usize = 20;
pub const CAPTURE_EVENTS: [&str; 5] = [
    "Stop",
    "SubagentStop",
    "SessionEnd",
    "UserPromptSubmit",
    "PostToolUse",
];
pub const HOOK_MARKER_LEGACY: &str = "claude-cli/dist/hooks.js";
pub const HOOK_MARKER_RUST: &str = "capture hook --harness claude-code";

const PAYLOAD_EVENTS: [&str; 2] = ["UserPromptSubmit", "PostToolUse"];
const STDIN_TIMEOUT: Duration = Duration::from_secs(30);

pub type HookIngestFn = Arc<
    dyn Fn(
            HookEventOptions,
        )
            -> Pin<Box<dyn std::future::Future<Output = Result<HookEventResult, String>> + Send>>
        + Send
        + Sync,
>;

pub type TranscriptIngestFn = Arc<
    dyn Fn(
            IngestOptions,
        )
            -> Pin<Box<dyn std::future::Future<Output = Result<IngestResult, String>> + Send>>
        + Send
        + Sync,
>;

pub struct DeadlineHandle {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl DeadlineHandle {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }
}

pub struct DeadlineOptions {
    pub ms: u64,
    pub exit: Arc<dyn Fn(i32) + Send + Sync>,
    pub close: Arc<dyn Fn() + Send + Sync>,
    pub log: crate::LogFn,
}

#[derive(Clone)]
pub struct WorkerDeps {
    pub ingest_hook: Option<HookIngestFn>,
    pub ingest_transcript: Option<TranscriptIngestFn>,
    pub spool_dir: Option<PathBuf>,
    pub deadline_ms: Option<u64>,
    pub max_attempts: Option<u64>,
    pub now_ms: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub skip_files: Arc<Mutex<HashSet<String>>>,
    pub log: Option<crate::LogFn>,
    pub env: Option<Arc<dyn protocol::host::Env + Send + Sync>>,
    pub exchange: Option<HttpExchange>,
    pub capture_spool_dir: Option<PathBuf>,
    pub poll_ms: Option<u64>,
    pub poll_for_ms: Option<u64>,
}

impl Default for WorkerDeps {
    fn default() -> Self {
        Self {
            ingest_hook: None,
            ingest_transcript: None,
            spool_dir: None,
            deadline_ms: None,
            max_attempts: None,
            now_ms: None,
            skip_files: Arc::new(Mutex::new(HashSet::new())),
            log: None,
            env: None,
            exchange: None,
            capture_spool_dir: None,
            poll_ms: None,
            poll_for_ms: None,
        }
    }
}

pub fn arm_worker_deadline(opts: DeadlineOptions) -> DeadlineHandle {
    let flag = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());
    let flag_task = flag.clone();
    let notify_task = notify.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(opts.ms)) => {}
            _ = notify_task.notified() => return,
        }
        if flag_task.swap(true, Ordering::SeqCst) {
            return;
        }
        let line = format!(
            "worker: deadline exceeded ({}ms) — closing clients and exiting",
            opts.ms
        );
        let log = opts.log.clone();
        let _ = tokio::task::spawn_blocking(move || log(&line)).await;
        (opts.close)();
        (opts.exit)(1);
    });
    DeadlineHandle { flag, notify }
}

pub(crate) const HOMEDIR_MISSING: &str = "ENOENT: no such file or directory, uv_os_homedir";

pub(crate) fn require_home(home: Option<String>) -> Result<(), String> {
    joined_home(home, &[]).map(|_| ())
}

fn joined_home(home: Option<String>, parts: &[&str]) -> Result<PathBuf, String> {
    let Some(home) = home else {
        return Err(HOMEDIR_MISSING.to_string());
    };
    let mut path = PathBuf::from(home);
    for part in parts {
        path.push(part);
    }
    Ok(path)
}

pub fn log_path(env: &dyn protocol::host::Env) -> Result<PathBuf, String> {
    joined_home(
        protocol::host::home_dir(env),
        &[".rivetos", "claude-capture.log"],
    )
}

pub fn settings_path(env: &dyn protocol::host::Env) -> Result<PathBuf, String> {
    joined_home(protocol::host::home_dir(env), &[".claude", "settings.json"])
}

pub fn spool_dir(env: &dyn protocol::host::Env) -> PathBuf {
    let base = env
        .var("RIVETOS_CLAUDE_HOOK_SPOOL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("rivetos-claude-hook"));
    match env.var("RIVETOS_USER_ID").filter(|value| !value.is_empty()) {
        Some(user_id) => {
            let encoded = protocol::digest::sha256_hex(user_id.as_bytes());
            let hash: String = encoded.chars().take(32).collect();
            PathBuf::from(format!("{}-user-{hash}", base.display()))
        }
        None => base,
    }
}

pub fn worker_deadline_ms(env: &dyn protocol::host::Env) -> u64 {
    positive_number(
        env.var("RIVETOS_HOOK_WORKER_DEADLINE_MS").as_deref(),
        DEFAULT_WORKER_DEADLINE_MS,
    )
}

pub fn spool_max_attempts(env: &dyn protocol::host::Env) -> u64 {
    let value = positive_number(
        env.var("RIVETOS_HOOK_SPOOL_MAX_ATTEMPTS").as_deref(),
        DEFAULT_SPOOL_MAX_ATTEMPTS,
    );
    if value == 0 {
        DEFAULT_SPOOL_MAX_ATTEMPTS
    } else {
        value
    }
}

pub fn spool_attempt(path: &Path) -> u64 {
    let name = strip_claim_name(&file_name(path));
    let Some(index) = attempt_suffix_start(&name) else {
        return 1;
    };
    name[index + 2..name.len() - ".json".len()]
        .parse()
        .unwrap_or(1)
}

pub fn with_spool_attempt(path: &Path, attempt: u64) -> PathBuf {
    let name = strip_claim_name(&file_name(path));
    let stem = strip_attempt_suffix(&name);
    path.parent()
        .unwrap_or(Path::new(""))
        .join(format!("{stem}.a{attempt}.json"))
}

pub fn spool_stem(path: &Path) -> String {
    let name = strip_claim_name(&file_name(path));
    strip_attempt_suffix(&name)
}

pub fn claim_spool(path: &Path) -> Option<PathBuf> {
    let name = file_name(path);
    if claim_suffix_start(&name).is_some() {
        return Some(path.to_path_buf());
    }
    let dest = path.with_file_name(format!(
        "{name}.claim.{}.{}",
        std::process::id(),
        claim_token()
    ));
    std::fs::rename(path, &dest).ok()?;
    Some(dest)
}

pub fn write_spool_payload(payload: &Value, dir: &Path) -> std::io::Result<PathBuf> {
    write_spool_js(&protocol::js::from_serde(payload), dir)
}

fn write_spool_js(payload: &JsValue, dir: &Path) -> std::io::Result<PathBuf> {
    ensure_private_dir(dir)?;
    let body = protocol::js::stringify(payload);
    let mut last = std::io::Error::other("spool name was not created");
    for _ in 0..8u32 {
        let token = base36_token();
        let file = dir.join(format!("{}-{token}.a1.json", unix_ms_now().max(0)));
        match write_exclusive(&file, body.as_bytes()) {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last = error;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

pub async fn ingest_spool_file(spool_file: &Path, deps: &WorkerDeps) -> Result<(), String> {
    let source = spool_file.to_path_buf();
    let claimed = spawn_io(move || claim_spool(&source)).await?;
    let Some(claimed) = claimed else {
        emit(
            deps,
            &format!("worker: spool already claimed {}", spool_file.display()),
        )
        .await;
        return Ok(());
    };
    deps.skip_files.lock().insert(display_path(&claimed));
    let claimed_read = claimed.clone();
    let mut payload = match spawn_io(move || std::fs::read_to_string(&claimed_read)).await? {
        Ok(text) => match protocol::js::parse(&text) {
            Ok(value) => value,
            Err(error) => {
                emit(
                    deps,
                    &format!("worker: unreadable spool {}: {error}", claimed.display()),
                )
                .await;
                fail_spool(&claimed, deps).await;
                return Ok(());
            }
        },
        Err(error) => {
            emit(
                deps,
                &format!("worker: unreadable spool {}: {error}", claimed.display()),
            )
            .await;
            fail_spool(&claimed, deps).await;
            return Ok(());
        }
    };
    let stem = spool_stem(&claimed);
    if let Err(error) = dispatch_claimed(&mut payload, &claimed, &stem, deps).await {
        let event = js_str(&payload, "hook_event_name").unwrap_or("unknown");
        let who = js_str(&payload, "session_id")
            .or_else(|| js_str(&payload, "transcript_path"))
            .unwrap_or("?");
        emit(deps, &format!("{event} {who}: INGEST FAILED — {error}")).await;
        fail_spool(&claimed, deps).await;
        return Ok(());
    }
    let claimed_remove = claimed.clone();
    let _ = spawn_io(move || std::fs::remove_file(&claimed_remove)).await;
    Ok(())
}

pub async fn sweep_stale_spools(deps: &WorkerDeps) -> Result<(), String> {
    let dir = deps
        .spool_dir
        .clone()
        .unwrap_or_else(|| spool_dir(deps.env.as_deref().unwrap_or(&crate::ProcessEnv)));
    let now = deps
        .now_ms
        .as_ref()
        .map(|clock| clock())
        .unwrap_or_else(unix_ms_now);
    let stale_after = deps
        .deadline_ms
        .unwrap_or_else(|| worker_deadline_ms(deps.env.as_deref().unwrap_or(&crate::ProcessEnv)));
    let skip = deps.skip_files.lock().clone();
    let listed = dir.clone();
    let paths = spawn_io(move || stale_candidates(&listed, now, stale_after, &skip)).await?;
    for full in paths.into_iter().take(MAX_SWEEP_FILES) {
        emit(
            deps,
            &format!("worker: retrying stale spool {}", full.display()),
        )
        .await;
        ingest_spool_file(&full, deps).await?;
    }
    Ok(())
}

pub async fn run_worker(spool_file: &Path, deps: &WorkerDeps) -> Result<(), String> {
    let mut skip = deps.skip_files.lock().clone();
    skip.insert(display_path(spool_file));
    let mut next = deps.clone();
    next.skip_files = Arc::new(Mutex::new(skip));
    ingest_spool_file(spool_file, &next).await?;
    sweep_stale_spools(&next).await
}

pub async fn run_hook(harness: &str) -> Result<(), String> {
    if harness != "claude-code" {
        emit_process(&format!("hook: unhandled harness {harness}")).await;
        return Ok(());
    }
    let raw = read_stdin().await;
    let mut payload = match protocol::js::parse(&raw) {
        Ok(value) if value.as_object().is_some() => value,
        _ => return Ok(()),
    };
    let session = js_str(&payload, "session_id").filter(|value| !value.is_empty());
    let transcript = js_str(&payload, "transcript_path").filter(|value| !value.is_empty());
    if session.is_none() && transcript.is_none() {
        return Ok(());
    }
    let task = resolve_task_context(&crate::ProcessEnv);
    let herdr_pane = if crate::ProcessEnv.var("HERDR_ENV").as_deref() == Some("1") {
        crate::ProcessEnv
            .var("HERDR_PANE_ID")
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let herdr_workspace = crate::ProcessEnv
        .var("HERDR_WORKSPACE_ID")
        .filter(|value| !value.is_empty());
    let herdr_host = if herdr_pane.is_some() {
        Some(
            tokio::task::spawn_blocking(system_hostname)
                .await
                .unwrap_or_else(|_| "localhost".to_string()),
        )
    } else {
        None
    };
    if let Some(object) = payload.as_object_mut() {
        if let Some(key) = task.session_key_override {
            object.insert(
                JsString::from_text("rivetos_session_key"),
                JsValue::from_text(&key),
            );
        }
        if let Some(task_id) = task.task_id {
            object.insert(
                JsString::from_text("rivetos_task_id"),
                JsValue::from_text(&task_id),
            );
        }
        if let Some(pane) = herdr_pane {
            object.insert(
                JsString::from_text("herdr_pane_id"),
                JsValue::from_text(&pane),
            );
            if let Some(workspace) = herdr_workspace {
                object.insert(
                    JsString::from_text("herdr_workspace_id"),
                    JsValue::from_text(&workspace),
                );
            }
            if let Some(host) = herdr_host {
                object.insert(JsString::from_text("herdr_host"), JsValue::from_text(&host));
            }
        }
    }
    let dir = spool_dir(&crate::ProcessEnv);
    let payload_for_disk = payload.clone();
    let spool_file = match spawn_io(move || write_spool_js(&payload_for_disk, &dir)).await? {
        Ok(path) => path,
        Err(error) => {
            emit_process(&format!("hook spool failed: {error}")).await;
            return Ok(());
        }
    };
    let detached = spool_file.clone();
    if let Err(error) = spawn_io(move || detach_worker(&detached)).await? {
        emit_process(&format!("hook spool failed: {error}")).await;
    }
    Ok(())
}

pub async fn run_replay(file: Option<PathBuf>) -> Result<(), String> {
    let ms = worker_deadline_ms(&crate::ProcessEnv);
    let handle = arm_worker_deadline(DeadlineOptions {
        ms,
        exit: Arc::new(|code| std::process::exit(code)),
        close: Arc::new(|| {}),
        log: Arc::new(append_log_sync),
    });
    let deps = WorkerDeps::default();
    let result = if let Some(file) = file {
        run_worker(&file, &deps).await
    } else {
        sweep_stale_spools(&deps).await
    };
    handle.cancel();
    result
}

pub fn hook_command(exe: &Path) -> String {
    format!(
        "{} capture hook --harness claude-code",
        serde_json::to_string(&exe.display().to_string()).unwrap_or_else(|_| "\"\"".to_string())
    )
}

pub fn status_text(settings: &Path) -> Result<String, String> {
    let hooks = read_hooks(settings)?;
    let mut installed = 0usize;
    let mut lines = Vec::new();
    for event in CAPTURE_EVENTS {
        let has = hooks.get(event).is_some_and(entries_have_marker);
        if has {
            installed += 1;
        }
        let state = if has { "installed" } else { "not installed" };
        lines.push(format!("  {event}: {state}"));
    }
    lines.push(if installed == CAPTURE_EVENTS.len() {
        "Capture hooks active.".to_string()
    } else {
        "Capture incomplete.".to_string()
    });
    Ok(lines.join("\n"))
}

pub fn install_hooks(settings: &Path, command: &str, log: &Path) -> Result<String, String> {
    let mut root = read_settings(settings)?;
    let mut hooks = hooks_object(&root);
    for event in CAPTURE_EVENTS {
        let mut cleaned = strip_ours(hooks.get(event));
        cleaned.push(matcher(command));
        hooks.insert((*event).to_string(), Value::Array(cleaned));
    }
    root.insert("hooks".to_string(), Value::Object(hooks));
    write_settings(settings, &Value::Object(root))?;
    Ok(format!(
        "Installed RivetOS capture hooks for: {}\n  settings: {}\n  command:  {command}\n  log:      {}",
        CAPTURE_EVENTS.join(", "),
        settings.display(),
        log.display()
    ))
}

pub fn uninstall_hooks(settings: &Path) -> Result<String, String> {
    let mut root = read_settings(settings)?;
    let Some(existing) = root.get("hooks").cloned() else {
        return Ok("No hooks configured — nothing to remove.".to_string());
    };
    let mut hooks = match existing {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if root.get("hooks").is_none() {
        return Ok("No hooks configured — nothing to remove.".to_string());
    }
    for event in CAPTURE_EVENTS {
        let cleaned = strip_ours(hooks.get(event));
        if cleaned.is_empty() {
            hooks.remove(event);
        } else {
            hooks.insert((*event).to_string(), Value::Array(cleaned));
        }
    }
    if hooks.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".to_string(), Value::Object(hooks));
    }
    write_settings(settings, &Value::Object(root))?;
    Ok("Removed RivetOS capture hooks.".to_string())
}

pub fn is_direct_cli(argv1: Option<&Path>, self_path: &Path) -> bool {
    let Some(argv1) = argv1 else {
        return false;
    };
    match (
        std::fs::canonicalize(argv1),
        std::fs::canonicalize(self_path),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => literal_path(argv1) == literal_path(self_path),
    }
}

pub fn log_fatal(message: &str) {
    let line = format!("fatal: {message}");
    append_log_sync(&line);
    tracing::error!("{line}");
}

async fn dispatch_claimed(
    payload: &mut JsValue,
    claimed: &Path,
    stem: &str,
    deps: &WorkerDeps,
) -> Result<(), String> {
    stamp_event_id(payload, claimed, stem, deps).await?;
    if deps.ingest_hook.is_none() && deps.ingest_transcript.is_none() {
        let transport = crate::transcript::select_transport_async(deps.env.clone(), None).await;
        match &transport {
            crate::CaptureTransport::None { reason } => {
                return Err(format!("capture transport unavailable: {reason}"));
            }
            crate::CaptureTransport::Den { warnings, .. } => {
                if let Some(warnings) = warnings {
                    for warning in warnings {
                        emit(deps, warning).await;
                    }
                }
            }
            crate::CaptureTransport::Pg { .. } => {}
        }
    }
    let event = js_str(payload, "hook_event_name").unwrap_or("unknown");
    if PAYLOAD_EVENTS.contains(&event) {
        let result = call_hook(payload, stem, deps).await?;
        if let Some(skipped) = &result.skipped {
            emit(
                deps,
                &format!("{} {}: skipped ({skipped})", event, result.session_key),
            )
            .await;
        } else {
            let verb = if result.created { "created" } else { "updated" };
            emit(
                deps,
                &format!(
                    "{} {}: {verb} conv {} — +{} msg",
                    event, result.session_key, result.conversation_id, result.inserted
                ),
            )
            .await;
        }
        return Ok(());
    }
    let Some(transcript) = js_str(payload, "transcript_path").filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let result = call_transcript(payload, transcript, event, deps).await?;
    if let Some(skipped) = &result.skipped {
        emit(
            deps,
            &format!("{event} {}: skipped ({skipped})", result.session_key),
        )
        .await;
    } else {
        let verb = if result.created { "created" } else { "updated" };
        emit(
            deps,
            &format!(
                "{event} {}: {verb} conv {} — +{} msg (had {})",
                result.session_key, result.conversation_id, result.inserted, result.already_stored
            ),
        )
        .await;
    }
    Ok(())
}

async fn stamp_event_id(
    payload: &mut JsValue,
    claimed: &Path,
    stem: &str,
    deps: &WorkerDeps,
) -> Result<(), String> {
    let event = js_str(payload, "hook_event_name").unwrap_or("");
    if !PAYLOAD_EVENTS.contains(&event) {
        return Ok(());
    }
    if js_str(payload, "rivetos_event_id").is_some_and(|value| !value.is_empty()) {
        return Ok(());
    }
    let options = hook_options(payload, stem, deps);
    let resolved = resolve_hook_event_id(&options).await;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            JsString::from_text("rivetos_event_id"),
            JsValue::String(resolved.event_id),
        );
    }
    let text = protocol::js::stringify(payload);
    let path = claimed.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::write(path, text))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn hook_options(payload: &JsValue, stem: &str, deps: &WorkerDeps) -> HookEventOptions {
    let mut options = HookEventOptions::from_js(payload.clone());
    options.session_key_override = js_str(payload, "rivetos_session_key")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    options.task_id = js_str(payload, "rivetos_task_id")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    options.herdr = herdr_from(payload);
    options.env = deps.env.clone();
    options.exchange = deps.exchange.clone();
    options.spool_dir = deps.capture_spool_dir.clone();
    options.idempotency_key = Some(stem.to_string());
    options.poll_ms = deps.poll_ms;
    options.poll_for_ms = deps.poll_for_ms;
    options
}

fn herdr_from(payload: &JsValue) -> Option<crate::transcript::HerdrPane> {
    let pane = js_str(payload, "herdr_pane_id").filter(|value| !value.is_empty())?;
    Some(crate::transcript::HerdrPane {
        pane_id: pane.to_string(),
        workspace_id: js_str(payload, "herdr_workspace_id")
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        host: js_str(payload, "herdr_host")
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

fn js_str<'a>(value: &'a JsValue, key: &str) -> Option<&'a str> {
    value.get(key).and_then(JsValue::as_str)
}

async fn call_hook(
    payload: &JsValue,
    stem: &str,
    deps: &WorkerDeps,
) -> Result<HookEventResult, String> {
    let session_key = js_str(payload, "rivetos_session_key")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if session_key
        .as_deref()
        .is_some_and(|key| key.starts_with(crate::transcript::LEGACY_TASK_KEY_PREFIX))
    {
        emit(
            deps,
            &format!(
                "DEPRECATED RIVETOS_SESSION_KEY={key} — task spawns should set RIVETOS_TASK_ID and let capture write the canonical session key; honoring the override for this ingest",
                key = session_key.as_deref().unwrap_or("")
            ),
        )
        .await;
    }
    let options = hook_options(payload, stem, deps);
    if let Some(ingest) = &deps.ingest_hook {
        return ingest(options).await;
    }
    ingest_hook_event(options).await
}

async fn call_transcript(
    payload: &JsValue,
    transcript: &str,
    event: &str,
    deps: &WorkerDeps,
) -> Result<IngestResult, String> {
    let session_key = js_str(payload, "rivetos_session_key")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if session_key
        .as_deref()
        .is_some_and(|key| key.starts_with(crate::transcript::LEGACY_TASK_KEY_PREFIX))
    {
        emit(
            deps,
            &format!(
                "DEPRECATED RIVETOS_SESSION_KEY={key} — task spawns should set RIVETOS_TASK_ID and let capture write the canonical session key; honoring the override for this ingest",
                key = session_key.as_deref().unwrap_or("")
            ),
        )
        .await;
    }
    let mut options = IngestOptions::new(PathBuf::from(transcript));
    options.session_id = js_str(payload, "session_id")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    options.session_key_override = session_key;
    options.task_id = js_str(payload, "rivetos_task_id")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    options.mark_inactive = event == "SessionEnd";
    options.event = Some(event.to_string());
    options.herdr = herdr_from(payload);
    options.env = deps.env.clone();
    options.exchange = deps.exchange.clone();
    options.spool_dir = deps.capture_spool_dir.clone();
    if let Some(ingest) = &deps.ingest_transcript {
        return ingest(options).await;
    }
    ingest_transcript(options).await
}

async fn fail_spool(spool_file: &Path, deps: &WorkerDeps) {
    let max = deps
        .max_attempts
        .unwrap_or_else(|| spool_max_attempts(deps.env.as_deref().unwrap_or(&crate::ProcessEnv)));
    let attempt = spool_attempt(spool_file);
    if attempt >= max {
        emit(
            deps,
            &format!(
                "worker: dropping poison spool {} after {attempt} attempts",
                spool_file.display()
            ),
        )
        .await;
        let path = spool_file.to_path_buf();
        let _ = spawn_io(move || std::fs::remove_file(path)).await;
        return;
    }
    let next = with_spool_attempt(spool_file, attempt + 1);
    let source = spool_file.to_path_buf();
    let renamed = spawn_io(move || std::fs::rename(source, next)).await;
    if let Err(error) = renamed.and_then(|result| result.map_err(|error| error.to_string())) {
        emit(
            deps,
            &format!(
                "worker: failed to retain spool {}: {error}",
                spool_file.display()
            ),
        )
        .await;
    }
}

async fn emit(deps: &WorkerDeps, message: &str) {
    if let Some(log) = &deps.log {
        log(message);
        return;
    }
    let owned = message.to_string();
    let _ = tokio::task::spawn_blocking(move || append_log_sync(&owned)).await;
    tracing::error!("{message}");
}

async fn emit_process(message: &str) {
    let owned = message.to_string();
    let _ = tokio::task::spawn_blocking(move || append_log_sync(&owned)).await;
    tracing::error!("{message}");
}

fn append_log_sync(message: &str) {
    let Ok(path) = log_path(&crate::ProcessEnv) else {
        return;
    };
    let line = format!("{} {message}\n", iso_now());
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

fn detach_worker(file: &Path) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut command = std::process::Command::new(exe);
    command
        .args(["capture", "replay", "--file"])
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.process_group(0);
    let _child = command.spawn()?;
    Ok(())
}

async fn read_stdin() -> String {
    tokio::task::spawn_blocking(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf);
            let _ = tx.send(buf);
        });
        rx.recv_timeout(STDIN_TIMEOUT).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

fn positive_number(raw: Option<&str>, default: u64) -> u64 {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return default;
    };
    let Ok(value) = protocol::js::js_trim(raw).parse::<f64>() else {
        return default;
    };
    if !value.is_finite() || value <= 0.0 {
        return default;
    }
    if value >= u64::MAX as f64 {
        return u64::MAX;
    }
    let floored = value.floor() as u64;
    if floored == 0 { default } else { floored }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string()
}

fn strip_claim_name(name: &str) -> String {
    let Some(index) = claim_suffix_start(name) else {
        return name.to_string();
    };
    name[..index].to_string()
}

fn claim_suffix_start(name: &str) -> Option<usize> {
    let lower = name.to_ascii_lowercase();
    let index = lower.rfind(".claim.")?;
    let rest = &name[index + ".claim.".len()..];
    let (pid, token) = rest.split_once('.')?;
    if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    Some(index)
}

fn attempt_suffix_start(name: &str) -> Option<usize> {
    let lower = name.to_ascii_lowercase();
    let index = lower.rfind(".a")?;
    let rest = &lower[index + 2..];
    let digits = rest.strip_suffix(".json")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(index)
}

fn strip_attempt_suffix(name: &str) -> String {
    if let Some(index) = attempt_suffix_start(name) {
        return name[..index].to_string();
    }
    let lower = name.to_ascii_lowercase();
    if let Some(stripped) = lower.strip_suffix(".json") {
        return name[..stripped.len()].to_string();
    }
    name.to_string()
}

fn is_spool_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".json") || claim_suffix_start(name).is_some()
}

fn base36_token() -> String {
    let mut bytes = [0u8; 8];
    let opened = std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes));
    let mut value = if opened.is_ok() {
        u64::from_le_bytes(bytes)
    } else {
        u64::from(std::process::id())
    };
    let alphabet = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = [b'0'; 6];
    for slot in (0..6).rev() {
        let index = usize::try_from(value % 36).unwrap_or(0);
        out[slot] = alphabet[index];
        value /= 36;
    }
    String::from_utf8(out.to_vec()).unwrap_or_else(|_| "000000".to_string())
}

fn ensure_private_dir(path: &Path) -> std::io::Result<()> {
    if path.as_os_str().is_empty() || std::fs::metadata(path).is_ok() {
        return Ok(());
    }
    let mut missing = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        if cursor.as_os_str().is_empty() {
            break;
        }
        if std::fs::metadata(&cursor).is_ok() {
            break;
        }
        missing.push(cursor.clone());
        match cursor.parent() {
            Some(parent) if parent != cursor.as_path() => cursor = parent.to_path_buf(),
            _ => break,
        }
    }
    for dir in missing.iter().rev() {
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(dir) {
            Ok(()) => {
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn claim_token() -> String {
    let mut bytes = [0u8; 4];
    let opened = std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes));
    if opened.is_ok() {
        hex::encode(bytes)
    } else {
        format!("{:x}", std::process::id())
    }
}

fn write_exclusive(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(body)?;
    file.sync_all()?;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(())
}

async fn spawn_io<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())
}

fn stale_candidates(
    dir: &Path,
    now: i64,
    stale_after: u64,
    skip: &HashSet<String>,
) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_spool_name(&name) {
            continue;
        }
        let full = dir.join(name);
        if skip.contains(&display_path(&full)) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(duration) = modified.duration_since(UNIX_EPOCH) else {
            continue;
        };
        let Ok(mtime) = i64::try_from(duration.as_millis()) else {
            continue;
        };
        if is_stale(now, mtime, stale_after) {
            paths.push(full);
        }
    }
    paths
}

fn display_path(path: &Path) -> String {
    path.display().to_string()
}

fn is_stale(now: i64, mtime: i64, stale_after: u64) -> bool {
    i128::from(now) - i128::from(mtime) >= i128::from(stale_after)
}

fn js_to_json(value: &JsValue) -> Value {
    match value {
        JsValue::Null => Value::Null,
        JsValue::Bool(flag) => Value::Bool(*flag),
        JsValue::Number(number) => {
            if number.is_finite() {
                serde_json::Number::from_f64(*number)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        }
        JsValue::String(text) => Value::String(text.to_utf8().to_string()),
        JsValue::Array(items) => Value::Array(items.iter().map(js_to_json).collect()),
        JsValue::Object(object) => {
            let mut map = Map::new();
            for (key, child) in object.iter() {
                map.insert(key.to_utf8().to_string(), js_to_json(child));
            }
            Value::Object(map)
        }
    }
}

fn read_settings(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => match protocol::js::parse(&text) {
            Ok(value) => match js_to_json(&value) {
                Value::Object(map) => Ok(map),
                _ => Ok(Map::new()),
            },
            Err(error) => Err(error.to_string()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_hooks(path: &Path) -> Result<Map<String, Value>, String> {
    Ok(hooks_object(&read_settings(path)?))
}

fn hooks_object(root: &Map<String, Value>) -> Map<String, Value> {
    root.get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn write_settings(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    std::fs::write(path, format!("{body}\n")).map_err(|error| error.to_string())
}

fn command_is_ours(command: &str) -> bool {
    command.contains(HOOK_MARKER_LEGACY) || command.contains(HOOK_MARKER_RUST)
}

fn entries_have_marker(entries: &Value) -> bool {
    let Some(entries) = entries.as_array() else {
        return false;
    };
    entries.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| {
                hooks.iter().any(|hook| {
                    hook.get("command")
                        .and_then(Value::as_str)
                        .is_some_and(command_is_ours)
                })
            })
    })
}

fn strip_ours(entries: Option<&Value>) -> Vec<Value> {
    let Some(entries) = entries.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut cleaned = Vec::new();
    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let hooks = object
            .get("hooks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let kept: Vec<Value> = hooks
            .into_iter()
            .filter(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_none_or(|command| !command_is_ours(command))
            })
            .collect();
        if kept.is_empty() {
            continue;
        }
        let mut next = object.clone();
        next.insert("hooks".to_string(), Value::Array(kept));
        cleaned.push(Value::Object(next));
    }
    cleaned
}

fn matcher(command: &str) -> Value {
    let mut hook = Map::new();
    hook.insert("type".to_string(), Value::String("command".to_string()));
    hook.insert("command".to_string(), Value::String(command.to_string()));
    hook.insert("timeout".to_string(), Value::from(10u64));
    let mut entry = Map::new();
    entry.insert("hooks".to_string(), Value::Array(vec![Value::Object(hook)]));
    Value::Object(entry)
}

fn literal_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod home_paths {
    use std::path::PathBuf;

    use protocol::host::MapEnv;

    use super::{HOMEDIR_MISSING, joined_home, log_path, require_home, settings_path};

    #[test]
    fn home_paths_use_the_directory_and_fail_when_it_is_missing() {
        let mut env = MapEnv::new();
        env.set("HOME", "/home/example");
        assert_eq!(
            log_path(&env).unwrap(),
            PathBuf::from("/home/example/.rivetos/claude-capture.log")
        );
        assert_eq!(
            settings_path(&env).unwrap(),
            PathBuf::from("/home/example/.claude/settings.json")
        );
        env.set("HOME", "");
        assert_eq!(
            log_path(&env).unwrap(),
            PathBuf::from(".rivetos/claude-capture.log")
        );
        assert!(require_home(Some(String::new())).is_ok());
        assert_eq!(
            joined_home(None, &[".claude", "settings.json"]).unwrap_err(),
            "ENOENT: no such file or directory, uv_os_homedir"
        );
        assert_eq!(require_home(None).unwrap_err(), HOMEDIR_MISSING);
    }
}
