use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::{
    CaptureError, CaptureRole, CaptureTransport, CaptureUser, CaptureWriterOptions, EventIdParts,
    HttpExchange, OccurrenceCounts, OccurrenceKey, ProcessEnv, UserSource, WriteOutcome,
    content_tuple_hash, create_capture_writer, event_id_from_content, resolve_capture_transport,
    resolve_den_url,
};
use protocol::js::{JsObject, JsString, JsValue};
use serde_json::Value;

pub const CAPTURE_CHANNEL: &str = "claude-code";
pub const LEGACY_TASK_KEY_PREFIX: &str = "task:";
pub const IDLE_IN_TRANSACTION_TIMEOUT: &str = "30s";
pub const IDLE_IN_TRANSACTION_TIMEOUT_MS: u64 = 30_000;
pub const STATEMENT_TIMEOUT: &str = "60s";
pub const STATEMENT_TIMEOUT_MS: u64 = 60_000;
pub const SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL: &str =
    "SET idle_in_transaction_session_timeout = '30s'";
pub const SET_STATEMENT_TIMEOUT_SQL: &str = "SET statement_timeout = '60s'";

const HOOK_TRANSCRIPT_POLL_MS: u64 = 100;
const HOOK_TRANSCRIPT_POLL_FOR_MS: u64 = 2_000;
const TITLE_LIMIT: usize = 120;

pub struct CapturePoolOptions {
    pub idle_in_transaction_session_timeout: u64,
    pub statement_timeout: u64,
}

pub fn create_capture_pool(_connection: &str) -> CapturePoolOptions {
    CapturePoolOptions {
        idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
        statement_timeout: STATEMENT_TIMEOUT_MS,
    }
}

pub fn apply_capture_guards() -> [&'static str; 2] {
    [
        SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
        SET_STATEMENT_TIMEOUT_SQL,
    ]
}

pub fn capture_agent(env: &dyn protocol::host::Env) -> String {
    match env.var("RIVETOS_CAPTURE_AGENT") {
        Some(value) if !value.is_empty() => value,
        _ => "rivet-claude".to_string(),
    }
}

pub struct ToolUse {
    pub name: String,
    pub input: Option<JsValue>,
    pub id: Option<String>,
    pub result: Option<String>,
    pub result_line: Option<usize>,
    name_units: JsString,
    id_units: Option<JsString>,
    result_units: Option<JsString>,
}

pub struct ParsedMessage {
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<JsValue>,
    pub tool_result: Option<String>,
    pub ts: Option<String>,
    pub uuid: Option<String>,
    pub sidechain: bool,
    pub line_index: usize,
    pub tools: Vec<ToolUse>,
    content_units: JsString,
    uuid_units: Option<JsString>,
}

pub struct ParsedTranscript {
    pub file: String,
    pub session_id: Option<String>,
    pub ai_title: Option<String>,
    pub pr_url: Option<String>,
    pub cwd: Option<String>,
    pub msgs: Vec<ParsedMessage>,
    ai_title_units: Option<JsString>,
    pr_url_units: Option<JsString>,
    cwd_units: Option<JsString>,
    session_id_units: Option<JsString>,
}

pub struct HerdrPane {
    pub pane_id: String,
    pub workspace_id: Option<String>,
    pub host: Option<String>,
}

pub struct IngestResult {
    pub session_key: String,
    pub conversation_id: String,
    pub created: bool,
    pub inserted: u64,
    pub already_stored: u64,
    pub skipped: Option<String>,
}

pub struct HookEventResult {
    pub session_key: String,
    pub conversation_id: String,
    pub created: bool,
    pub inserted: u64,
    pub skipped: Option<String>,
}

pub struct IngestOptions {
    pub transcript_path: PathBuf,
    pub session_id: Option<String>,
    pub session_key_override: Option<String>,
    pub task_id: Option<String>,
    pub pg_url: Option<String>,
    pub mark_inactive: bool,
    pub event: Option<String>,
    pub herdr: Option<HerdrPane>,
    pub env: Option<Arc<dyn protocol::host::Env + Send + Sync>>,
    pub exchange: Option<HttpExchange>,
    pub spool_dir: Option<PathBuf>,
    pub now_iso: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

impl IngestOptions {
    pub fn new(transcript_path: impl Into<PathBuf>) -> Self {
        Self {
            transcript_path: transcript_path.into(),
            session_id: None,
            session_key_override: None,
            task_id: None,
            pg_url: None,
            mark_inactive: false,
            event: None,
            herdr: None,
            env: None,
            exchange: None,
            spool_dir: None,
            now_iso: None,
        }
    }
}

pub struct HookEventOptions {
    pub payload: JsValue,
    pub session_key_override: Option<String>,
    pub task_id: Option<String>,
    pub pg_url: Option<String>,
    pub herdr: Option<HerdrPane>,
    pub env: Option<Arc<dyn protocol::host::Env + Send + Sync>>,
    pub exchange: Option<HttpExchange>,
    pub spool_dir: Option<PathBuf>,
    pub idempotency_key: Option<String>,
    pub poll_ms: Option<u64>,
    pub poll_for_ms: Option<u64>,
    pub now_iso: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

impl HookEventOptions {
    pub fn new(payload: Value) -> Self {
        Self::from_js(protocol::js::from_serde(&payload))
    }

