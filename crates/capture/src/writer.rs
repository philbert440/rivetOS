use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, HeaderValue};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

use crate::env::EnvLookup;
use crate::error::{CaptureError, ReplayReport, WriteOutcome};
use crate::helpers::{self, json_utf8_len};
use crate::redaction::{self, ResolvedCaptureRedaction, keep_metadata_key};
use crate::spool;
use crate::timeutil;
use crate::transport::{self, CaptureUser};
use crate::types::{
    CaptureBatch, CaptureMessage, CaptureResult, CaptureWriterOptions, HttpReply, LogFn, UserSource,
};

pub const DEFAULT_CHUNK_BYTES: usize = 768 * 1024;
pub const CHUNK_OVER_LIMIT: &str = "chunk exceeds maxChunkBytes after elision";
pub const SPOOL_REFUSED_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

pub struct CaptureWriter {
    den_url: String,
    user: Option<CaptureUser>,
    dir: PathBuf,
    max_chunk_bytes: usize,
    redaction: Option<ResolvedCaptureRedaction>,
    log: Option<LogFn>,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    client: OnceCell<reqwest::Client>,
    ca_path: Option<PathBuf>,
    timeout: Duration,
    exchange: Option<crate::types::HttpExchange>,
}

#[derive(Default)]
pub struct ReplayOptions {
    pub max: Option<f64>,
}

pub fn create_capture_writer(
    opts: CaptureWriterOptions,
) -> Result<CaptureWriter, transport::MissingUserToken> {
    let user = match &opts.user {
        UserSource::FromEnv => transport::capture_user_from_env(opts.env.as_ref())?,
        UserSource::Owner => None,
        UserSource::Routed(user) => Some(user.clone()),
    };
    let dir = match &opts.spool_dir {
        Some(dir) => dir.clone(),
        None => spool_dir_for(opts.env.as_ref(), user.as_ref()),
    };
    let redaction = resolve_writer_redaction(&opts);
    let now_ms = opts
        .now_ms
        .clone()
        .unwrap_or_else(|| Arc::new(timeutil::unix_ms_now));
    Ok(CaptureWriter {
        den_url: opts.den_url,
        user,
        dir,
        max_chunk_bytes: chunk_limit(opts.max_chunk_bytes),
        redaction,
        log: opts.log,
        now_ms,
        client: OnceCell::new(),
        ca_path: opts.ca_path,
        timeout: opts.timeout,
        exchange: opts.exchange,
    })
}

fn spool_dir_for(env: &dyn EnvLookup, user: Option<&CaptureUser>) -> PathBuf {
    let home = env
        .get("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    match user {
        Some(user) => home
            .join(".rivetos")
            .join("capture-spool-users")
            .join(spool_name_for(&user.id)),
        None => home.join(".rivetos").join("capture-spool"),
    }
}

pub fn spool_name_for(user_id: &str) -> String {
    let digest = Sha256::digest(user_id.as_bytes());
    let hex = hex::encode(digest);
    hex.chars().take(32).collect()
}

fn resolve_writer_redaction(opts: &CaptureWriterOptions) -> Option<ResolvedCaptureRedaction> {
    if let Some(redaction) = &opts.redaction
        && redaction.enabled.is_some()
    {
        return redaction::resolve_capture_redaction(Some(redaction));
    }
    redaction::resolve_capture_redaction(
        redaction::capture_redaction_from_env(opts.env.as_ref()).as_ref(),
    )
}

fn chunk_limit(requested: Option<f64>) -> usize {
    let Some(value) = requested else {
        return DEFAULT_CHUNK_BYTES;
    };
    if !value.is_finite() || value <= 0.0 {
        return DEFAULT_CHUNK_BYTES;
    }
    let floored = value.floor();
    if floored >= usize::MAX as f64 {
        usize::MAX
    } else {
        floored as usize
    }
}

