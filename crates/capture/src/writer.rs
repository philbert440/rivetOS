use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::error::{CaptureError, ReplayReport, WriteOutcome};
use crate::helpers::CONTENT_LIMIT;
use crate::redaction::{self, ResolvedCaptureRedaction, keep_metadata_key};
use crate::spool;
use crate::timeutil;
use crate::transport::{self, CaptureUser};
use crate::types::{
    CaptureBatch, CaptureResult, CaptureWriterOptions, HttpReply, LogFn, UserSource,
};
use crate::wire;
use protocol::host::Env;
use protocol::js::{JsObject, JsString, JsValue};
use reqwest::header::{CONTENT_TYPE, HeaderValue, LOCATION};
use tokio::sync::OnceCell;

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

pub fn create_capture_writer(opts: CaptureWriterOptions) -> Result<CaptureWriter, CaptureError> {
    let user = match &opts.user {
        UserSource::FromEnv => transport::capture_user_from_env(opts.env.as_ref())?,
        UserSource::Owner => None,
        UserSource::Routed(user) => Some(user.clone()),
    };
    let dir = match &opts.spool_dir {
        Some(dir) => dir.clone(),
        None => spool_dir_for(opts.env.as_ref(), user.as_ref())?,
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

fn spool_dir_for(env: &dyn Env, user: Option<&CaptureUser>) -> Result<PathBuf, CaptureError> {
    spool_dir_from(protocol::host::home_dir(env), user)
}

fn spool_dir_from(
    home: Option<String>,
    user: Option<&CaptureUser>,
) -> Result<PathBuf, CaptureError> {
    let home = home.ok_or_else(|| CaptureError::Io(crate::error::HOMEDIR_MISSING.to_string()))?;
    let root = PathBuf::from(home);
    Ok(match user {
        Some(user) => root
            .join(".rivetos")
            .join("capture-spool-users")
            .join(spool_name_for(&user.id)),
        None => root.join(".rivetos").join("capture-spool"),
    })
}

pub fn spool_name_for(user_id: &str) -> String {
    let hex = protocol::digest::sha256_hex(user_id.as_bytes());
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
        self.write_value(wire::batch_to_js(&batch)).await
    }

    pub async fn write_value(&self, mut batch: JsValue) -> Result<WriteOutcome, CaptureError> {
        self.replay(ReplayOptions { max: Some(50.0) }).await;
        if batch.as_object().is_none() {
            batch = wire::batch_to_js(&empty_batch());
        }
        prepare_batch(&mut batch, self.redaction.as_ref(), &self.log);
        let chunks = split_chunks(&mut batch, self.max_chunk_bytes, &self.log);
        let base = (self.now_ms)();
        let mut inserted = 0u64;
        let mut skipped = 0u64;
        let mut conversation_id = String::new();
        let mut files = Vec::new();
        for (index, chunk) in chunks.iter().enumerate() {
            let body = protocol::js::stringify(chunk);
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

    async fn replay_one(&self, file: &str) -> ReplayStep {
        let path = self.dir.join(file);
        let read_path = path.clone();
        let loaded =
            tokio::task::spawn_blocking(move || protocol::host::read_text(&read_path)).await;
        let body = match loaded {
            Ok(Ok(body)) => body,
            Ok(Err(error)) if error.code == "ENOENT" => return ReplayStep::Continue,
            Ok(Err(error)) => {
                self.emit(&replay_read_line(&error, &path));
                return ReplayStep::Stop;
            }
            Err(error) => {
                self.emit(&replay_read_line(&error, &path));
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
        let mut url = capture_endpoint(&self.den_url);
        let mut method_post = true;
        let mut payload = Some(body);
        let mut followed = 0u32;
        loop {
            let mut request = if method_post {
                client.post(&url)
            } else {
                client.get(&url)
            };
            if method_post {
                request = request.header(CONTENT_TYPE, "application/json");
                if let Some(payload) = payload.clone() {
                    request = request.body(payload);
                }
            }
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
            if !is_redirect(status) {
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
                return classify_response(self.user.is_some(), HttpReply { status, body: text });
            }
            if followed >= 20 {
                return Err(CaptureError::Transport(
                    "maximum redirect reached".to_string(),
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            drop(response);
            let Some(location) = location.filter(|value| !value.is_empty()) else {
                return classify_response(
                    self.user.is_some(),
                    HttpReply {
                        status,
                        body: String::new(),
                    },
                );
            };
            url = resolve_redirect(&url, &location)?;
            followed += 1;
            if method_post && matches!(status, 301..=303) {
                method_post = false;
                payload = None;
            }
        }
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

fn replay_read_line(error: &impl std::fmt::Display, path: &Path) -> String {
    CaptureError::Io(format!("Error: {error}: {}", path.display())).log_line()
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

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn resolve_redirect(current: &str, location: &str) -> Result<String, CaptureError> {
    let base =
        url::Url::parse(current).map_err(|error| CaptureError::Transport(error.to_string()))?;
    let mut next = base
        .join(location)
        .map_err(|error| CaptureError::Transport(error.to_string()))?;
    next.set_fragment(None);
    if next.scheme() != "http" && next.scheme() != "https" {
        return Err(CaptureError::Transport(format!(
            "unsupported protocol {}:{}",
            next.scheme(),
            next.as_str()
        )));
    }
    Ok(next.to_string())
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

struct CappedUnits {
    text: Vec<u16>,
    truncated: bool,
    full_length: usize,
}

fn cap_units(units: &[u16]) -> CappedUnits {
    let full_length = units.len();
    if full_length <= CONTENT_LIMIT {
        return CappedUnits {
            text: units.to_vec(),
            truncated: false,
            full_length,
        };
    }
    let mut cut = CONTENT_LIMIT;
    if cut > 0 && (0xD800..=0xDBFF).contains(&units[cut - 1]) {
        cut -= 1;
    }
    CappedUnits {
        text: units[..cut].to_vec(),
        truncated: true,
        full_length,
    }
}

fn string_units(value: Option<&JsValue>) -> Option<Vec<u16>> {
    value
        .and_then(JsValue::as_js_string)
        .map(|text| text.units().to_vec())
}

fn cap_message_js(message: JsValue) -> JsValue {
    let Some(object) = message.as_object() else {
        return message;
    };
    let content = string_units(object.get("content")).map(|units| cap_units(&units));
    let tool = match object.get("tool_result") {
        Some(JsValue::String(text)) => Some(cap_units(text.units())),
        _ => None,
    };
    let content_truncated = content.as_ref().is_some_and(|item| item.truncated);
    let tool_truncated = tool.as_ref().is_some_and(|item| item.truncated);
    if !content_truncated && !tool_truncated {
        return message;
    }
    let mut metadata = spread_metadata(object.get("metadata"));
    if content_truncated && let Some(item) = &content {
        metadata.insert(
            wire::key("full_content_length"),
            wire::number_value(item.full_length),
        );
    }
    if tool_truncated && let Some(item) = &tool {
        metadata.insert(
            wire::key("full_tool_result_length"),
            wire::number_value(item.full_length),
        );
    }
    metadata.insert(wire::key("truncated"), JsValue::Bool(true));
    let mut next = message;
    if let Some(item) = content {
        insert_field(
            &mut next,
            "content",
            JsValue::String(JsString::from_units(item.text)),
        );
    }
    if let Some(item) = tool {
        insert_field(
            &mut next,
            "tool_result",
            JsValue::String(JsString::from_units(item.text)),
        );
    }
    insert_field(&mut next, "metadata", JsValue::Object(metadata));
    next
}

fn spread_metadata(value: Option<&JsValue>) -> JsObject {
    match value {
        Some(JsValue::Object(object)) => object.clone(),
        Some(JsValue::Array(items)) => {
            let mut object = JsObject::new();
            for (index, item) in items.iter().enumerate() {
                object.insert(JsString::from_text(&index.to_string()), item.clone());
            }
            object
        }
        _ => JsObject::new(),
    }
}

fn insert_field(message: &mut JsValue, name: &str, value: JsValue) {
    if let Some(object) = message.as_object_mut() {
        object.insert(JsString::from_text(name), value);
    }
}

fn field_text(message: &JsValue, name: &str) -> String {
    message
        .get(name)
        .and_then(JsValue::as_str)
        .unwrap_or("")
        .to_string()
}

fn prepare_batch(
    batch: &mut JsValue,
    redaction: Option<&ResolvedCaptureRedaction>,
    log: &Option<LogFn>,
) {
    let Some(messages) = batch
        .get("messages")
        .and_then(JsValue::as_array)
        .map(|items| items.to_vec())
    else {
        return;
    };
    let mut spans = 0usize;
    let mut prepared = Vec::with_capacity(messages.len());
    for message in messages {
        let next = if let Some(redaction) = redaction {
            let (redacted, count) = redaction::redact_message_js(message, redaction);
            spans += count;
            redacted
        } else {
            message
        };
        prepared.push(cap_message_js(next));
    }
    if spans > 0 {
        emit(log, &format!("redacted {spans} spans"));
    }
    insert_field(batch, "messages", JsValue::Array(prepared));
}

#[derive(Clone)]
struct Tracked {
    message: JsValue,
    wire_len: usize,
    args_done: bool,
    meta_done: bool,
}

struct Shell {
    with_finalize: usize,
    without_finalize: usize,
}

fn track(message: JsValue) -> Tracked {
    let wire_len = protocol::js::stringify(&message).len();
    Tracked {
        message,
        wire_len,
        args_done: false,
        meta_done: false,
    }
}

fn retarget(mut tracked: Tracked) -> Tracked {
    tracked.wire_len = protocol::js::stringify(&tracked.message).len();
    tracked
}

fn shell_lengths(batch: &JsValue) -> Shell {
    let with_finalize = protocol::js::stringify(&project_chunk(batch, &[], true)).len();
    let without_finalize = if batch.get("finalize").is_some() {
        protocol::js::stringify(&project_chunk(batch, &[], false)).len()
    } else {
        with_finalize
    };
    Shell {
        with_finalize,
        without_finalize,
    }
}

fn chunk_len_parts(base: usize, sum: usize, count: usize) -> usize {
    if count == 0 {
        base
    } else {
        base + sum + count - 1
    }
}

fn chunk_len(base: usize, lengths: &[usize]) -> usize {
    chunk_len_parts(base, lengths.iter().sum(), lengths.len())
}

fn totals_fit(shell: &Shell, sum: usize, count: usize, is_last: bool, limit: usize) -> bool {
    let base = if is_last {
        shell.with_finalize
    } else {
        shell.without_finalize
    };
    chunk_len_parts(base, sum, count) <= limit
}

fn lengths_fit(shell: &Shell, lengths: &[usize], is_last: bool, limit: usize) -> bool {
    let base = if is_last {
        shell.with_finalize
    } else {
        shell.without_finalize
    };
    chunk_len(base, lengths) <= limit
}

fn split_chunks(batch: &mut JsValue, limit: usize, log: &Option<LogFn>) -> Vec<JsValue> {
    if batch.get("settings").is_some() && !lengths_fit(&shell_lengths(batch), &[], true, limit) {
        let bytes = batch
            .get("settings")
            .map(|value| protocol::js::stringify(value).len())
            .unwrap_or(0);
        emit(log, &format!("elided settings ({bytes} bytes)"));
        insert_field(batch, "settings", elided_value(bytes));
    }
    let shell = shell_lengths(batch);
    let messages = batch
        .get("messages")
        .and_then(JsValue::as_array)
        .map(|items| items.to_vec())
        .unwrap_or_default();
    if messages.is_empty() {
        return vec![project_chunk(batch, &[], true)];
    }
    let messages: Vec<Tracked> = messages.into_iter().map(track).collect();
    let mut groups: Vec<ChunkGroup> = Vec::new();
    let mut current = ChunkGroup::new();
    for original in messages {
        let alone = lengths_fit(&shell, &[original.wire_len], false, limit)
            || lengths_fit(&shell, &[original.wire_len], true, limit);
        let message = if alone {
            original
        } else {
            elide_tool_args(original, log)
        };
        let solo = !alone;
        let overflows =
            !current.is_empty() && !current.fits_plus(message.wire_len, &shell, false, limit);
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
        if groups[last_index].fits(&shell, true, limit) {
            break;
        }
        if groups[last_index].len() <= 1 {
            let Some(only) = groups[last_index].first().cloned() else {
                break;
            };
            let next = shrink_singleton(only.clone(), true, &shell, limit, log);
            if same_tracked(&only, &next) {
                break;
            }
            groups[last_index].set_only(next);
            continue;
        }
        match groups[last_index].pop() {
            Some(peeled) => {
                let mut peeled_group = ChunkGroup::new();
                peeled_group.push(peeled);
                groups.push(peeled_group);
            }
            None => break,
        }
    }
    let group_count = groups.len();
    for (index, group) in groups.iter_mut().enumerate().take(group_count) {
        if group.len() != 1 {
            continue;
        }
        let is_last = index + 1 == group_count;
        if group.fits(&shell, is_last, limit) {
            continue;
        }
        let Some(only) = group.first().cloned() else {
            continue;
        };
        group.set_only(shrink_singleton(only, is_last, &shell, limit, log));
    }
    groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let messages: Vec<JsValue> = group.items.into_iter().map(|item| item.message).collect();
            project_chunk(batch, &messages, index + 1 == group_count)
        })
        .collect()
}

struct ChunkGroup {
    items: Vec<Tracked>,
    sum: usize,
}

impl ChunkGroup {
    fn new() -> Self {
        Self {
            items: Vec::new(),
            sum: 0,
        }
    }

    fn len(&self) -> usize {
        self.items.len()
    }

    fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    fn first(&self) -> Option<&Tracked> {
        self.items.first()
    }

    fn push(&mut self, item: Tracked) {
        self.sum += item.wire_len;
        self.items.push(item);
    }

    fn pop(&mut self) -> Option<Tracked> {
        let item = self.items.pop()?;
        self.sum -= item.wire_len;
        Some(item)
    }

    fn set_only(&mut self, item: Tracked) {
        self.sum = item.wire_len;
        self.items.clear();
        self.items.push(item);
    }

    fn fits(&self, shell: &Shell, is_last: bool, limit: usize) -> bool {
        totals_fit(shell, self.sum, self.len(), is_last, limit)
    }

    fn fits_plus(&self, extra: usize, shell: &Shell, is_last: bool, limit: usize) -> bool {
        totals_fit(shell, self.sum + extra, self.len() + 1, is_last, limit)
    }
}

fn push_group(groups: &mut Vec<ChunkGroup>, current: &mut ChunkGroup) {
    if current.is_empty() {
        return;
    }
    groups.push(ChunkGroup {
        items: std::mem::take(&mut current.items),
        sum: std::mem::take(&mut current.sum),
    });
}

fn same_tracked(left: &Tracked, right: &Tracked) -> bool {
    left.args_done == right.args_done
        && left.meta_done == right.meta_done
        && message_wire(&left.message) == message_wire(&right.message)
}

fn message_wire(message: &JsValue) -> String {
    protocol::js::stringify(message)
}

fn shrink_singleton(
    mut current: Tracked,
    is_last: bool,
    shell: &Shell,
    limit: usize,
    log: &Option<LogFn>,
) -> Tracked {
    if lengths_fit(shell, &[current.wire_len], is_last, limit) {
        return current;
    }
    if !current.args_done {
        current = elide_tool_args(current, log);
    }
    if lengths_fit(shell, &[current.wire_len], is_last, limit) {
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
    if current.message.get("tool_args").is_none() {
        let mut next = current;
        next.args_done = true;
        return next;
    }
    let Some(tool_args) = current.message.get("tool_args").cloned() else {
        return current;
    };
    let bytes = protocol::js::stringify(&tool_args).len();
    emit(
        log,
        &format!(
            "elided tool_args for event {} ({bytes} bytes)",
            field_text(&current.message, "event_id")
        ),
    );
    let mut metadata = spread_metadata(current.message.get("metadata"));
    metadata.insert(
        wire::key("full_tool_args_length"),
        wire::number_value(bytes),
    );
    let mut message = current.message;
    insert_field(&mut message, "tool_args", elided_value(bytes));
    insert_field(&mut message, "metadata", JsValue::Object(metadata));
    retarget(Tracked {
        message,
        wire_len: 0,
        args_done: true,
        meta_done: current.meta_done,
    })
}

fn elide_metadata(current: Tracked, log: &Option<LogFn>) -> Tracked {
    if current.meta_done {
        return current;
    }
    let source = match current.message.get("metadata") {
        Some(JsValue::Null) | None => JsValue::Object(JsObject::new()),
        Some(value) => value.clone(),
    };
    let bytes = protocol::js::stringify(&source).len();
    emit(
        log,
        &format!(
            "elided metadata for event {} ({bytes} bytes)",
            field_text(&current.message, "event_id")
        ),
    );
    let metadata = spread_metadata(current.message.get("metadata"));
    let mut kept = JsObject::new();
    for (name, value) in metadata.iter() {
        if keep_metadata_key(name.to_utf8()) {
            kept.insert(name.clone(), value.clone());
        }
    }
    kept.insert(wire::key("metadata_elided"), JsValue::Bool(true));
    kept.insert(wire::key("full_metadata_bytes"), wire::number_value(bytes));
    let mut message = current.message;
    insert_field(&mut message, "metadata", JsValue::Object(kept));
    retarget(Tracked {
        message,
        wire_len: 0,
        args_done: true,
        meta_done: true,
    })
}

fn elided_value(bytes: usize) -> JsValue {
    let mut map = JsObject::new();
    map.insert(wire::key("_elided"), JsValue::Bool(true));
    map.insert(wire::key("bytes"), wire::number_value(bytes));
    JsValue::Object(map)
}

fn project_chunk(batch: &JsValue, messages: &[JsValue], is_last: bool) -> JsValue {
    let Some(object) = batch.as_object() else {
        return JsValue::Object(JsObject::new());
    };
    let mut out = JsObject::new();
    let mut saw_messages = false;
    for (name, value) in object.iter() {
        if !is_last && name.to_utf8() == "finalize" {
            continue;
        }
        if name.to_utf8() == "messages" {
            saw_messages = true;
            out.insert(name.clone(), JsValue::Array(messages.to_vec()));
        } else {
            out.insert(name.clone(), value.clone());
        }
    }
    if !saw_messages {
        out.insert(wire::key("messages"), JsValue::Array(messages.to_vec()));
    }
    JsValue::Object(out)
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

fn emit(log: &Option<LogFn>, line: &str) {
    let Some(callback) = log else {
        return;
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(line)));
}

#[cfg(test)]
mod chunk_math {
    use super::{chunk_len, project_chunk, shell_lengths};

    #[test]
    fn sized_chunks_match_stringify() {
        let batch = protocol::js::parse(
            r#"{"session_key":"s","agent":"a","finalize":true,"settings":{"k":1},"messages":[{"event_id":"1","content":"hi"},{"event_id":"2","content":"yo, there"},{"event_id":"3","content":"end"}],"z":false}"#,
        )
        .unwrap();
        let shell = shell_lengths(&batch);
        let messages = batch
            .get("messages")
            .and_then(|value| value.as_array())
            .unwrap();
        let lengths: Vec<usize> = messages
            .iter()
            .map(|message| protocol::js::stringify(message).len())
            .collect();
        for is_last in [false, true] {
            let base = if is_last {
                shell.with_finalize
            } else {
                shell.without_finalize
            };
            for end in 0..=lengths.len() {
                let projected = project_chunk(&batch, &messages[..end], is_last);
                assert_eq!(
                    protocol::js::stringify(&projected).len(),
                    chunk_len(base, &lengths[..end]),
                    "is_last={is_last} end={end}"
                );
            }
        }
    }

    #[test]
    fn short_rows_split_on_the_running_total() {
        let mut messages = String::from("[");
        for index in 0..30 {
            if index > 0 {
                messages.push(',');
            }
            messages.push_str(&format!(
                r#"{{"event_id":"e{index:02}","role":"user","content":"hi"}}"#
            ));
        }
        messages.push(']');
        let raw =
            format!(r#"{{"session_key":"s","agent":"a","finalize":true,"messages":{messages}}}"#);
        let mut batch = protocol::js::parse(&raw).unwrap();
        let shell = shell_lengths(&batch);
        let tracked: Vec<usize> = batch
            .get("messages")
            .and_then(|value| value.as_array())
            .unwrap()
            .iter()
            .map(|message| protocol::js::stringify(message).len())
            .collect();
        let limit = chunk_len(shell.without_finalize, &tracked[..3]);
        let log = None;
        let chunks = super::split_chunks(&mut batch, limit, &log);
        let mut total = 0usize;
        let mut saw_full = false;
        for chunk in &chunks {
            let body = protocol::js::stringify(chunk);
            assert!(body.len() <= limit, "{}", body.len());
            let count = chunk
                .get("messages")
                .and_then(|value| value.as_array())
                .unwrap()
                .len();
            assert!(count > 0 && count <= 3);
            saw_full |= count == 3;
            total += count;
        }
        assert!(saw_full);
        assert_eq!(total, 30);
    }
}

#[cfg(test)]
mod spool_home {
    use std::path::PathBuf;

    use super::{spool_dir_for, spool_dir_from};
    use crate::error::{CaptureError, HOMEDIR_MISSING};
    use crate::transport::CaptureUser;

    #[test]
    fn spool_directory_follows_homedir() {
        assert!(matches!(
            spool_dir_from(None, None),
            Err(CaptureError::Io(message)) if message == HOMEDIR_MISSING
        ));
        assert_eq!(
            spool_dir_from(Some(String::new()), None).unwrap(),
            PathBuf::from(".rivetos").join("capture-spool")
        );
        let user = CaptureUser {
            id: "guest".to_string(),
            token: "tok".to_string(),
        };
        assert_eq!(
            spool_dir_from(Some("/home/example".to_string()), Some(&user)).unwrap(),
            PathBuf::from("/home/example/.rivetos/capture-spool-users")
                .join(super::spool_name_for("guest"))
        );
        let absent = protocol::host::MapEnv::new();
        let home = protocol::host::home_dir(&absent).unwrap();
        assert_eq!(
            spool_dir_for(&absent, None).unwrap(),
            PathBuf::from(home).join(".rivetos").join("capture-spool")
        );
    }
}