    pub fn from_js(payload: JsValue) -> Self {
        Self {
            payload,
            session_key_override: None,
            task_id: None,
            pg_url: None,
            herdr: None,
            env: None,
            exchange: None,
            spool_dir: None,
            idempotency_key: None,
            poll_ms: None,
            poll_for_ms: None,
            now_iso: None,
        }
    }
}

pub struct ConversationKeyParts<'a> {
    pub override_key: Option<&'a str>,
    pub hook_session_id: Option<&'a str>,
    pub transcript_session_id: Option<&'a str>,
    pub fallback_key: &'a str,
}

pub struct TaskCaptureContext {
    pub session_key_override: Option<String>,
    pub task_id: Option<String>,
    pub legacy_task_key: bool,
}

pub struct ResolvedHookId {
    pub event_id: JsString,
    pub hook_only: bool,
}

struct PostedCounts {
    conversation_id: String,
    inserted: u64,
    skipped: u64,
}

struct ToolCall {
    name_units: JsString,
    input: Option<JsValue>,
    result_units: Option<JsString>,
    result_line: Option<usize>,
    uuid_units: Option<JsString>,
    ts: Option<String>,
    line_index: usize,
}

enum CapturedSlot<'a> {
    Assistant(&'a ParsedMessage),
    Tool(&'a ToolUse),
    User(&'a ParsedMessage),
}

pub fn session_key_from_id(session_id: &str) -> String {
    format!("claude-code:{session_id}")
}

pub fn resolve_conversation_key(parts: ConversationKeyParts<'_>) -> String {
    if let Some(value) = nonempty(parts.override_key) {
        return value.to_string();
    }
    if let Some(value) = nonempty(parts.hook_session_id) {
        return session_key_from_id(value);
    }
    if let Some(value) = nonempty(parts.transcript_session_id) {
        return session_key_from_id(value);
    }
    parts.fallback_key.to_string()
}

pub fn is_task_id(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

pub fn resolve_task_context(env: &dyn protocol::host::Env) -> TaskCaptureContext {
    let override_key = env
        .var("RIVETOS_SESSION_KEY")
        .filter(|value| !value.is_empty());
    let legacy_task_key = override_key
        .as_deref()
        .is_some_and(|value| value.starts_with(LEGACY_TASK_KEY_PREFIX));
    let explicit = env.var("RIVETOS_TASK_ID").filter(|value| !value.is_empty());
    let from_legacy = if legacy_task_key {
        override_key
            .as_deref()
            .and_then(|value| value.strip_prefix(LEGACY_TASK_KEY_PREFIX))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    TaskCaptureContext {
        session_key_override: override_key,
        task_id: explicit.or(from_legacy),
        legacy_task_key,
    }
}

pub fn derive_session_key(transcript_path: &Path, env: &dyn protocol::host::Env) -> String {
    let home = env
        .var("HOME")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/tmp".to_string());
    let root = PathBuf::from(home).join(".claude").join("projects");
    let abs =
        std::path::absolute(transcript_path).unwrap_or_else(|_| transcript_path.to_path_buf());
    let base = match abs.strip_prefix(&root) {
        Ok(relative) => relative.to_string_lossy().into_owned(),
        Err(_) => abs.to_string_lossy().trim_start_matches('/').to_string(),
    };
    let trimmed = base.strip_suffix(".jsonl").unwrap_or(&base);
    format!("claude-code:{trimmed}")
}

pub fn parse_transcript(file: &Path) -> std::io::Result<ParsedTranscript> {
    let text = std::fs::read_to_string(file)?;
    Ok(parse_transcript_text(file, &text))
}

pub(crate) async fn select_transport_async(
    env: Option<Arc<dyn protocol::host::Env + Send + Sync>>,
    pg_url: Option<String>,
) -> CaptureTransport {
    tokio::task::spawn_blocking(move || match &env {
        Some(env) => select_transport(Some(env.as_ref()), pg_url.as_deref()),
        None => select_transport(None, pg_url.as_deref()),
    })
    .await
    .unwrap_or_else(|_| CaptureTransport::None {
        reason: "transport lookup failed".to_string(),
    })
}

pub(crate) fn select_transport(
    env: Option<&dyn protocol::host::Env>,
    pg_url: Option<&str>,
) -> CaptureTransport {
    if let Some(env) = env {
        return resolve_capture_transport(env, || None);
    }
    if let Some(url) = pg_url.filter(|value| !value.is_empty()) {
        return CaptureTransport::Pg {
            pg_url: url.to_string(),
        };
    }
    resolve_capture_transport(&ProcessEnv, crate::default_config_reader)
}

pub async fn resolve_hook_event_id(opts: &HookEventOptions) -> ResolvedHookId {
    if let Some(stored) = js_field(&opts.payload, "rivetos_event_id")
        && !stored.to_utf8().is_empty()
    {
        let view = stored.to_utf8();
        return ResolvedHookId {
            hook_only: view.contains(":hook:") || !view.starts_with("claude-code:"),
            event_id: stored.clone(),
        };
    }
    let session_units = js_field(&opts.payload, "session_id")
        .filter(|value| !value.to_utf8().is_empty())
        .cloned();
    let session_id = session_units
        .as_ref()
        .map(|value| value.to_utf8().to_string());
    let session_key = resolve_conversation_key(ConversationKeyParts {
        override_key: opts.session_key_override.as_deref(),
        hook_session_id: session_id.as_deref(),
        transcript_session_id: None,
        fallback_key: "",
    });
    let session_part = session_units.unwrap_or_else(|| {
        if session_key.is_empty() {
            JsString::from_text("unknown")
        } else {
            JsString::from_text(&session_key)
        }
    });
    let event = field_str(&opts.payload, "hook_event_name").unwrap_or("");
    let key = hook_occurrence_key(&opts.payload);
    if event == "PostToolUse"
        && let Some(tool_id) = js_field(&opts.payload, "tool_use_id")
        && !tool_id.to_utf8().is_empty()
    {
        let prefix: Vec<u16> = "claude-code:".encode_utf16().collect();
        let marker: Vec<u16> = ":tool:".encode_utf16().collect();
        return ResolvedHookId {
            event_id: concat_units(&[
                prefix.as_slice(),
                session_part.units(),
                marker.as_slice(),
                tool_id.units(),
            ]),
            hook_only: false,
        };
    }
    if let Some(path) =
        field_str(&opts.payload, "transcript_path").filter(|value| !value.is_empty())
        && let Some(key) = key.clone()
    {
        let poll_ms = opts.poll_ms.unwrap_or(HOOK_TRANSCRIPT_POLL_MS);
        let poll_for = opts.poll_for_ms.unwrap_or(HOOK_TRANSCRIPT_POLL_FOR_MS);
        let deadline = Instant::now() + Duration::from_millis(poll_for);
        let hint = session_id.as_deref().unwrap_or("");
        loop {
            if let Some(bound) = last_match_async(Path::new(path), &key, hint).await {
                return ResolvedHookId {
                    event_id: bound,
                    hook_only: false,
                };
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(poll_ms)).await;
        }
    }
    if event == "PostToolUse"
        && let Some(key) = &key
    {
        return ResolvedHookId {
            event_id: JsString::from_text(&occ_event_id(
                session_part.to_utf8(),
                &content_tuple_hash(key),
                0,
            )),
            hook_only: false,
        };
    }
    ResolvedHookId {
        event_id: hook_fallback_id(
            session_part.to_utf8(),
            opts.idempotency_key.as_deref(),
            &session_key,
            key.as_ref(),
        ),
        hook_only: true,
    }
}

pub async fn ingest_transcript(opts: IngestOptions) -> Result<IngestResult, String> {
    let env = opts.env.clone();
    let env_ref = env
        .as_ref()
        .map(|item| item.as_ref() as &(dyn protocol::host::Env + Send + Sync));
    let fallback_key = derive_session_key(&opts.transcript_path, env_ref.unwrap_or(&ProcessEnv));
    if !path_is_file(&opts.transcript_path).await {
        return Ok(IngestResult {
            session_key: fallback_key,
            conversation_id: String::new(),
            created: false,
            inserted: 0,
            already_stored: 0,
            skipped: Some("transcript file does not exist".to_string()),
        });
    }
    let parsed = load_transcript(&opts.transcript_path).await?;
    let assistant = assistant_indexes(&parsed);
    let users = user_indexes(&parsed);
    let tools = tool_calls(&parsed);
    if assistant.is_empty() && users.is_empty() && tools.is_empty() {
        return Ok(IngestResult {
            session_key: fallback_key,
            conversation_id: String::new(),
            created: false,
            inserted: 0,
            already_stored: 0,
            skipped: Some("nothing to ingest".to_string()),
        });
    }
    let session_key = resolve_conversation_key(ConversationKeyParts {
        override_key: opts.session_key_override.as_deref(),
        hook_session_id: opts.session_id.as_deref(),
        transcript_session_id: parsed.session_id.as_deref(),
        fallback_key: &fallback_key,
    });
    let transport = select_transport_async(env.clone(), opts.pg_url.clone()).await;
    match transport {
        CaptureTransport::None { reason } => {
            Err(format!("capture transport unavailable: {reason}"))
        }
        CaptureTransport::Pg { .. } => Err("capture postgres pool is not ported".to_string()),
        CaptureTransport::Den { den_url, user, .. } => {
            let session_part = nonempty(opts.session_id.as_deref())
                .map(JsString::from_text)
                .or_else(|| {
                    parsed
                        .session_id_units
                        .clone()
                        .filter(|value| !value.to_utf8().is_empty())
                })
                .unwrap_or_else(|| JsString::from_text("unknown"));
            let ids = den_event_ids(&parsed, &session_part);
            let file = std::path::absolute(&opts.transcript_path)
                .unwrap_or_else(|_| opts.transcript_path.clone());
            let mut messages = Vec::new();
            for (offset, index) in assistant.iter().enumerate() {
                let message = &parsed.msgs[*index];
                let mut metadata = JsObject::new();
                insert_text(&mut metadata, "source", "claude-code-hook");
                insert_opt_units(&mut metadata, "uuid", message.uuid_units.as_ref());
                metadata.insert(js_key("sidechain"), JsValue::Bool(message.sidechain));
                insert_pointer(&mut metadata, &file, message.line_index);
                insert_herdr(&mut metadata, opts.herdr.as_ref());
                messages.push(message_js(
                    ids.assistant.get(offset),
                    CaptureRole::Assistant,
                    &message.content_units,
                    (None, None, None),
                    metadata,
                    parsed_timestamp(message.ts.as_deref(), env_ref.unwrap_or(&ProcessEnv)),
                ));
            }
            for (offset, tool) in tools.iter().enumerate() {
                let mut metadata = JsObject::new();
                insert_text(&mut metadata, "source", "claude-code-hook");
                insert_opt_units(&mut metadata, "uuid", tool.uuid_units.as_ref());
                insert_text(&mut metadata, "hook_event", "PostToolUse");
                metadata.insert(js_key("recovered"), JsValue::Bool(true));
                insert_pointer(
                    &mut metadata,
                    &file,
                    tool.result_line.unwrap_or(tool.line_index),
                );
                insert_herdr(&mut metadata, opts.herdr.as_ref());
                let content = tool_content(&tool.name_units);
                messages.push(message_js(
                    ids.tool.get(offset),
                    CaptureRole::Tool,
                    &content,
                    (
                        Some(&tool.name_units),
                        tool.input.as_ref(),
                        tool.result_units.as_ref(),
                    ),
                    metadata,
                    parsed_timestamp(tool.ts.as_deref(), env_ref.unwrap_or(&ProcessEnv)),
                ));
            }
            for (offset, index) in users.iter().enumerate() {
                let message = &parsed.msgs[*index];
                let mut metadata = JsObject::new();
                insert_text(&mut metadata, "source", "claude-code-hook");
                insert_opt_units(&mut metadata, "uuid", message.uuid_units.as_ref());
                metadata.insert(js_key("recovered"), JsValue::Bool(true));
                insert_pointer(&mut metadata, &file, message.line_index);
                insert_herdr(&mut metadata, opts.herdr.as_ref());
                messages.push(message_js(
                    ids.user.get(offset),
                    CaptureRole::User,
                    &message.content_units,
                    (None, None, None),
                    metadata,
                    parsed_timestamp(message.ts.as_deref(), env_ref.unwrap_or(&ProcessEnv)),
                ));
            }
            let mut settings = JsObject::new();
            insert_text(&mut settings, "source", "claude-code-hook");
            insert_text(
                &mut settings,
                "file",
                &opts.transcript_path.display().to_string(),
            );
            let session_setting = opts
                .session_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(JsString::from_text)
                .or_else(|| parsed.session_id_units.clone());
            insert_opt_units(&mut settings, "session_id", session_setting.as_ref());
            insert_opt_units(&mut settings, "pr_url", parsed.pr_url_units.as_ref());
            if let Some(cwd) = parsed.cwd_units.as_ref() {
                insert_units(&mut settings, "cwd", cwd);
            }
            insert_opt_text(&mut settings, "last_event", opts.event.as_deref());
            insert_text(&mut settings, "last_ingest_at", &clock_stamp(&opts.now_iso));
            let mut batch = JsObject::new();
            let hook_units = opts
                .session_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(JsString::from_text);
            insert_units(
                &mut batch,
                "session_key",
                &wire_session_key(
                    opts.session_key_override.as_deref(),
                    hook_units.as_ref(),
                    parsed.session_id_units.as_ref(),
                    &fallback_key,
                ),
            );
            insert_text(
                &mut batch,
                "agent",
                &capture_agent(env_ref.unwrap_or(&ProcessEnv)),
            );
            insert_text(&mut batch, "channel", CAPTURE_CHANNEL);
            insert_units(&mut batch, "title", &fallback_title_units(&parsed));
            batch.insert(js_key("settings"), JsValue::Object(settings));
            if let Some(task_id) = opts
                .task_id
                .as_deref()
                .filter(|value| is_task_id(Some(value)))
            {
                insert_text(&mut batch, "task_id", task_id);
            }
            if opts.mark_inactive {
                batch.insert(js_key("finalize"), JsValue::Bool(true));
            }
            let count = u64::try_from(messages.len()).unwrap_or(u64::MAX);
            batch.insert(js_key("messages"), JsValue::Array(messages));
            let posted = post_js(
                JsValue::Object(batch),
                count,
                &den_url,
                user,
                opts.env.clone(),
                opts.exchange.clone(),
                opts.spool_dir.clone(),
            )
            .await?;
            Ok(IngestResult {
                session_key,
                conversation_id: posted.conversation_id,
                created: false,
                inserted: posted.inserted,
                already_stored: posted.skipped,
                skipped: None,
            })
        }
    }
}

pub async fn ingest_hook_event(opts: HookEventOptions) -> Result<HookEventResult, String> {
    let event = field_str(&opts.payload, "hook_event_name")
        .unwrap_or("unknown")
        .to_string();
    let session_id = field_str(&opts.payload, "session_id").map(str::to_string);
    let session_key = resolve_conversation_key(ConversationKeyParts {
        override_key: opts.session_key_override.as_deref(),
        hook_session_id: session_id.as_deref(),
        transcript_session_id: None,
        fallback_key: "",
    });
    if session_key.is_empty() {
        return Ok(skipped_hook(String::new(), "no session_id"));
    }
    let (role, content, title, tool_name, tool_args, tool_result) = if event == "UserPromptSubmit" {
        let prompt = js_field(&opts.payload, "prompt")
            .cloned()
            .unwrap_or_else(|| JsString::from_text(""));
        if protocol::js::js_trim(prompt.to_utf8()).is_empty() {
            return Ok(skipped_hook(session_key, "empty prompt"));
        }
        let title = title_limited(prompt.units());
        (CaptureRole::User, prompt, title, None, None, None)
    } else if event == "PostToolUse" {
        let name = js_field(&opts.payload, "tool_name")
            .cloned()
            .unwrap_or_else(|| JsString::from_text("unknown"));
        let raw = match opts.payload.get("tool_response") {
            Some(value) if !value.is_null() => value.clone(),
            _ => opts
                .payload
                .get("tool_result")
                .cloned()
                .unwrap_or(JsValue::Null),
        };
        let result = stringify_result(&raw);
        let args = opts
            .payload
            .get("tool_input")
            .filter(|value| !value.is_null())
            .cloned();
        (
            CaptureRole::Tool,
            tool_content(&name),
            JsString::from_text("Claude Code session"),
            Some(name),
            args,
            result,
        )
    } else {
        return Ok(skipped_hook(
            session_key,
            &format!("unhandled event {event}"),
        ));
    };
    let env = opts.env.clone();
    let env_ref = env
        .as_ref()
        .map(|item| item.as_ref() as &(dyn protocol::host::Env + Send + Sync));
    let transport = select_transport_async(env.clone(), opts.pg_url.clone()).await;
    match transport {
        CaptureTransport::None { reason } => {
            Err(format!("capture transport unavailable: {reason}"))
        }
        CaptureTransport::Pg { .. } => Err("capture postgres pool is not ported".to_string()),
        CaptureTransport::Den { den_url, user, .. } => {
            let resolved = resolve_hook_event_id(&opts).await;
            let mut metadata = JsObject::new();
            let source = if resolved.hook_only {
                "hook-only"
            } else {
                "claude-code-hook"
            };
            insert_text(&mut metadata, "source", source);
            insert_text(&mut metadata, "hook_event", &event);
            if let Some(key) = opts.idempotency_key.clone() {
                insert_text(&mut metadata, "ingest_key", &key);
            }
            insert_herdr(&mut metadata, opts.herdr.as_ref());
            let mut settings = JsObject::new();
            insert_text(&mut settings, "source", "claude-code-hook");
            if let Some(value) = opts.payload.get("session_id") {
                match value {
                    JsValue::String(text) => insert_units(&mut settings, "session_id", text),
                    other => {
                        settings.insert(js_key("session_id"), other.clone());
                    }
                }
            }
            if let Some(cwd) = js_field(&opts.payload, "cwd")
                && !cwd.to_utf8().is_empty()
            {
                insert_units(&mut settings, "cwd", cwd);
            }
            insert_text(&mut settings, "last_event", &event);
            insert_text(&mut settings, "last_ingest_at", &clock_stamp(&opts.now_iso));
            let mut batch = JsObject::new();
            insert_units(
                &mut batch,
                "session_key",
                &wire_session_key(
                    opts.session_key_override.as_deref(),
                    js_field(&opts.payload, "session_id"),
                    None,
                    "",
                ),
            );
            insert_text(
                &mut batch,
                "agent",
                &capture_agent(env_ref.unwrap_or(&ProcessEnv)),
            );
            insert_text(&mut batch, "channel", CAPTURE_CHANNEL);
            insert_units(&mut batch, "title", &title);
            batch.insert(js_key("settings"), JsValue::Object(settings));
            if let Some(task_id) = opts
                .task_id
                .as_deref()
                .filter(|value| is_task_id(Some(value)))
            {
                insert_text(&mut batch, "task_id", task_id);
            }
            batch.insert(
                js_key("messages"),
                JsValue::Array(vec![message_js(
                    Some(&resolved.event_id),
                    role,
                    &content,
                    (tool_name.as_ref(), tool_args.as_ref(), tool_result.as_ref()),
                    metadata,
                    None,
                )]),
            );
            let posted = post_js(
                JsValue::Object(batch),
                1,
                &den_url,
                user,
                opts.env.clone(),
                opts.exchange.clone(),
                opts.spool_dir.clone(),
            )
            .await?;
            Ok(HookEventResult {
                session_key,
                conversation_id: posted.conversation_id,
                created: false,
                inserted: posted.inserted,
                skipped: (posted.inserted == 0).then(|| "duplicate ingest_key".to_string()),
            })
        }
    }
}

fn parse_transcript_text(file: &Path, text: &str) -> ParsedTranscript {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut result_by_id = HashMap::<Vec<u16>, Option<JsString>>::new();
    let mut result_line_by_id = HashMap::<Vec<u16>, usize>::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(object) = parse_object(line) else {
            continue;
        };
        let Some(blocks) = object
            .get("message")
            .and_then(JsValue::as_object)
            .and_then(|message| message.get("content"))
            .and_then(JsValue::as_array)
        else {
            continue;
        };
        for block in blocks {
            let Some(block) = block.as_object() else {
                continue;
            };
            if block.get("type").and_then(JsValue::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("tool_use_id").and_then(JsValue::as_js_string) else {
                continue;
            };
            if id.units().is_empty() {
                continue;
            }
            let rendered = render_block_content(block.get("content"));
            let key = id.units().to_vec();
            result_by_id.insert(key.clone(), rendered);
            result_line_by_id.entry(key).or_insert(index);
        }
    }
    let mut ai_title_units = None;
    let mut session_id_units = None;
    let mut pr_url_units = None;
    let mut cwd_units = None;
    let mut msgs = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(object) = parse_object(line) else {
            continue;
        };
        if cwd_units.is_none()
            && let Some(value) = object.get("cwd").and_then(JsValue::as_js_string)
        {
            let trimmed = JsString::from_units(protocol::js::js_trim_units(value.units()).to_vec());
            if !trimmed.to_utf8().is_empty() {
                cwd_units = Some(trimmed);
            }
        }
        let kind = object.get("type").and_then(JsValue::as_str).unwrap_or("");
        if kind == "ai-title" {
            if let Some(title) = object.get("aiTitle").and_then(JsValue::as_js_string) {
                ai_title_units = Some(title.clone());
            }
            if session_id_units.is_none()
                && let Some(id) = object.get("sessionId").and_then(JsValue::as_js_string)
            {
                session_id_units = Some(id.clone());
            }
            continue;
        }
        if kind == "pr-link" {
            if let Some(url) = object.get("prUrl").and_then(JsValue::as_js_string) {
                pr_url_units = Some(url.clone());
            }
            continue;
        }
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if object.get("isMeta").is_some_and(truthy) {
            continue;
        }
        if session_id_units.is_none()
            && let Some(id) = object.get("sessionId").and_then(JsValue::as_js_string)
        {
            session_id_units = Some(id.clone());
        }
        let message = object.get("message").and_then(JsValue::as_object);
        let role = message
            .and_then(|item| item.get("role"))
            .and_then(JsValue::as_str)
            .unwrap_or(kind)
            .to_string();
        let content_value = message.and_then(|item| item.get("content"));
        let mut text_parts: Vec<JsString> = Vec::new();
        let mut think_parts: Vec<JsString> = Vec::new();
        let mut result_parts: Vec<JsString> = Vec::new();
        let mut tools = Vec::new();
        let mut text_units = JsString::from_text("");
        if let Some(content) = content_value.and_then(JsValue::as_js_string) {
            text_units = content.clone();
        } else if let Some(blocks) = content_value.and_then(JsValue::as_array) {
            for block in blocks {
                let Some(block) = block.as_object() else {
                    continue;
                };
                match block.get("type").and_then(JsValue::as_str) {
                    Some("text") => text_parts.push(
                        block
                            .get("text")
                            .and_then(JsValue::as_js_string)
                            .cloned()
                            .unwrap_or_else(|| JsString::from_text("")),
                    ),
                    Some("thinking") => think_parts.push(
                        block
                            .get("thinking")
                            .and_then(JsValue::as_js_string)
                            .or_else(|| block.get("text").and_then(JsValue::as_js_string))
                            .cloned()
                            .unwrap_or_else(|| JsString::from_text("")),
                    ),
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(JsValue::as_js_string)
                            .filter(|value| !value.units().is_empty())
                            .cloned();
                        let id_key = id.as_ref().map(|value| value.units().to_vec());
                        let name = block
                            .get("name")
                            .and_then(JsValue::as_js_string)
                            .cloned()
                            .unwrap_or_else(|| JsString::from_text("unknown"));
                        tools.push(ToolUse {
                            name: name.to_utf8().to_string(),
                            input: block.get("input").filter(|value| !value.is_null()).cloned(),
                            result: id_key.as_ref().and_then(|id| {
                                result_by_id.get(id).and_then(|value| {
                                    value.as_ref().map(|text| text.to_utf8().to_string())
                                })
                            }),
                            result_line: id_key
                                .as_ref()
                                .and_then(|id| result_line_by_id.get(id).copied()),
                            id: id.as_ref().map(|value| value.to_utf8().to_string()),
                            name_units: name,
                            id_units: id,
                            result_units: id_key
                                .as_ref()
                                .and_then(|id| result_by_id.get(id).cloned().flatten()),
                        });
                    }
                    Some("tool_result") => {
                        result_parts.push(
                            render_block_content(block.get("content"))
                                .unwrap_or_else(|| JsString::from_text("")),
                        );
                    }
                    _ => {}
                }
            }
            text_units = join_trimmed(&text_parts);
            if text_units.to_utf8().is_empty() && !think_parts.is_empty() {
                let mut units: Vec<u16> = "[thinking] ".encode_utf16().collect();
                units.extend_from_slice(join_trimmed(&think_parts).units());
                text_units = JsString::from_units(units);
            }
        }
        let tool_result_units = if result_parts.is_empty() {
            None
        } else {
            Some(join_units(&result_parts, u16::from(b'\n')))
        };
        let (tool_name, tool_args) = if let Some(first) = tools.first() {
            if text_units.to_utf8().is_empty() {
                text_units = join_tool_names(&tools);
            }
            (Some(first.name.clone()), first.input.clone())
        } else {
            (None, None)
        };
        let tool_result_blank = match &tool_result_units {
            None => true,
            Some(value) => value.to_utf8().is_empty(),
        };
        if text_units.to_utf8().is_empty() && tool_result_blank {
            continue;
        }
        if text_units.to_utf8().is_empty()
            && let Some(result) = tool_result_units
                .as_ref()
                .filter(|value| !value.to_utf8().is_empty())
        {
            text_units = result.clone();
        }
        let uuid_units = object.get("uuid").and_then(JsValue::as_js_string).cloned();
        msgs.push(ParsedMessage {
            role,
            content: text_units.to_utf8().to_string(),
            tool_name,
            tool_args,
            tool_result: tool_result_units
                .as_ref()
                .map(|value| value.to_utf8().to_string()),
            ts: object
                .get("timestamp")
                .and_then(JsValue::as_str)
                .map(str::to_string),
            uuid: uuid_units.as_ref().map(|value| value.to_utf8().to_string()),
            sidechain: object.get("isSidechain").is_some_and(truthy),
            line_index: index,
            tools,
            content_units: text_units,
            uuid_units,
        });
    }
    ParsedTranscript {
        file: file.display().to_string(),
        session_id: session_id_units
            .as_ref()
            .map(|value| value.to_utf8().to_string()),
        ai_title: ai_title_units
            .as_ref()
            .map(|value| value.to_utf8().to_string()),
        pr_url: pr_url_units
            .as_ref()
            .map(|value| value.to_utf8().to_string()),
        cwd: cwd_units.as_ref().map(|value| value.to_utf8().to_string()),
        msgs,
        ai_title_units,
        pr_url_units,
        cwd_units,
        session_id_units,
    }
}

fn parse_object(line: &str) -> Option<JsValue> {
    let trimmed = protocol::js::js_trim(line);
    if trimmed.is_empty() {
        return None;
    }
    let value = protocol::js::parse(trimmed).ok()?;
    value.as_object()?;
    Some(value)
}

fn render_block_content(value: Option<&JsValue>) -> Option<JsString> {
    let value = value?;
    if let Some(items) = value.as_array() {
        let parts = items.iter().map(array_item_units).collect::<Vec<_>>();
        return Some(join_units(&parts, u16::from(b'\n')));
    }
    if let Some(text) = value.as_js_string() {
        return Some(text.clone());
    }
    Some(JsString::from_text(&protocol::js::stringify(value)))
}

fn array_item_units(item: &JsValue) -> JsString {
    if let Some(text) = item.as_js_string() {
        return text.clone();
    }
    item.get("text")
        .and_then(JsValue::as_js_string)
        .cloned()
        .unwrap_or_else(|| JsString::from_text(""))
}

fn stringify_result(value: &JsValue) -> Option<JsString> {
    if value.is_null() {
        None
    } else if let Some(text) = value.as_js_string() {
        Some(text.clone())
    } else {
        Some(JsString::from_text(&protocol::js::stringify(value)))
    }
}

fn truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Null => false,
        JsValue::Bool(flag) => *flag,
        JsValue::Number(number) => *number != 0.0,
        JsValue::String(text) => !text.to_utf8().is_empty(),
        JsValue::Array(items) => !items.is_empty(),
        JsValue::Object(object) => object.iter().next().is_some(),
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

fn title_limited(units: &[u16]) -> JsString {
    JsString::from_units(protocol::js::js_slice_units(
        units,
        Some(0.0),
        Some(TITLE_LIMIT as f64),
    ))
}

fn fallback_title_units(parsed: &ParsedTranscript) -> JsString {
    if let Some(title) = parsed
        .ai_title_units
        .as_ref()
        .filter(|value| !value.to_utf8().is_empty())
    {
        return title_limited(title.units());
    }
    if let Some(message) = parsed.msgs.iter().find(|message| message.role == "user")
        && !message.content_units.to_utf8().is_empty()
    {
        return title_limited(message.content_units.units());
    }
    let fallback = JsString::from_text("Claude Code session");
    title_limited(fallback.units())
}

fn parsed_timestamp(value: Option<&str>, env: &dyn protocol::host::Env) -> Option<String> {
    let text = value?;
    let ms = protocol::js::date_parse(text, env)?;
    protocol::js::to_iso_string(ms).ok()
}

fn clock_stamp(clock: &Option<Arc<dyn Fn() -> String + Send + Sync>>) -> String {
    match clock {
        Some(clock) => clock(),
        None => crate::iso_now(),
    }
}

fn is_text_assistant(message: &ParsedMessage) -> bool {
    message.role == "assistant"
        && !message.content.is_empty()
        && !message.content.starts_with("[tool call]")
}

fn is_prompt_user(message: &ParsedMessage) -> bool {
    message.role == "user"
        && message.tool_result.is_none()
        && !message.content.is_empty()
        && !message.content.starts_with("[tool call]")
}

fn assistant_indexes(parsed: &ParsedTranscript) -> Vec<usize> {
    parsed
        .msgs
        .iter()
        .enumerate()
        .filter(|(_, message)| is_text_assistant(message))
        .map(|(index, _)| index)
        .collect()
}

fn user_indexes(parsed: &ParsedTranscript) -> Vec<usize> {
    parsed
        .msgs
        .iter()
        .enumerate()
        .filter(|(_, message)| is_prompt_user(message))
        .map(|(index, _)| index)
        .collect()
}

fn tool_calls(parsed: &ParsedTranscript) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    for message in &parsed.msgs {
        for tool in &message.tools {
            calls.push(ToolCall {
                name_units: tool.name_units.clone(),
                input: tool.input.clone(),
                result_units: tool.result_units.clone(),
                result_line: tool.result_line,
                uuid_units: message.uuid_units.clone(),
                ts: message.ts.clone(),
                line_index: message.line_index,
            });
        }
    }
    calls
}

fn occurrence_key_assistant(content: &str) -> OccurrenceKey {
    OccurrenceKey {
        role: "assistant".to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
    }
}

fn occurrence_key_user(content: &str) -> OccurrenceKey {
    OccurrenceKey {
        role: "user".to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
    }
}

fn occurrence_key_tool(name: &str, input: Option<&JsValue>) -> OccurrenceKey {
    OccurrenceKey {
        role: "tool".to_string(),
        content: format!("[tool call] {name}"),
        tool_name: Some(name.to_string()),
        tool_args: input.cloned(),
    }
}

fn for_each_captured<'a>(
    parsed: &'a ParsedTranscript,
    mut visit: impl FnMut(u64, &str, CapturedSlot<'a>),
) {
    let mut counts = OccurrenceCounts::default();
    for message in &parsed.msgs {
        if is_text_assistant(message) {
            let key = occurrence_key_assistant(&message.content);
            let (n, tuple) = counts.next(&key);
            visit(n, &tuple, CapturedSlot::Assistant(message));
        }
        for tool in &message.tools {
            let key = occurrence_key_tool(&tool.name, tool.input.as_ref());
            let (n, tuple) = counts.next(&key);
            visit(n, &tuple, CapturedSlot::Tool(tool));
        }
        if is_prompt_user(message) {
            let key = occurrence_key_user(&message.content);
            let (n, tuple) = counts.next(&key);
            visit(n, &tuple, CapturedSlot::User(message));
        }
    }
}

struct DenIds {
    assistant: Vec<JsString>,
    tool: Vec<JsString>,
    user: Vec<JsString>,
}

fn den_event_ids(parsed: &ParsedTranscript, session_part: &JsString) -> DenIds {
    let mut ids = DenIds {
        assistant: Vec::new(),
        tool: Vec::new(),
        user: Vec::new(),
    };
    for_each_captured(parsed, |n, tuple, slot| match slot {
        CapturedSlot::Assistant(message) => {
            ids.assistant.push(native_event_id(
                session_part,
                ":",
                message.uuid_units.as_ref(),
                tuple,
                n,
            ));
        }
        CapturedSlot::Tool(tool) => {
            ids.tool.push(native_event_id(
                session_part,
                ":tool:",
                tool.id_units.as_ref(),
                tuple,
                n,
            ));
        }
        CapturedSlot::User(message) => {
            ids.user.push(native_event_id(
                session_part,
                ":",
                message.uuid_units.as_ref(),
                tuple,
                n,
            ));
        }
    });
    ids
}

fn native_event_id(
    session_part: &JsString,
    marker: &str,
    id: Option<&JsString>,
    tuple: &str,
    n: u64,
) -> JsString {
    let Some(id) = id else {
        return JsString::from_text(&occ_event_id(
            session_part.to_utf8(),
            &protocol::digest::sha256_hex(tuple.as_bytes()),
            n,
        ));
    };
    let prefix: Vec<u16> = "claude-code:".encode_utf16().collect();
    let middle: Vec<u16> = marker.encode_utf16().collect();
    concat_units(&[
        prefix.as_slice(),
        session_part.units(),
        middle.as_slice(),
        id.units(),
    ])
}

fn occ_event_id(session_part: &str, hash: &str, n: u64) -> String {
    format!("claude-code:{session_part}:occ:{hash}:{n}")
}

fn last_match_event_id(path: &Path, key: &OccurrenceKey, session_hint: &str) -> Option<JsString> {
    let parsed = parse_transcript(path).ok()?;
    let session_part = if !session_hint.is_empty() {
        JsString::from_text(session_hint)
    } else {
        parsed
            .session_id_units
            .clone()
            .filter(|value| !value.to_utf8().is_empty())
            .unwrap_or_else(|| JsString::from_text("unknown"))
    };
    let want = content_tuple_hash(key);
    let mut found = None;
    for_each_captured(&parsed, |n, tuple, slot| {
        if protocol::digest::sha256_hex(tuple.as_bytes()) != want {
            return;
        }
        found = Some(match slot {
            CapturedSlot::Tool(tool) => {
                native_event_id(&session_part, ":tool:", tool.id_units.as_ref(), tuple, n)
            }
            CapturedSlot::User(message) => {
                native_event_id(&session_part, ":", message.uuid_units.as_ref(), tuple, n)
            }
            CapturedSlot::Assistant(_) => JsString::from_text(&occ_event_id(
                session_part.to_utf8(),
                &protocol::digest::sha256_hex(tuple.as_bytes()),
                n,
            )),
        });
    });
    found
}

fn last_match_async(
    path: &Path,
    key: &OccurrenceKey,
    hint: &str,
) -> Pin<Box<dyn std::future::Future<Output = Option<JsString>> + Send>> {
    let path = path.to_path_buf();
    let key = key.clone();
    let hint = hint.to_string();
    Box::pin(async move {
        tokio::task::spawn_blocking(move || last_match_event_id(&path, &key, &hint))
            .await
            .ok()
            .flatten()
    })
}

fn hook_occurrence_key(payload: &JsValue) -> Option<OccurrenceKey> {
    match field_str(payload, "hook_event_name") {
        Some("UserPromptSubmit") => {
            let prompt = js_field(payload, "prompt")
                .cloned()
                .unwrap_or_else(|| JsString::from_text(""));
            if protocol::js::js_trim(prompt.to_utf8()).is_empty() {
                None
            } else {
                Some(occurrence_key_user(prompt.to_utf8()))
            }
        }
        Some("PostToolUse") => {
            let name = js_field(payload, "tool_name")
                .map(JsString::to_utf8)
                .unwrap_or("unknown");
            let args = payload.get("tool_input").filter(|value| !value.is_null());
            Some(occurrence_key_tool(name, args))
        }
        _ => None,
    }
}

fn hook_fallback_id(
    session_part: &str,
    idempotency_key: Option<&str>,
    session_key: &str,
    key: Option<&OccurrenceKey>,
) -> JsString {
    if let Some(key) = idempotency_key.filter(|value| !value.is_empty()) {
        return JsString::from_text(&format!("claude-code:{session_part}:hook:{key}"));
    }
    let (role, content, tool_name, tool_args) = match key {
        Some(key) => (
            key.role.as_str(),
            key.content.as_str(),
            key.tool_name.clone(),
            key.tool_args.clone(),
        ),
        None => ("user", "", None, None),
    };
    JsString::from_text(&event_id_from_content(&EventIdParts {
        session_key: session_key.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        tool_name,
        tool_args,
        occurrence: None,
    }))
}

fn field_str<'a>(value: &'a JsValue, key: &str) -> Option<&'a str> {
    value.get(key).and_then(JsValue::as_str)
}