fn replay_limit(requested: Option<f64>) -> usize {
    let Some(value) = requested else {
        return 50;
    };
    if !value.is_finite() {
        return 50;
    }
    let floored = value.floor();
    if floored <= 0.0 {
        0
    } else if floored >= usize::MAX as f64 {
        usize::MAX
    } else {
        floored as usize
    }
}

impl CaptureWriter {
    pub fn spool_dir(&self) -> &Path {
        &self.dir
    }

    pub async fn replay(&self, options: ReplayOptions) -> ReplayReport {
        let mut replayed = 0u64;
        let mut dead = 0u64;
        let report = async {
            let files = spool::spool_files(&self.dir)
                .await
                .map_err(|error| CaptureError::Io(error.to_string()))?;
            let max = replay_limit(options.max);
            for file in files.into_iter().take(max) {
                match self.replay_one(&file).await {
                    ReplayStep::Replayed => replayed += 1,
                    ReplayStep::Dead => dead += 1,
                    ReplayStep::Continue => {}
                    ReplayStep::Stop => break,
                }
            }
            let remaining = spool::spool_files(&self.dir)
                .await
                .map_err(|error| CaptureError::Io(error.to_string()))?
                .len() as u64;
            Ok::<_, CaptureError>(ReplayReport {
                replayed,
                remaining,
                dead,
            })
        };
        match report.await {
            Ok(report) => report,
            Err(error) => {
                self.emit(&error.log_line());
                let remaining = spool::spool_files(&self.dir)
                    .await
                    .unwrap_or_default()
                    .len() as u64;
                ReplayReport {
                    replayed,
                    remaining,
                    dead,
                }
            }
        }
    }

    pub async fn write(&self, batch: CaptureBatch) -> Result<WriteOutcome, CaptureError> {
        let value = serde_json::to_value(&batch).unwrap_or(Value::Null);
        self.write_value(value).await
    }

    pub async fn write_value(&self, batch: Value) -> Result<WriteOutcome, CaptureError> {
        self.replay(ReplayOptions { max: Some(50.0) }).await;
        let original = match &batch {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        let prepared = match serde_json::from_value::<CaptureBatch>(Value::Object(original.clone()))
        {
            Ok(mut parsed) => {
                parsed.messages = self.prepare_messages(std::mem::take(&mut parsed.messages));
                parsed
            }
            Err(_) => empty_batch(),
        };
        let chunks = split_chunks(prepared, self.max_chunk_bytes, &self.log);
        let base = (self.now_ms)();
        let mut inserted = 0u64;
        let mut skipped = 0u64;
        let mut conversation_id = String::new();
        let mut files = Vec::new();
        let chunk_count = chunks.len();
        for (index, chunk) in chunks.iter().enumerate() {
            let body_value = project_chunk(&original, chunk, index + 1 == chunk_count);
            let body = protocol::js::stringify(&body_value);
            if body.len() > self.max_chunk_bytes {
                self.emit(CHUNK_OVER_LIMIT);
                return Ok(WriteOutcome::NotSaved {
                    error: CHUNK_OVER_LIMIT.to_string(),
                });
            }
            match self.post(body.clone()).await {
                Ok(result) => {
                    inserted = inserted.saturating_add(result.inserted);
                    skipped = skipped.saturating_add(result.skipped);
                    if !result.conversation_id.is_empty() {
                        conversation_id = result.conversation_id;
                    }
                }
                Err(error) => {
                    self.emit(&error.log_line());
                    if error.is_client() {
                        return Err(error);
                    }
                    let when = base.saturating_add(index as i64);
                    match spool::spool_text(&self.dir, &body, when).await {
                        Ok(path) => files.push(path.display().to_string()),
                        Err(spool_error) => {
                            let message = format!(
                                "capture spool failed; batch was not saved: Error: {spool_error}"
                            );
                            self.emit(&message);
                            return Ok(WriteOutcome::NotSaved { error: message });
                        }
                    }
                }
            }
        }
        if let Some(file) = files.first() {
            return Ok(WriteOutcome::Spooled {
                file: file.clone(),
                files,
            });
        }
        Ok(WriteOutcome::Delivered {
            ok: true,
            conversation_id,
            inserted,
            skipped,
        })
    }

    fn prepare_messages(&self, messages: Vec<CaptureMessage>) -> Vec<CaptureMessage> {
        let Some(redaction) = &self.redaction else {
            return messages.into_iter().map(cap_message).collect();
        };
        let mut spans = 0usize;
        let redacted = messages
            .into_iter()
            .map(|message| {
                let (next, count) = redaction::redact_message(message, redaction);
                spans += count;
                next
            })
            .map(cap_message)
            .collect();
        if spans > 0 {
            self.emit(&format!("redacted {spans} spans"));
        }
        redacted
    }

    async fn replay_one(&self, file: &str) -> ReplayStep {
        let path = self.dir.join(file);
        let body = match tokio::fs::read_to_string(&path).await {
            Ok(body) => body,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ReplayStep::Continue;
            }
            Err(error) => {
                self.emit(
                    &CaptureError::Io(format!("Error: {error}: {}", path.display())).log_line(),
                );
                return ReplayStep::Stop;
            }
        };
        match self.post(body).await {
            Ok(_) => match tokio::fs::remove_file(&path).await {
                Ok(()) => ReplayStep::Replayed,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => ReplayStep::Continue,
                Err(error) => {
                    self.emit(&CaptureError::Io(error.to_string()).log_line());
                    ReplayStep::Stop
                }
            },
            Err(error) => {
                self.emit(&error.log_line());
                let refused_old =
                    error.is_token_refused() && older_than(&path, SPOOL_REFUSED_MAX_AGE_MS).await;
                if error.is_client() || refused_old {
                    match spool::dead_letter(&self.dir, file).await {
                        Ok(()) => ReplayStep::Dead,
                        Err(dead_error) => {
                            self.emit(&CaptureError::Io(dead_error.to_string()).log_line());
                            ReplayStep::Stop
                        }
                    }
                } else {
                    ReplayStep::Stop
                }
            }
        }
    }

