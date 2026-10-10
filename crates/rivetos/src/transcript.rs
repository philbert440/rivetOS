use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use capture::{
    CaptureBatch, CaptureError, CaptureMessage, CaptureRole, CaptureTransport, CaptureUser,
    CaptureWriterOptions, EventIdParts, HttpExchange, OccurrenceKey, ProcessEnv, UserSource,
    WriteOutcome, content_tuple_hash, create_capture_writer, event_id_from_content,
    occurrence_index, resolve_capture_transport, resolve_den_url,
};
use serde_json::{Map, Value};

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

pub fn capture_agent(env: &dyn capture::EnvLookup) -> String {
    match env.get("RIVETOS_CAPTURE_AGENT") {
        Some(value) if !value.is_empty() => value,
        _ => "rivet-claude".to_string(),
    }
}

pub struct ToolUse {
    pub name: String,
    pub input: Option<Value>,
    pub id: Option<String>,
    pub result: Option<String>,
    pub result_line: Option<usize>,
}

pub struct ParsedMessage {
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<Value>,
    pub tool_result: Option<String>,
    pub ts: Option<String>,
    pub uuid: Option<String>,
    pub sidechain: bool,
    pub line_index: usize,
    pub tools: Vec<ToolUse>,
}

pub struct ParsedTranscript {
    pub file: String,
    pub session_id: Option<String>,
    pub ai_title: Option<String>,
    pub pr_url: Option<String>,
    pub cwd: Option<String>,
    pub msgs: Vec<ParsedMessage>,
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
    pub env: Option<Arc<dyn capture::EnvLookup>>,
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
    pub payload: Value,
    pub session_key_override: Option<String>,
    pub task_id: Option<String>,
    pub pg_url: Option<String>,
    pub herdr: Option<HerdrPane>,
    pub env: Option<Arc<dyn capture::EnvLookup>>,
    pub exchange: Option<HttpExchange>,
    pub spool_dir: Option<PathBuf>,
    pub idempotency_key: Option<String>,
    pub poll_ms: Option<u64>,
    pub poll_for_ms: Option<u64>,
    pub now_iso: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

impl HookEventOptions {
    pub fn new(payload: Value) -> Self {
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
    pub event_id: String,
    pub hook_only: bool,
}

struct PostedCounts {
    conversation_id: String,
    inserted: u64,
    skipped: u64,
}

struct ToolCall {
    name: String,
    input: Option<Value>,
    result: Option<String>,
    result_line: Option<usize>,
    uuid: Option<String>,
    ts: Option<String>,
    line_index: usize,
}

enum CapturedSlot {
    Assistant(usize),
    Tool(usize),
    User(usize),
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

pub fn resolve_task_context(env: &dyn capture::EnvLookup) -> TaskCaptureContext {
    let override_key = env
        .get("RIVETOS_SESSION_KEY")
        .filter(|value| !value.is_empty());
    let legacy_task_key = override_key
        .as_deref()
        .is_some_and(|value| value.starts_with(LEGACY_TASK_KEY_PREFIX));
    let explicit = env.get("RIVETOS_TASK_ID").filter(|value| !value.is_empty());
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

pub fn derive_session_key(transcript_path: &Path, env: &dyn capture::EnvLookup) -> String {
    let home = env
        .get("HOME")
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
    env: Option<Arc<dyn capture::EnvLookup>>,
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
    env: Option<&dyn capture::EnvLookup>,
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
    resolve_capture_transport(&ProcessEnv, capture::default_config_reader)
}

pub async fn resolve_hook_event_id(opts: &HookEventOptions) -> ResolvedHookId {
    if let Some(stored) =
        field_str(&opts.payload, "rivetos_event_id").filter(|value| !value.is_empty())
    {
        return ResolvedHookId {
            hook_only: stored.contains(":hook:") || !stored.starts_with("claude-code:"),
            event_id: stored.to_string(),
        };
    }
    let session_id = field_str(&opts.payload, "session_id");
    let session_key = resolve_conversation_key(ConversationKeyParts {
        override_key: opts.session_key_override.as_deref(),
        hook_session_id: session_id,
        transcript_session_id: None,
        fallback_key: "",
    });
    let session_part = nonempty(session_id)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if session_key.is_empty() {
                "unknown".to_string()
            } else {
                session_key.clone()
            }
        });
    let event = field_str(&opts.payload, "hook_event_name").unwrap_or("");
    let key = hook_occurrence_key(&opts.payload);
    if event == "PostToolUse"
        && let Some(tool_id) = payload_tool_use_id(&opts.payload)
    {
        return ResolvedHookId {
            event_id: format!("claude-code:{session_part}:tool:{tool_id}"),
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
        let hint = session_id.unwrap_or("");
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
            event_id: occ_event_id(&session_part, key, 0),
            hook_only: false,
        };
    }
    ResolvedHookId {
        event_id: hook_fallback_id(
            &session_part,
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
        .map(|item| item.as_ref() as &dyn capture::EnvLookup);
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
                .or(nonempty(parsed.session_id.as_deref()))
                .unwrap_or("unknown");
            let ids = den_event_ids(&parsed, session_part);
            let file = std::path::absolute(&opts.transcript_path)
                .unwrap_or_else(|_| opts.transcript_path.clone());
            let mut messages = Vec::new();
            for (offset, index) in assistant.iter().enumerate() {
                let message = &parsed.msgs[*index];
                let mut metadata = Map::new();
                metadata.insert(
                    "source".to_string(),
                    Value::String("claude-code-hook".to_string()),
                );
                metadata.insert("uuid".to_string(), json_opt(&message.uuid));
                metadata.insert("sidechain".to_string(), Value::Bool(message.sidechain));
                insert_pointer(&mut metadata, &file, message.line_index);
                insert_herdr(&mut metadata, opts.herdr.as_ref());
                messages.push(message_row(
                    ids.assistant.get(offset).cloned().unwrap_or_default(),
                    CaptureRole::Assistant,
                    message.content.clone(),
                    (None, None, None),
                    metadata,
                    iso_timestamp(message.ts.as_deref()),
                ));
            }
            for (offset, tool) in tools.iter().enumerate() {
                let mut metadata = Map::new();
                metadata.insert(
                    "source".to_string(),
                    Value::String("claude-code-hook".to_string()),
                );
                metadata.insert("uuid".to_string(), json_opt(&tool.uuid));
                metadata.insert(
                    "hook_event".to_string(),
                    Value::String("PostToolUse".to_string()),
                );
                metadata.insert("recovered".to_string(), Value::Bool(true));
                insert_pointer(
                    &mut metadata,
                    &file,
                    tool.result_line.unwrap_or(tool.line_index),
                );
                insert_herdr(&mut metadata, opts.herdr.as_ref());
                messages.push(message_row(
                    ids.tool.get(offset).cloned().unwrap_or_default(),
                    CaptureRole::Tool,
                    format!("[tool call] {}", tool.name),
                    (
                        Some(tool.name.clone()),
                        tool.input.clone(),
                        tool.result.clone(),
                    ),
                    metadata,
                    iso_timestamp(tool.ts.as_deref()),
                ));
            }
            for (offset, index) in users.iter().enumerate() {
                let message = &parsed.msgs[*index];
                let mut metadata = Map::new();
                metadata.insert(
                    "source".to_string(),
                    Value::String("claude-code-hook".to_string()),
                );
                metadata.insert("uuid".to_string(), json_opt(&message.uuid));
                metadata.insert("recovered".to_string(), Value::Bool(true));
                insert_pointer(&mut metadata, &file, message.line_index);
                insert_herdr(&mut metadata, opts.herdr.as_ref());
                messages.push(message_row(
                    ids.user.get(offset).cloned().unwrap_or_default(),
                    CaptureRole::User,
                    message.content.clone(),
                    (None, None, None),
                    metadata,
                    iso_timestamp(message.ts.as_deref()),
                ));
            }
            let mut settings = Map::new();
            settings.insert(
                "source".to_string(),
                Value::String("claude-code-hook".to_string()),
            );
            settings.insert(
                "file".to_string(),
                Value::String(opts.transcript_path.display().to_string()),
            );
            settings.insert(
                "session_id".to_string(),
                json_opt(&opts.session_id.clone().or(parsed.session_id.clone())),
            );
            settings.insert("pr_url".to_string(), json_opt(&parsed.pr_url));
            if let Some(cwd) = parsed.cwd.clone() {
                settings.insert("cwd".to_string(), Value::String(cwd));
            }
            settings.insert("last_event".to_string(), json_opt(&opts.event));
            settings.insert(
                "last_ingest_at".to_string(),
                Value::String(now_iso(&opts.now_iso)),
            );
            let batch = CaptureBatch {
                session_key: session_key.clone(),
                agent: capture_agent(env_ref.unwrap_or(&ProcessEnv)),
                channel: Some(CAPTURE_CHANNEL.to_string()),
                title: Some(fallback_title(&parsed)),
                settings: Some(Value::Object(settings)),
                task_id: opts.task_id.clone().filter(|value| is_task_id(Some(value))),
                finalize: opts.mark_inactive.then_some(true),
                created_at: None,
                updated_at: None,
                messages,
            };
            let posted = post_batch(
                batch,
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
        let prompt = field_str(&opts.payload, "prompt").unwrap_or("");
        if prompt.trim().is_empty() {
            return Ok(skipped_hook(session_key, "empty prompt"));
        }
        (
            CaptureRole::User,
            prompt.to_string(),
            slice_title(prompt),
            None,
            None,
            None,
        )
    } else if event == "PostToolUse" {
        let name = field_str(&opts.payload, "tool_name")
            .unwrap_or("unknown")
            .to_string();
        let raw = match opts.payload.get("tool_response") {
            Some(value) if !value.is_null() => value.clone(),
            _ => opts
                .payload
                .get("tool_result")
                .cloned()
                .unwrap_or(Value::Null),
        };
        let result = stringify_result(&raw);
        let args = opts
            .payload
            .get("tool_input")
            .filter(|value| !value.is_null())
            .cloned();
        (
            CaptureRole::Tool,
            format!("[tool call] {name}"),
            "Claude Code session".to_string(),
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
        .map(|item| item.as_ref() as &dyn capture::EnvLookup);
    let transport = select_transport_async(env.clone(), opts.pg_url.clone()).await;
    match transport {
        CaptureTransport::None { reason } => {
            Err(format!("capture transport unavailable: {reason}"))
        }
        CaptureTransport::Pg { .. } => Err("capture postgres pool is not ported".to_string()),
        CaptureTransport::Den { den_url, user, .. } => {
            let resolved = resolve_hook_event_id(&opts).await;
            let mut metadata = Map::new();
            let source = if resolved.hook_only {
                "hook-only"
            } else {
                "claude-code-hook"
            };
            metadata.insert("source".to_string(), Value::String(source.to_string()));
            metadata.insert("hook_event".to_string(), Value::String(event.clone()));
            if let Some(key) = opts.idempotency_key.clone() {
                metadata.insert("ingest_key".to_string(), Value::String(key));
            }
            insert_herdr(&mut metadata, opts.herdr.as_ref());
            let mut settings = Map::new();
            settings.insert(
                "source".to_string(),
                Value::String("claude-code-hook".to_string()),
            );
            settings.insert("session_id".to_string(), json_opt(&session_id));
            if let Some(cwd) = field_str(&opts.payload, "cwd").filter(|value| !value.is_empty()) {
                settings.insert("cwd".to_string(), Value::String(cwd.to_string()));
            }
            settings.insert("last_event".to_string(), Value::String(event));
            settings.insert(
                "last_ingest_at".to_string(),
                Value::String(now_iso(&opts.now_iso)),
            );
            let batch = CaptureBatch {
                session_key: session_key.clone(),
                agent: capture_agent(env_ref.unwrap_or(&ProcessEnv)),
                channel: Some(CAPTURE_CHANNEL.to_string()),
                title: Some(title),
                settings: Some(Value::Object(settings)),
                task_id: opts.task_id.clone().filter(|value| is_task_id(Some(value))),
                finalize: None,
                created_at: None,
                updated_at: None,
                messages: vec![message_row(
                    resolved.event_id,
                    role,
                    content,
                    (tool_name, tool_args, tool_result),
                    metadata,
                    None,
                )],
            };
            let posted = post_batch(
                batch,
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
    let mut result_by_id = HashMap::<String, String>::new();
    let mut result_line_by_id = HashMap::<String, usize>::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(object) = parse_object(line) else {
            continue;
        };
        let Some(blocks) = object
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            let Some(block) = block.as_object() else {
                continue;
            };
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let rendered = block
                .get("content")
                .map(stringify_result_value)
                .unwrap_or_else(|| "null".to_string());
            result_by_id.insert(id.to_string(), rendered);
            result_line_by_id.entry(id.to_string()).or_insert(index);
        }
    }
    let mut ai_title = None;
    let mut session_id = None;
    let mut pr_url = None;
    let mut cwd = None;
    let mut msgs = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(object) = parse_object(line) else {
            continue;
        };
        if cwd.is_none()
            && let Some(value) = object.get("cwd").and_then(trimmed_string)
        {
            cwd = Some(value);
        }
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "ai-title" {
            if let Some(title) = object.get("aiTitle").and_then(Value::as_str) {
                ai_title = Some(title.to_string());
            }
            if session_id.is_none()
                && let Some(id) = object.get("sessionId").and_then(Value::as_str)
            {
                session_id = Some(id.to_string());
            }
            continue;
        }
        if kind == "pr-link" {
            if let Some(url) = object.get("prUrl").and_then(Value::as_str) {
                pr_url = Some(url.to_string());
            }
            continue;
        }
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if object.get("isMeta").is_some_and(truthy) {
            continue;
        }
        if session_id.is_none()
            && let Some(id) = object.get("sessionId").and_then(Value::as_str)
        {
            session_id = Some(id.to_string());
        }
        let message = object.get("message").and_then(Value::as_object);
        let role = message
            .and_then(|item| item.get("role"))
            .and_then(Value::as_str)
            .unwrap_or(kind)
            .to_string();
        let content_value = message.and_then(|item| item.get("content"));
        let mut text_parts = Vec::new();
        let mut think_parts = Vec::new();
        let mut result_parts = Vec::new();
        let mut tools = Vec::new();
        let mut text_body = String::new();
        if let Some(content) = content_value.and_then(Value::as_str) {
            text_body = content.to_string();
        } else if let Some(blocks) = content_value.and_then(Value::as_array) {
            for block in blocks {
                let Some(block) = block.as_object() else {
                    continue;
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => text_parts.push(
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    ),
                    Some("thinking") => think_parts.push(
                        block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .or_else(|| block.get("text").and_then(Value::as_str))
                            .unwrap_or("")
                            .to_string(),
                    ),
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty());
                        let id_owned = id.map(str::to_string);
                        tools.push(ToolUse {
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| "unknown".to_string()),
                            input: block.get("input").filter(|value| !value.is_null()).cloned(),
                            result: id_owned
                                .as_ref()
                                .and_then(|id| result_by_id.get(id).cloned()),
                            result_line: id_owned
                                .as_ref()
                                .and_then(|id| result_line_by_id.get(id).copied()),
                            id: id_owned,
                        });
                    }
                    Some("tool_result") => {
                        result_parts.push(
                            block
                                .get("content")
                                .map(stringify_result_value)
                                .unwrap_or_else(|| "null".to_string()),
                        );
                    }
                    _ => {}
                }
            }
            text_body = text_parts.join("\n").trim().to_string();
            if text_body.is_empty() && !think_parts.is_empty() {
                text_body = format!("[thinking] {}", think_parts.join("\n").trim());
            }
        }
        let tool_result = if result_parts.is_empty() {
            None
        } else {
            Some(result_parts.join("\n"))
        };
        let (tool_name, tool_args) = if let Some(first) = tools.first() {
            if text_body.is_empty() {
                text_body = format!(
                    "[tool call] {}",
                    tools
                        .iter()
                        .map(|tool| tool.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
            (Some(first.name.clone()), first.input.clone())
        } else {
            (None, None)
        };
        if text_body.is_empty() && tool_result.is_none() {
            continue;
        }
        if text_body.is_empty()
            && let Some(result) = &tool_result
        {
            text_body = result.clone();
        }
        msgs.push(ParsedMessage {
            role,
            content: text_body,
            tool_name,
            tool_args,
            tool_result,
            ts: object
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string),
            uuid: object
                .get("uuid")
                .and_then(Value::as_str)
                .map(str::to_string),
            sidechain: object.get("isSidechain").is_some_and(truthy),
            line_index: index,
            tools,
        });
    }
    ParsedTranscript {
        file: file.display().to_string(),
        session_id,
        ai_title,
        pr_url,
        cwd,
        msgs,
    }
}

fn parse_object(line: &str) -> Option<Map<String, Value>> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value = protocol::js::to_serde(&protocol::js::parse(trimmed).ok()?);
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn stringify_result_value(value: &Value) -> String {
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .map(|item| {
                if let Some(text) = item.as_str() {
                    text.to_string()
                } else {
                    item.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    protocol::js::stringify(&protocol::js::from_serde(value))
}

fn stringify_result(value: &Value) -> Option<String> {
    if value.is_null() {
        None
    } else {
        Some(stringify_result_value(value))
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|item| item != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn trimmed_string(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

fn slice_title(text: &str) -> String {
    capture::utf16_slice(text, TITLE_LIMIT)
}

fn fallback_title(parsed: &ParsedTranscript) -> String {
    let first_user = parsed
        .msgs
        .iter()
        .find(|message| message.role == "user")
        .map(|message| message.content.as_str());
    let raw = nonempty(parsed.ai_title.as_deref())
        .or_else(|| nonempty(first_user))
        .unwrap_or("Claude Code session");
    slice_title(raw)
}

fn json_opt(value: &Option<String>) -> Value {
    match value {
        Some(text) => Value::String(text.clone()),
        None => Value::Null,
    }
}

fn iso_timestamp(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() || !text.contains('T') {
        return None;
    }
    if text.ends_with('Z') || text.contains('+') || text.matches('-').count() > 2 {
        Some(text.to_string())
    } else {
        None
    }
}

fn now_iso(clock: &Option<Arc<dyn Fn() -> String + Send + Sync>>) -> String {
    match clock {
        Some(clock) => clock(),
        None => capture::iso_now(),
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
                name: tool.name.clone(),
                input: tool.input.clone(),
                result: tool.result.clone(),
                result_line: tool.result_line,
                uuid: message.uuid.clone(),
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

fn occurrence_key_tool(name: &str, input: Option<&Value>) -> OccurrenceKey {
    OccurrenceKey {
        role: "tool".to_string(),
        content: format!("[tool call] {name}"),
        tool_name: Some(name.to_string()),
        tool_args: input.cloned(),
    }
}

fn for_each_captured(
    parsed: &ParsedTranscript,
    mut visit: impl FnMut(&OccurrenceKey, u64, CapturedSlot),
) {
    let mut rows = Vec::new();
    let mut assistant_at = 0usize;
    let mut tool_at = 0usize;
    let mut user_at = 0usize;
    for message in &parsed.msgs {
        if is_text_assistant(message) {
            let key = occurrence_key_assistant(&message.content);
            rows.push(key.clone());
            let n = occurrence_index(&rows, &key);
            visit(&key, n, CapturedSlot::Assistant(assistant_at));
            assistant_at += 1;
        }
        for tool in &message.tools {
            let key = occurrence_key_tool(&tool.name, tool.input.as_ref());
            rows.push(key.clone());
            let n = occurrence_index(&rows, &key);
            visit(&key, n, CapturedSlot::Tool(tool_at));
            tool_at += 1;
        }
        if is_prompt_user(message) {
            let key = occurrence_key_user(&message.content);
            rows.push(key.clone());
            let n = occurrence_index(&rows, &key);
            visit(&key, n, CapturedSlot::User(user_at));
            user_at += 1;
        }
    }
}

struct DenIds {
    assistant: Vec<String>,
    tool: Vec<String>,
    user: Vec<String>,
}

fn den_event_ids(parsed: &ParsedTranscript, session_part: &str) -> DenIds {
    let mut ids = DenIds {
        assistant: Vec::new(),
        tool: Vec::new(),
        user: Vec::new(),
    };
    for_each_captured(parsed, |key, n, slot| match slot {
        CapturedSlot::Assistant(index) => {
            let message = assistant_message(parsed, index);
            ids.assistant
                .push(match message.and_then(|item| item.uuid.clone()) {
                    Some(uuid) => format!("claude-code:{session_part}:{uuid}"),
                    None => occ_event_id(session_part, key, n),
                });
        }
        CapturedSlot::Tool(index) => {
            let tool = tool_at(parsed, index);
            ids.tool.push(match tool.and_then(|item| item.id.clone()) {
                Some(id) => format!("claude-code:{session_part}:tool:{id}"),
                None => occ_event_id(session_part, key, n),
            });
        }
        CapturedSlot::User(index) => {
            let message = user_message(parsed, index);
            ids.user
                .push(match message.and_then(|item| item.uuid.clone()) {
                    Some(uuid) => format!("claude-code:{session_part}:{uuid}"),
                    None => occ_event_id(session_part, key, n),
                });
        }
    });
    ids
}

fn assistant_message(parsed: &ParsedTranscript, offset: usize) -> Option<&ParsedMessage> {
    parsed
        .msgs
        .iter()
        .filter(|message| is_text_assistant(message))
        .nth(offset)
}

fn user_message(parsed: &ParsedTranscript, offset: usize) -> Option<&ParsedMessage> {
    parsed
        .msgs
        .iter()
        .filter(|message| is_prompt_user(message))
        .nth(offset)
}

fn tool_at(parsed: &ParsedTranscript, offset: usize) -> Option<&ToolUse> {
    parsed
        .msgs
        .iter()
        .flat_map(|message| message.tools.iter())
        .nth(offset)
}

fn occ_event_id(session_part: &str, key: &OccurrenceKey, n: u64) -> String {
    format!(
        "claude-code:{session_part}:occ:{}:{n}",
        content_tuple_hash(key)
    )
}

fn last_match_event_id(path: &Path, key: &OccurrenceKey, session_hint: &str) -> Option<String> {
    let parsed = parse_transcript(path).ok()?;
    let session_part = if !session_hint.is_empty() {
        session_hint.to_string()
    } else {
        parsed
            .session_id
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string())
    };
    let want = content_tuple_hash(key);
    let mut found = None;
    for_each_captured(&parsed, |row_key, n, slot| {
        if content_tuple_hash(row_key) != want {
            return;
        }
        found = Some(match slot {
            CapturedSlot::Tool(index) => {
                match tool_at(&parsed, index).and_then(|tool| tool.id.clone()) {
                    Some(id) => format!("claude-code:{session_part}:tool:{id}"),
                    None => occ_event_id(&session_part, row_key, n),
                }
            }
            CapturedSlot::User(index) => {
                match user_message(&parsed, index).and_then(|message| message.uuid.clone()) {
                    Some(uuid) => format!("claude-code:{session_part}:{uuid}"),
                    None => occ_event_id(&session_part, row_key, n),
                }
            }
            CapturedSlot::Assistant(_) => occ_event_id(&session_part, row_key, n),
        });
    });
    found
}

fn last_match_async(
    path: &Path,
    key: &OccurrenceKey,
    hint: &str,
) -> Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>> {
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

fn payload_tool_use_id(payload: &Value) -> Option<String> {
    field_str(payload, "tool_use_id")
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn hook_occurrence_key(payload: &Value) -> Option<OccurrenceKey> {
    match field_str(payload, "hook_event_name") {
        Some("UserPromptSubmit") => {
            let prompt = field_str(payload, "prompt").unwrap_or("");
            if prompt.trim().is_empty() {
                None
            } else {
                Some(occurrence_key_user(prompt))
            }
        }
        Some("PostToolUse") => {
            let name = field_str(payload, "tool_name").unwrap_or("unknown");
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
) -> String {
    if let Some(key) = idempotency_key.filter(|value| !value.is_empty()) {
        return format!("claude-code:{session_part}:hook:{key}");
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
    event_id_from_content(&EventIdParts {
        session_key: session_key.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        tool_name,
        tool_args,
        occurrence: None,
    })
}

fn field_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn insert_pointer(metadata: &mut Map<String, Value>, file: &Path, line: usize) {
    metadata.insert(
        "session_jsonl_path".to_string(),
        Value::String(file.display().to_string()),
    );
    metadata.insert(
        "session_jsonl_line".to_string(),
        Value::from(u64::try_from(line).unwrap_or(u64::MAX)),
    );
}

fn insert_herdr(metadata: &mut Map<String, Value>, herdr: Option<&HerdrPane>) {
    let Some(herdr) = herdr else {
        return;
    };
    if herdr.pane_id.is_empty() {
        return;
    }
    metadata.insert(
        "herdr_pane_id".to_string(),
        Value::String(herdr.pane_id.clone()),
    );
    if let Some(workspace) = herdr.workspace_id.clone().filter(|value| !value.is_empty()) {
        metadata.insert("herdr_workspace_id".to_string(), Value::String(workspace));
    }
    if let Some(host) = herdr.host.clone().filter(|value| !value.is_empty()) {
        metadata.insert("herdr_host".to_string(), Value::String(host));
    }
}

fn message_row(
    event_id: String,
    role: CaptureRole,
    content: String,
    tool: (Option<String>, Option<Value>, Option<String>),
    metadata: Map<String, Value>,
    created_at: Option<String>,
) -> CaptureMessage {
    CaptureMessage {
        event_id,
        role,
        content,
        tool_name: tool.0.filter(|value| !value.is_empty()),
        tool_args: tool.1,
        tool_result: tool.2,
        metadata: Some(metadata),
        created_at,
    }
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

async fn post_batch(
    batch: CaptureBatch,
    den_url: &str,
    user: Option<CaptureUser>,
    env: Option<Arc<dyn capture::EnvLookup>>,
    exchange: Option<HttpExchange>,
    spool_dir: Option<PathBuf>,
) -> Result<PostedCounts, String> {
    let count = u64::try_from(batch.messages.len()).unwrap_or(u64::MAX);
    let injected = env.is_some();
    let env_arc: Arc<dyn capture::EnvLookup> = match env {
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
    match writer.write(batch).await {
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

fn ca_path(env: &dyn capture::EnvLookup, injected: bool, den_url: &str) -> Option<PathBuf> {
    if !capture::den_scheme_is_https(den_url) {
        return None;
    }
    let resolved = if injected {
        resolve_den_url(env, || None, &capture::path_exists)
    } else {
        resolve_den_url(env, capture::default_config_reader, &capture::path_exists)
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