fn js_field<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsString> {
    value.get(key).and_then(JsValue::as_js_string)
}

fn js_key(name: &str) -> JsString {
    JsString::from_text(name)
}

fn insert_text(object: &mut JsObject, key: &str, text: &str) {
    object.insert(js_key(key), JsValue::from_text(text));
}

fn insert_units(object: &mut JsObject, key: &str, text: &JsString) {
    object.insert(js_key(key), JsValue::String(text.clone()));
}

fn insert_opt_units(object: &mut JsObject, key: &str, text: Option<&JsString>) {
    match text {
        Some(text) => insert_units(object, key, text),
        None => {
            object.insert(js_key(key), JsValue::Null);
        }
    }
}

fn insert_opt_text(object: &mut JsObject, key: &str, text: Option<&str>) {
    match text {
        Some(text) => insert_text(object, key, text),
        None => {
            object.insert(js_key(key), JsValue::Null);
        }
    }
}

fn insert_pointer(metadata: &mut JsObject, file: &Path, line: usize) {
    insert_text(metadata, "session_jsonl_path", &file.display().to_string());
    metadata.insert(js_key("session_jsonl_line"), JsValue::Number(line as f64));
}

fn insert_herdr(metadata: &mut JsObject, herdr: Option<&HerdrPane>) {
    let Some(herdr) = herdr else {
        return;
    };
    if herdr.pane_id.is_empty() {
        return;
    }
    insert_text(metadata, "herdr_pane_id", &herdr.pane_id);
    if let Some(workspace) = herdr
        .workspace_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        insert_text(metadata, "herdr_workspace_id", workspace);
    }
    if let Some(host) = herdr.host.as_deref().filter(|value| !value.is_empty()) {
        insert_text(metadata, "herdr_host", host);
    }
}