    async fn post(&self, body: String) -> Result<CaptureResult, CaptureError> {
        if let Some(exchange) = &self.exchange {
            let reply = exchange(&body).map_err(CaptureError::Transport)?;
            return classify_response(self.user.is_some(), reply);
        }
        let client = self.client().await?;
        let mut request = client
            .post(capture_endpoint(&self.den_url))
            .header(CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(user) = &self.user {
            let value = HeaderValue::from_str(&user.token)
                .map_err(|error| CaptureError::Transport(error.to_string()))?;
            request = request.header("x-rivetos-user-token", value);
        }
        let response = request
            .send()
            .await
            .map_err(|error| CaptureError::Transport(error.to_string()))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            drop(response);
            return classify_response(
                self.user.is_some(),
                HttpReply {
                    status,
                    body: String::new(),
                },
            );
        }
        let text = response
            .text()
            .await
            .map_err(|error| CaptureError::Transport(error.to_string()))?;
        classify_response(self.user.is_some(), HttpReply { status, body: text })
    }

    async fn client(&self) -> Result<reqwest::Client, CaptureError> {
        let ca_path = if crate::den_url::den_scheme_is_https(&self.den_url) {
            self.ca_path.clone()
        } else {
            None
        };
        let timeout = self.timeout;
        self.client
            .get_or_try_init(|| async move {
                let pem = match ca_path {
                    Some(path) => Some(
                        tokio::task::spawn_blocking(move || std::fs::read(path))
                            .await
                            .map_err(|error| CaptureError::Transport(error.to_string()))?
                            .map_err(|error| CaptureError::Transport(error.to_string()))?,
                    ),
                    None => None,
                };
                build_client(pem, timeout)
            })
            .await
            .cloned()
    }

    fn emit(&self, line: &str) {
        let Some(callback) = &self.log else {
            return;
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(line)));
    }
}

enum ReplayStep {
    Replayed,
    Dead,
    Continue,
    Stop,
}

fn classify_response(has_user: bool, reply: HttpReply) -> Result<CaptureResult, CaptureError> {
    let status = reply.status;
    if !(200..300).contains(&status) {
        if has_user && matches!(status, 401 | 403 | 503) {
            return Err(CaptureError::TokenRefused { status });
        }
        if (400..500).contains(&status) {
            return Err(CaptureError::Client { status });
        }
        return Err(CaptureError::Server { status });
    }
    serde_json::from_str(&reply.body).map_err(|error| CaptureError::Transport(error.to_string()))
}

fn capture_endpoint(den_url: &str) -> String {
    let base = den_url.strip_suffix('/').unwrap_or(den_url);
    format!("{base}/api/capture")
}

fn build_client(pem: Option<Vec<u8>>, timeout: Duration) -> Result<reqwest::Client, CaptureError> {
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0);
    if let Some(bytes) = pem {
        for certificate in pem_certificates(&bytes) {
            let parsed = reqwest::Certificate::from_pem(&certificate)
                .map_err(|error| CaptureError::Transport(error.to_string()))?;
            builder = builder.add_root_certificate(parsed);
        }
    }
    builder
        .build()
        .map_err(|error| CaptureError::Transport(error.to_string()))
}

fn pem_certificates(bytes: &[u8]) -> Vec<Vec<u8>> {
    let text = String::from_utf8_lossy(bytes);
    let mut certs = Vec::new();
    let mut rest = text.as_ref();
    while let Some(start) = rest.find("-----BEGIN ") {
        let Some(end_rel) = rest[start..].find("-----END ") else {
            break;
        };
        let after = &rest[start + end_rel..];
        let Some(line_end) = after
            .find('\n')
            .or_else(|| after.contains("-----").then_some(after.len()))
        else {
            break;
        };
        let end = start + end_rel + line_end;
        let slice_end = end.min(rest.len());
        certs.push(rest.as_bytes()[start..slice_end].to_vec());
        rest = &rest[end.min(rest.len())..];
    }
    if certs.is_empty() && !bytes.is_empty() {
        certs.push(bytes.to_vec());
    }
    certs
}

async fn older_than(path: &Path, max_age_ms: u64) -> bool {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    let Ok(age) = modified.elapsed() else {
        return false;
    };
    age.as_millis() > u128::from(max_age_ms)
}

fn cap_message(message: CaptureMessage) -> CaptureMessage {
    let content = helpers::cap_field(&message.content);
    let tool = message
        .tool_result
        .as_ref()
        .map(|text| helpers::cap_field(text));
    let tool_truncated = tool.as_ref().is_some_and(|item| item.truncated);
    if !content.truncated && !tool_truncated {
        return message;
    }
    let mut metadata = message.metadata.clone().unwrap_or_default();
    if content.truncated {
        metadata.insert(
            "full_content_length".to_string(),
            json_usize(content.full_length),
        );
    }
    if tool_truncated && let Some(tool) = &tool {
        metadata.insert(
            "full_tool_result_length".to_string(),
            json_usize(tool.full_length),
        );
    }
    metadata.insert("truncated".to_string(), Value::Bool(true));
    let mut next = message;
    next.content = content.text;
    if let Some(tool) = tool {
        next.tool_result = Some(tool.text);
    }
    next.metadata = Some(metadata);
    next
}

fn json_usize(value: usize) -> Value {
    Value::from(u64::try_from(value).unwrap_or(u64::MAX))
}

#[derive(Clone)]
struct Tracked {
    message: CaptureMessage,
    args_done: bool,
    meta_done: bool,
}