fn message_js(
    event_id: Option<&JsString>,
    role: CaptureRole,
    content: &JsString,
    tool: (Option<&JsString>, Option<&JsValue>, Option<&JsString>),
    metadata: JsObject,
    created_at: Option<String>,
) -> JsValue {
    let (tool_name, tool_args, tool_result) = tool;
    let mut object = JsObject::new();
    let empty_id = JsString::from_text("");
    insert_units(&mut object, "event_id", event_id.unwrap_or(&empty_id));
    insert_text(&mut object, "role", role.as_str());
    insert_units(&mut object, "content", content);
    if let Some(name) = tool_name.filter(|value| !value.to_utf8().is_empty()) {
        insert_units(&mut object, "tool_name", name);
    }
    if let Some(args) = tool_args {
        object.insert(js_key("tool_args"), args.clone());
    }
    if let Some(result) = tool_result {
        insert_units(&mut object, "tool_result", result);
    }
    object.insert(js_key("metadata"), JsValue::Object(metadata));
    if let Some(created_at) = created_at {
        insert_text(&mut object, "created_at", &created_at);
    }
    JsValue::Object(object)
}

fn concat_units(parts: &[&[u16]]) -> JsString {
    let mut units = Vec::new();
    for part in parts {
        units.extend_from_slice(part);
    }
    JsString::from_units(units)
}