fn split_chunks(batch: CaptureBatch, limit: usize, log: &Option<LogFn>) -> Vec<CaptureBatch> {
    let mut batch = batch;
    if batch.settings.is_some()
        && encoded_len(&chunk_for(&batch, Vec::new(), true)) > limit
        && let Some(settings) = &batch.settings
    {
        let bytes = json_utf8_len(settings);
        emit(log, &format!("elided settings ({bytes} bytes)"));
        batch.settings = Some(elided_value(bytes));
    }
    if batch.messages.is_empty() {
        return vec![chunk_for(&batch, Vec::new(), true)];
    }
    let messages: Vec<Tracked> = batch
        .messages
        .iter()
        .cloned()
        .map(|message| Tracked {
            message,
            args_done: false,
            meta_done: false,
        })
        .collect();
    let mut groups: Vec<Vec<Tracked>> = Vec::new();
    let mut current: Vec<Tracked> = Vec::new();
    for original in messages {
        let alone = message_fits(&batch, &original.message, false, limit)
            || message_fits(&batch, &original.message, true, limit);
        let message = if alone {
            original
        } else {
            elide_tool_args(original, log)
        };
        let solo = !alone;
        let overflows = !current.is_empty()
            && !fits_messages(
                &batch,
                &current,
                std::slice::from_ref(&message),
                false,
                limit,
            );
        if solo || overflows {
            push_group(&mut groups, &mut current);
            current.push(message);
            if solo {
                push_group(&mut groups, &mut current);
            }
            continue;
        }
        current.push(message);
    }
    push_group(&mut groups, &mut current);
    let guard_limit = groups.iter().map(|group| group.len()).sum::<usize>() + 2;
    let mut guard = 0usize;
    while guard < guard_limit && !groups.is_empty() {
        guard += 1;
        let last_index = groups.len() - 1;
        if fits_group(&batch, &groups[last_index], true, limit) {
            break;
        }
        if groups[last_index].len() <= 1 {
            let only = match groups[last_index].first() {
                Some(only) => only.clone(),
                None => break,
            };
            let next = shrink_singleton(only.clone(), true, &batch, limit, log);
            if same_tracked(&only, &next) {
                break;
            }
            groups[last_index][0] = next;
            continue;
        }
        match groups[last_index].pop() {
            Some(peeled) => groups.push(vec![peeled]),
            None => break,
        }
    }
    let group_count = groups.len();
    for (index, group) in groups.iter_mut().enumerate().take(group_count) {
        if group.len() != 1 {
            continue;
        }
        let is_last = index + 1 == group_count;
        if fits_group(&batch, group, is_last, limit) {
            continue;
        }
        let only = group[0].clone();
        *group = vec![shrink_singleton(only, is_last, &batch, limit, log)];
    }
    groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let messages = group.into_iter().map(|item| item.message).collect();
            chunk_for(&batch, messages, index + 1 == group_count)
        })
        .collect()
}

fn push_group(groups: &mut Vec<Vec<Tracked>>, current: &mut Vec<Tracked>) {
    if current.is_empty() {
        return;
    }
    groups.push(std::mem::take(current));
}

fn same_tracked(left: &Tracked, right: &Tracked) -> bool {
    left.args_done == right.args_done
        && left.meta_done == right.meta_done
        && message_wire(&left.message) == message_wire(&right.message)
}

fn message_wire(message: &CaptureMessage) -> Option<String> {
    serde_json::to_value(message)
        .ok()
        .map(|value| protocol::js::stringify(&value))
}

fn shrink_singleton(
    mut current: Tracked,
    is_last: bool,
    batch: &CaptureBatch,
    limit: usize,
    log: &Option<LogFn>,
) -> Tracked {
    if message_fits(batch, &current.message, is_last, limit) {
        return current;
    }
    if !current.args_done {
        current = elide_tool_args(current, log);
    }
    if message_fits(batch, &current.message, is_last, limit) {
        return current;
    }
    if !current.meta_done {
        current = elide_metadata(current, log);
    }
    current
}

fn elide_tool_args(current: Tracked, log: &Option<LogFn>) -> Tracked {
    if current.args_done {
        return current;
    }
    if current.message.tool_args.is_none() {
        let mut next = current;
        next.args_done = true;
        return next;
    }
    let Some(tool_args) = current.message.tool_args.clone() else {
        return current;
    };
    let bytes = json_utf8_len(&tool_args);
    emit(
        log,
        &format!(
            "elided tool_args for event {} ({bytes} bytes)",
            current.message.event_id
        ),
    );
    let mut metadata = current.message.metadata.clone().unwrap_or_default();
    metadata.insert("full_tool_args_length".to_string(), json_usize(bytes));
    let mut message = current.message;
    message.tool_args = Some(elided_value(bytes));
    message.metadata = Some(metadata);
    Tracked {
        message,
        args_done: true,
        meta_done: current.meta_done,
    }
}