fn prefix_units(prefix: &str, id: &JsString) -> JsString {
    let head: Vec<u16> = prefix.encode_utf16().collect();
    concat_units(&[head.as_slice(), id.units()])
}

fn wire_session_key(
    override_key: Option<&str>,
    hook_session: Option<&JsString>,
    transcript_session: Option<&JsString>,
    fallback: &str,
) -> JsString {
    if let Some(value) = override_key.filter(|value| !value.is_empty()) {
        return JsString::from_text(value);
    }
    if let Some(id) = hook_session.filter(|value| !value.to_utf8().is_empty()) {
        return prefix_units("claude-code:", id);
    }
    if let Some(id) = transcript_session.filter(|value| !value.to_utf8().is_empty()) {
        return prefix_units("claude-code:", id);
    }
    JsString::from_text(fallback)
}

fn tool_content(name: &JsString) -> JsString {
    prefix_units("[tool call] ", name)
}

fn join_tool_names(tools: &[ToolUse]) -> JsString {
    let mut units: Vec<u16> = "[tool call] ".encode_utf16().collect();
    for (index, tool) in tools.iter().enumerate() {
        if index > 0 {
            units.extend(", ".encode_utf16());
        }
        units.extend_from_slice(tool.name_units.units());
    }
    JsString::from_units(units)
}

fn join_units(parts: &[JsString], separator: u16) -> JsString {
    let mut units = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            units.push(separator);
        }
        units.extend_from_slice(part.units());
    }
    JsString::from_units(units)
}

fn join_trimmed(parts: &[JsString]) -> JsString {
    let joined = join_units(parts, u16::from(b'\n'));
    JsString::from_units(protocol::js::js_trim_units(joined.units()).to_vec())
}

fn skipped_hook(session_key: String, reason: &str) -> HookEventResult {
    HookEventResult {
        session_key,
        conversation_id: String::new(),
        created: false,
        inserted: 0,
        skipped: Some(reason.to_string()),
    }
}

async fn post_js(
    batch: JsValue,
    count: u64,
    den_url: &str,
    user: Option<CaptureUser>,
    env: Option<Arc<dyn protocol::host::Env + Send + Sync>>,
    exchange: Option<HttpExchange>,
    spool_dir: Option<PathBuf>,
) -> Result<PostedCounts, String> {
    let injected = env.is_some();
    let env_arc: Arc<dyn protocol::host::Env + Send + Sync> = match env {
        Some(env) => env,
        None => Arc::new(ProcessEnv),
    };
    let mut options = CaptureWriterOptions::new(den_url);
    options.user = match user {
        Some(user) => UserSource::Routed(user),
        None => UserSource::Owner,
    };
    options.env = env_arc.clone();
    options.exchange = exchange;
    options.spool_dir = spool_dir;
    let lookup_env = env_arc.clone();
    let lookup_url = den_url.to_string();
    options.ca_path =
        tokio::task::spawn_blocking(move || ca_path(lookup_env.as_ref(), injected, &lookup_url))
            .await
            .ok()
            .flatten();
    let writer = create_capture_writer(options).map_err(|error| error.to_string())?;
    match writer.write_value(batch).await {
        Ok(WriteOutcome::Delivered {
            conversation_id,
            inserted,
            skipped,
            ..
        }) => Ok(PostedCounts {
            conversation_id,
            inserted,
            skipped,
        }),
        Ok(WriteOutcome::Spooled { .. }) => Ok(PostedCounts {
            conversation_id: String::new(),
            inserted: count,
            skipped: 0,
        }),
        Ok(WriteOutcome::NotSaved { error }) => Err(error),
        Err(error) => Err(capture_error_text(&error)),
    }
}