fn elide_metadata(current: Tracked, log: &Option<LogFn>) -> Tracked {
    if current.meta_done {
        return current;
    }
    let metadata = current.message.metadata.clone().unwrap_or_default();
    let bytes = json_utf8_len(&metadata);
    emit(
        log,
        &format!(
            "elided metadata for event {} ({bytes} bytes)",
            current.message.event_id
        ),
    );
    let mut kept = Map::new();
    for (key, value) in &metadata {
        if keep_metadata_key(key) {
            kept.insert(key.clone(), value.clone());
        }
    }
    kept.insert("metadata_elided".to_string(), Value::Bool(true));
    kept.insert("full_metadata_bytes".to_string(), json_usize(bytes));
    let mut message = current.message;
    message.metadata = Some(kept);
    Tracked {
        message,
        args_done: true,
        meta_done: true,
    }
}

fn elided_value(bytes: usize) -> Value {
    let mut map = Map::new();
    map.insert("_elided".to_string(), Value::Bool(true));
    map.insert("bytes".to_string(), json_usize(bytes));
    Value::Object(map)
}

fn message_fits(
    batch: &CaptureBatch,
    message: &CaptureMessage,
    is_last: bool,
    limit: usize,
) -> bool {
    encoded_len(&chunk_for(batch, vec![message.clone()], is_last)) <= limit
}

fn fits_messages(
    batch: &CaptureBatch,
    current: &[Tracked],
    extra: &[Tracked],
    is_last: bool,
    limit: usize,
) -> bool {
    let mut messages = current
        .iter()
        .map(|item| item.message.clone())
        .collect::<Vec<_>>();
    messages.extend(extra.iter().map(|item| item.message.clone()));
    encoded_len(&chunk_for(batch, messages, is_last)) <= limit
}

fn fits_group(batch: &CaptureBatch, group: &[Tracked], is_last: bool, limit: usize) -> bool {
    let messages = group.iter().map(|item| item.message.clone()).collect();
    encoded_len(&chunk_for(batch, messages, is_last)) <= limit
}

fn chunk_for(batch: &CaptureBatch, messages: Vec<CaptureMessage>, is_last: bool) -> CaptureBatch {
    let mut out = batch.clone();
    out.messages = messages;
    if !is_last && out.finalize.is_some() {
        out.finalize = None;
    }
    out
}

fn encoded_len(batch: &CaptureBatch) -> usize {
    match serde_json::to_value(batch) {
        Ok(value) => protocol::js::stringify(&value).len(),
        Err(_) => usize::MAX,
    }
}

fn empty_batch() -> CaptureBatch {
    CaptureBatch {
        session_key: String::new(),
        agent: String::new(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: Vec::new(),
    }
}

fn project_chunk(original: &Map<String, Value>, chunk: &CaptureBatch, is_last: bool) -> Value {
    let mut out = if original.is_empty() {
        serde_json::to_value(chunk)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    } else {
        original.clone()
    };
    if !is_last || chunk.finalize.is_none() {
        out.shift_remove("finalize");
    } else if let Some(flag) = chunk.finalize {
        out.insert("finalize".to_string(), Value::Bool(flag));
    }
    match &chunk.settings {
        Some(value) => {
            out.insert("settings".to_string(), value.clone());
        }
        None => {
            out.shift_remove("settings");
        }
    }
    let messages = chunk
        .messages
        .iter()
        .map(|message| serde_json::to_value(message).unwrap_or(Value::Null))
        .collect();
    out.insert("messages".to_string(), Value::Array(messages));
    Value::Object(out)
}

fn emit(log: &Option<LogFn>, line: &str) {
    let Some(callback) = log else {
        return;
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(line)));
}