fn capture_error_text(error: &CaptureError) -> String {
    error.to_string()
}

fn ca_path(env: &dyn protocol::host::Env, injected: bool, den_url: &str) -> Option<PathBuf> {
    if !crate::den_scheme_is_https(den_url) {
        return None;
    }
    let resolved = if injected {
        resolve_den_url(env, || None, &crate::path_exists)
    } else {
        resolve_den_url(env, crate::default_config_reader, &crate::path_exists)
    };
    resolved.map(|item| PathBuf::from(item.ca_path))
}

async fn path_is_file(path: &Path) -> bool {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || path.is_file())
        .await
        .unwrap_or(false)
}

async fn load_transcript(path: &Path) -> Result<ParsedTranscript, String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || parse_transcript(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod occurrence_scale {
    use super::{OccurrenceKey, content_tuple_hash, den_event_ids, parse_transcript};
    use protocol::js::JsString;

    #[test]
    fn thousands_of_rows_keep_occurrence_ids() {
        const ROWS: usize = 5_000;
        let blob = "y".repeat(4_096);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.jsonl");
        let mut lines = Vec::with_capacity(ROWS + 8);
        let assistant = serde_json::json!({
            "type": "assistant",
            "sessionId": "sess-1",
            "message": {"role": "assistant", "content": "same answer"}
        });
        lines.push(assistant.clone());
        lines.push(assistant);
        let repeated = serde_json::json!({
            "type": "assistant",
            "sessionId": "sess-1",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "name": "Bash",
                    "input": {"command": blob}
                }]
            }
        });
        lines.push(repeated.clone());
        lines.push(repeated.clone());
        lines.push(repeated.clone());
        let mut counted = repeated.clone();
        counted["message"]["content"][0]["id"] = serde_json::Value::String("toolu_dup".to_string());
        lines.push(counted);
        lines.push(repeated);
        for index in 0..ROWS {
            lines.push(serde_json::json!({
                "type": "assistant",
                "sessionId": "sess-1",
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": format!("toolu_{index}"),
                        "name": "Read",
                        "input": {"file_path": format!("/tmp/f{index}"), "pad": blob}
                    }]
                }
            }));
        }
        let text = lines
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(&path, text).unwrap();
        let parsed = parse_transcript(&path).unwrap();
        let session = JsString::from_text("sess-1");
        let ids = den_event_ids(&parsed, &session);
        let assistant_hash = content_tuple_hash(&OccurrenceKey {
            role: "assistant".to_string(),
            content: "same answer".to_string(),
            tool_name: None,
            tool_args: None,
        });
        let tool_hash = content_tuple_hash(&OccurrenceKey {
            role: "tool".to_string(),
            content: "[tool call] Bash".to_string(),
            tool_name: Some("Bash".to_string()),
            tool_args: Some(protocol::js::from_serde(
                &serde_json::json!({"command": blob}),
            )),
        });
        assert_eq!(ids.assistant.len(), 2);
        assert_eq!(
            ids.assistant[0].to_utf8(),
            format!("claude-code:sess-1:occ:{assistant_hash}:0")
        );
        assert_eq!(
            ids.assistant[1].to_utf8(),
            format!("claude-code:sess-1:occ:{assistant_hash}:1")
        );
        assert!(ids.user.is_empty());
        assert_eq!(ids.tool.len(), ROWS + 5);
        assert_eq!(
            ids.tool[0].to_utf8(),
            format!("claude-code:sess-1:occ:{tool_hash}:0")
        );
        assert_eq!(
            ids.tool[1].to_utf8(),
            format!("claude-code:sess-1:occ:{tool_hash}:1")
        );
        assert_eq!(
            ids.tool[2].to_utf8(),
            format!("claude-code:sess-1:occ:{tool_hash}:2")
        );
        assert_eq!(ids.tool[3].to_utf8(), "claude-code:sess-1:tool:toolu_dup");
        assert_eq!(
            ids.tool[4].to_utf8(),
            format!("claude-code:sess-1:occ:{tool_hash}:4")
        );
        assert_eq!(ids.tool[5].to_utf8(), "claude-code:sess-1:tool:toolu_0");
        assert_eq!(
            ids.tool[5 + ROWS / 2].to_utf8(),
            format!("claude-code:sess-1:tool:toolu_{}", ROWS / 2)
        );
        assert_eq!(
            ids.tool.last().unwrap().to_utf8(),
            format!("claude-code:sess-1:tool:toolu_{}", ROWS - 1)
        );
    }
}
