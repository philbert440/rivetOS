use protocol::{JsNumber, LlmChunk, LlmUsage};
use serde_json::Value;

use crate::chunks::{done_chunk, error_chunk, reasoning_chunk, status_chunk, text_chunk};
use crate::error::ProviderError;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Claude,
    Codex,
    Grok,
    Hermes,
    Kimi,
    Opencode,
    Pi,
    Qwen,
}

pub struct Machine {
    family: Family,
    id: String,
    saw_text: bool,
    saw_text_delta: bool,
    saw_reason_delta: bool,
    saw_init: bool,
    resume_rejected: bool,
    allow_retry: bool,
    retried: bool,
    result_error: bool,
    saw_success: bool,
    saw_result: bool,
    recognized: u64,
    session_id: Option<String>,
    delete_session: bool,
    stop_reason: Option<String>,
    prompt_tokens: u64,
    completion_tokens: u64,
    reasoning_tokens: u64,
    cache_read: u64,
    cache_write: u64,
    saw_usage: bool,
    last_usage: Option<(u64, u64, u64)>,
    result_usage: Option<(u64, u64, u64)>,
    fallback_text: String,
    fallback_reason: String,
    fatal: Option<String>,
    grok_usage: GrokUsage,
}

#[derive(Default, Clone)]
struct GrokUsage {
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    reasoning: Option<u64>,
}

pub struct Finish {
    pub chunks: Vec<LlmChunk>,
    pub error: Option<ProviderError>,
    pub retry_qwen: bool,
    pub retry_grok: bool,
    pub session_id: Option<String>,
    pub delete_session: bool,
}

impl Machine {
    pub fn new(family: Family, id: impl Into<String>) -> Self {
        Self {
            family,
            id: id.into(),
            saw_text: false,
            saw_text_delta: false,
            saw_reason_delta: false,
            saw_init: false,
            resume_rejected: false,
            allow_retry: false,
            retried: false,
            result_error: false,
            saw_success: false,
            saw_result: false,
            recognized: 0,
            session_id: None,
            delete_session: false,
            stop_reason: None,
            prompt_tokens: 0,
            completion_tokens: 0,
            reasoning_tokens: 0,
            cache_read: 0,
            cache_write: 0,
            saw_usage: false,
            last_usage: None,
            result_usage: None,
            fallback_text: String::new(),
            fallback_reason: String::new(),
            fatal: None,
            grok_usage: GrokUsage::default(),
        }
    }

    pub fn arm_retry(&mut self, allow: bool) {
        self.allow_retry = allow;
        self.saw_init = false;
        self.resume_rejected = false;
    }

    pub fn mark_retried(&mut self) {
        self.retried = true;
        self.allow_retry = false;
        self.recognized = 0;
        self.saw_result = false;
        self.fallback_text.clear();
        self.fallback_reason.clear();
        self.fatal = None;
        self.stop_reason = None;
        self.grok_usage = GrokUsage::default();
        self.saw_usage = false;
        self.session_id = None;
    }

    pub fn push_line(&mut self, line: &str) -> (Vec<LlmChunk>, Option<ProviderError>) {
        match self.family {
            Family::Pi => (self.push_pi(line), None),
            Family::Qwen => (self.push_qwen(line), None),
            Family::Opencode => (self.push_opencode(line), None),
            Family::Grok => self.push_grok(line),
            Family::Claude => self.push_claude(line),
            Family::Codex => (self.push_codex(line), None),
            Family::Kimi => (self.push_kimi(line), None),
            Family::Hermes => {
                self.saw_text = true;
                (vec![text_chunk(line)], None)
            }
        }
    }

    pub fn finish(&mut self, code: Option<i32>, stderr: &str, stdout: &str) -> Finish {
        let retry_qwen = self.family == Family::Qwen
            && self.allow_retry
            && !self.retried
            && !self.saw_init
            && self.resume_rejected;
        let mut chunks = Vec::new();
        let mut error = None;
        match self.family {
            Family::Pi => chunks.extend(self.finish_pi(code, stderr)),
            Family::Qwen => {
                if !retry_qwen {
                    chunks.extend(self.finish_qwen(code, stderr));
                }
            }
            Family::Opencode => chunks.extend(self.finish_opencode(code, stderr, stdout)),
            Family::Grok => error = self.finish_grok(code, stderr, stdout, &mut chunks),
            Family::Claude => error = self.finish_claude(code, stderr, &mut chunks),
            Family::Hermes | Family::Codex | Family::Kimi => {
                if !self.saw_text && self.family == Family::Hermes && !stdout.trim().is_empty() {
                    self.saw_text = true;
                    chunks.push(text_chunk(stdout.trim()));
                }
                if !self.saw_text && code != Some(0) {
                    error = Some(self.fail_plain(code, stderr));
                }
            }
        }
        Finish {
            chunks,
            error,
            retry_qwen,
            retry_grok: self.family == Family::Grok
                && self.allow_retry
                && !self.retried
                && code != Some(0)
                && !self.saw_text
                && !self.saw_reason_delta,
            session_id: self.session_id.clone(),
            delete_session: self.delete_session,
        }
    }

    fn push_codex(&mut self, line: &str) -> Vec<LlmChunk> {
        let Some(value) = crate::cli::parse_codex_line(line) else {
            return Vec::new();
        };
        let Some(text) = crate::cli::codex_agent_text(&value) else {
            return Vec::new();
        };
        self.saw_text = true;
        vec![text_chunk(&text)]
    }

    fn push_kimi(&mut self, line: &str) -> Vec<LlmChunk> {
        let Some(text) = crate::cli::parse_kimi_line(line) else {
            return Vec::new();
        };
        self.saw_text = true;
        vec![text_chunk(&text)]
    }

    fn push_pi(&mut self, line: &str) -> Vec<LlmChunk> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return Vec::new();
        };
        let mut chunks = Vec::new();
        if kind == "session" {
            self.session_id = first_str(&value, &["id", "session_id", "sessionId"]);
            return chunks;
        }
        if kind == "message_update" {
            let Some(inner) = value.get("assistantMessageEvent") else {
                return chunks;
            };
            let event = inner.get("type").and_then(Value::as_str).unwrap_or("");
            if event == "text_delta" {
                if let Some(text) = inner
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                {
                    self.note_text(&mut chunks, text, true);
                }
            } else if event == "thinking_delta"
                && let Some(text) = inner
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
            {
                self.note_reason(&mut chunks, text, true);
            }
            return chunks;
        }
        if (kind == "message_end" || kind == "turn_end")
            && let Some(message) = value.get("message")
        {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role == "toolResult" || role == "tool_result" {
                return chunks;
            }
            if role == "assistant" {
                if message.get("stopReason").and_then(Value::as_str) != Some("pending") {
                    self.note_pi_usage(message.get("usage"));
                    if let Some(stop) = message
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        self.stop_reason = Some(stop.to_string());
                        if fatal_stop(stop) {
                            self.fatal = Some(format!("pi stopReason: {stop}"));
                        }
                    }
                }
                let content = message.get("content");
                let blocks: Vec<&Value> = match content {
                    Some(Value::Array(items)) => items.iter().collect(),
                    Some(Value::String(text)) if !text.is_empty() => {
                        self.note_text(&mut chunks, text, false);
                        Vec::new()
                    }
                    _ => Vec::new(),
                };
                for block in blocks {
                    let ty = block.get("type").and_then(Value::as_str).unwrap_or("");
                    if ty == "text" {
                        if let Some(text) = block
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                        {
                            self.note_text(&mut chunks, text, false);
                        }
                    } else if ty == "thinking"
                        && let Some(text) = block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                    {
                        self.note_reason(&mut chunks, text, false);
                    }
                }
            }
        }
        chunks
    }

    fn finish_pi(&mut self, code: Option<i32>, stderr: &str) -> Vec<LlmChunk> {
        let mut chunks = Vec::new();
        if !self.saw_text && code != Some(0) && self.fatal.is_none() {
            let detail = if stderr.trim().is_empty() {
                format!("exit {}", code.unwrap_or(-1))
            } else {
                clip_utf16(stderr, 500)
            };
            self.note_text(
                &mut chunks,
                &format!("⚠️ pi-cli bridge error: {detail}"),
                true,
            );
        }
        if let Some(message) = self.fatal.clone() {
            chunks.push(error_chunk(&message));
        }
        let failed = self.fatal.is_some() || code != Some(0);
        self.push_finish(&mut chunks, if failed { "error" } else { "stop" });
        chunks
    }

    fn push_qwen(&mut self, line: &str) -> Vec<LlmChunk> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        if !trimmed.starts_with('{') && crate::session::qwen_resume_rejected(trimmed) {
            self.resume_rejected = true;
            return Vec::new();
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            if crate::session::qwen_resume_rejected(trimmed) {
                self.resume_rejected = true;
            }
            return Vec::new();
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return Vec::new();
        };
        let mut chunks = Vec::new();
        if kind == "system" && value.get("subtype").and_then(Value::as_str) == Some("init") {
            self.saw_init = true;
            return chunks;
        }
        if kind == "stream_event" {
            let Some(event) = value.get("event") else {
                return chunks;
            };
            if event.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                let delta = event.get("delta");
                let ty = delta
                    .and_then(|d| d.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if ty == "text_delta" {
                    if let Some(text) = delta
                        .and_then(|d| d.get("text"))
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                    {
                        self.note_text(&mut chunks, text, true);
                    }
                } else if ty == "thinking_delta"
                    && let Some(text) = delta
                        .and_then(|d| d.get("thinking"))
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                {
                    self.note_reason(&mut chunks, text, true);
                }
            }
            return chunks;
        }
        if kind == "assistant" {
            if let Some(message) = value.get("message") {
                if let Some(usage) = bag_usage(message.get("usage"))
                    && (usage.0 > 0 || usage.1 > 0)
                {
                    self.last_usage = Some(usage);
                }
                if let Some(content) = message.get("content").and_then(Value::as_array) {
                    for block in content {
                        let ty = block.get("type").and_then(Value::as_str).unwrap_or("");
                        if ty == "text" {
                            if let Some(text) = block
                                .get("text")
                                .and_then(Value::as_str)
                                .filter(|t| !t.is_empty())
                            {
                                self.note_text(&mut chunks, text, false);
                            }
                        } else if ty == "thinking"
                            && let Some(text) = block
                                .get("thinking")
                                .and_then(Value::as_str)
                                .filter(|t| !t.is_empty())
                        {
                            self.note_reason(&mut chunks, text, false);
                        }
                    }
                }
            }
            return chunks;
        }
        if kind == "result" {
            self.result_error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !self.result_error {
                self.saw_success = true;
            }
            if let Some(usage) = bag_usage(value.get("usage")) {
                self.result_usage = Some(usage);
            }
            if !self.saw_text_delta
                && !self.saw_text
                && let Some(text) = value
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
            {
                self.note_text(&mut chunks, text, true);
            }
        }
        chunks
    }

    fn finish_qwen(&mut self, code: Option<i32>, stderr: &str) -> Vec<LlmChunk> {
        let mut chunks = Vec::new();
        if !self.saw_text && code != Some(0) && !self.result_error {
            let detail = if stderr.trim().is_empty() {
                format!("exit {}", code.unwrap_or(-1))
            } else {
                clip_utf16(stderr, 500)
            };
            self.note_text(
                &mut chunks,
                &format!("⚠️ qwen-code bridge error: {detail}"),
                true,
            );
        }
        let chosen = self.last_usage.or(self.result_usage);
        if let Some((input, output, cache)) = chosen {
            self.prompt_tokens = input;
            self.completion_tokens = output;
            self.cache_read = cache;
            self.saw_usage = input > 0 || output > 0 || cache > 0;
        }
        let missing = !self.saw_success;
        let failed = self.result_error || code != Some(0) || missing;
        self.push_finish(&mut chunks, if failed { "error" } else { "stop" });
        chunks
    }

    fn push_opencode(&mut self, line: &str) -> Vec<LlmChunk> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        if !value.is_object() {
            return Vec::new();
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let mut chunks = Vec::new();
        let text = if kind == "text" || kind.is_empty() {
            text_of(&value)
        } else {
            None
        };
        if let Some(id) = session_of(&value) {
            self.session_id = Some(id);
        }
        if let Some(text) = text {
            self.note_text(&mut chunks, &text, true);
            return chunks;
        }
        let tokens = tokens_of(&value);
        let assistant = value.get("role").and_then(Value::as_str) == Some("assistant");
        if let Some(usage) = tokens
            && (assistant || matches!(kind, "step_finish" | "step-finish"))
        {
            self.add_opencode_usage(&usage);
        }
        chunks
    }

    fn finish_opencode(&mut self, code: Option<i32>, stderr: &str, stdout: &str) -> Vec<LlmChunk> {
        let tail = stdout
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("");
        if crate::session::session_not_found(stderr) || crate::session::session_not_found(tail) {
            self.delete_session = true;
        }
        let mut chunks = Vec::new();
        if !self.saw_text && code != Some(0) {
            let detail = if stderr.trim().is_empty() {
                format!("exit {}", code.unwrap_or(-1))
            } else {
                clip_utf16(stderr, 500)
            };
            self.note_text(
                &mut chunks,
                &format!("⚠️ opencode-cli bridge error: {detail}"),
                true,
            );
        }
        self.push_finish(&mut chunks, if code == Some(0) { "stop" } else { "error" });
        chunks
    }

    fn push_grok(&mut self, line: &str) -> (Vec<LlmChunk>, Option<ProviderError>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return (Vec::new(), None);
        };
        if !value.is_object() {
            return (Vec::new(), None);
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if !recognized_grok(kind) {
            return (Vec::new(), None);
        }
        self.recognized += 1;
        if let Some(id) = session_field(&value) {
            self.session_id = Some(id);
        }
        if let Some(message) = grok_error_message(&value) {
            return (
                Vec::new(),
                Some(ProviderError::new(message, 500, self.id.clone())),
            );
        }
        let mut chunks = Vec::new();
        if let Some(inner) = grok_inner(&value) {
            if inner.get("type").and_then(Value::as_str) == Some("content_block_delta")
                && let Some(delta) = inner.get("delta")
            {
                let ty = delta.get("type").and_then(Value::as_str).unwrap_or("");
                if ty == "text_delta"
                    && let Some(text) = delta
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                {
                    self.note_text(&mut chunks, text, true);
                } else if ty == "thinking_delta"
                    && let Some(text) = delta
                        .get("thinking")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                {
                    self.note_reason(&mut chunks, text, true);
                }
            }
            if inner.get("type").and_then(Value::as_str) == Some("message_delta") {
                if let Some(delta) = inner.get("delta") {
                    self.note_stop(delta.get("stop_reason").or_else(|| delta.get("stopReason")));
                }
                self.merge_grok_usage(inner.get("usage"), false);
            }
            if inner.get("type").and_then(Value::as_str) == Some("message_start")
                && let Some(message) = inner.get("message")
            {
                self.merge_grok_usage(message.get("usage"), false);
                if let Some(id) = session_field(message) {
                    self.session_id = Some(id);
                }
            }
            return (chunks, None);
        }
        if kind == "assistant" || kind == "message" {
            for block in content_blocks(&value) {
                let ty = block.get("type").and_then(Value::as_str).unwrap_or("");
                if ty == "text" {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        self.fallback_text.push_str(text);
                    }
                } else if let Some(thought) = thinking_block(block) {
                    self.fallback_reason.push_str(&thought);
                }
            }
            let message = value.get("message");
            self.merge_grok_usage(
                message
                    .and_then(|m| m.get("usage"))
                    .or_else(|| value.get("usage")),
                false,
            );
            self.note_stop(
                message
                    .and_then(|m| m.get("stop_reason").or_else(|| m.get("stopReason")))
                    .or_else(|| value.get("stop_reason").or_else(|| value.get("stopReason"))),
            );
            return (chunks, None);
        }
        if kind == "result" {
            self.saw_result = true;
            self.merge_grok_usage(value.get("usage"), true);
            self.note_stop(value.get("stop_reason").or_else(|| value.get("stopReason")));
            if self.fallback_text.is_empty()
                && let Some(text) = value
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
            {
                self.fallback_text = text.to_string();
            }
            if self.fallback_reason.is_empty()
                && let Some(text) = value
                    .get("thought")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
            {
                self.fallback_reason = text.to_string();
            }
        }
        (chunks, None)
    }

    fn finish_grok(
        &mut self,
        code: Option<i32>,
        stderr: &str,
        stdout: &str,
        chunks: &mut Vec<LlmChunk>,
    ) -> Option<ProviderError> {
        if self.recognized == 0
            && code == Some(0)
            && let Some(blob) = parse_grok_json(stdout)
        {
            if let Some(id) = session_field(&blob) {
                self.session_id = Some(id);
            }
            if let Some(text) = blob
                .get("thought")
                .or_else(|| blob.get("thinking"))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                self.note_reason(chunks, text, true);
            }
            if let Some(text) = blob
                .get("text")
                .or_else(|| blob.get("result"))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                self.note_text(chunks, text, true);
            }
            self.merge_grok_usage(blob.get("usage"), true);
            self.note_stop(blob.get("stopReason").or_else(|| blob.get("stop_reason")));
            self.push_finish(chunks, &grok_unified(self.stop_reason.as_deref()));
            return None;
        }
        if code != Some(0) && !self.saw_result {
            let err = clip_utf16(&first_detail(stderr, stdout), 500);
            return Some(ProviderError::new(
                format!("grok CLI exited {}: {err}", code.unwrap_or(-1)),
                i64::from(code.unwrap_or(500)),
                self.id.clone(),
            ));
        }
        if !self.saw_reason_delta && !self.fallback_reason.is_empty() {
            let text = self.fallback_reason.clone();
            self.note_reason(chunks, &text, true);
        }
        if !self.saw_text_delta && !self.saw_text && !self.fallback_text.is_empty() {
            let text = self.fallback_text.clone();
            self.note_text(chunks, &text, true);
        }
        if !self.saw_text && !self.saw_reason_delta && self.recognized == 0 {
            let err = clip_utf16(&first_detail(stderr, stdout), 500);
            return Some(ProviderError::new(
                format!(
                    "grok CLI exited {} without a JSON result: {err}",
                    code.unwrap_or(-1)
                ),
                i64::from(code.unwrap_or(500)),
                self.id.clone(),
            ));
        }
        self.apply_grok_usage();
        let unified = grok_unified(self.stop_reason.as_deref());
        self.push_finish(chunks, &unified);
        None
    }

    fn push_claude(&mut self, line: &str) -> (Vec<LlmChunk>, Option<ProviderError>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return (Vec::new(), None);
        };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let mut chunks = Vec::new();
        if kind == "stream_event" {
            let Some(event) = value.get("event") else {
                return (chunks, None);
            };
            if event.get("type").and_then(Value::as_str) == Some("content_block_delta")
                && let Some(delta) = event.get("delta")
            {
                let ty = delta.get("type").and_then(Value::as_str).unwrap_or("");
                if ty == "text_delta"
                    && let Some(text) = delta
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                {
                    self.note_text(&mut chunks, text, true);
                } else if ty == "thinking_delta"
                    && let Some(text) = delta
                        .get("thinking")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                {
                    self.note_reason(&mut chunks, text, true);
                }
            }
            return (chunks, None);
        }
        if kind == "assistant" {
            if let Some(content) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                for block in content {
                    if block.get("type").and_then(Value::as_str) == Some("text")
                        && let Some(text) = block.get("text").and_then(Value::as_str)
                    {
                        self.fallback_text.push_str(text);
                    }
                }
            }
            return (chunks, None);
        }
        if kind == "result" {
            self.saw_result = true;
            if let Some(usage) = value.get("usage") {
                self.prompt_tokens = u64_of(usage.get("input_tokens"));
                self.completion_tokens = u64_of(usage.get("output_tokens"));
                self.cache_read = u64_of(usage.get("cache_read_input_tokens"));
                self.cache_write = u64_of(usage.get("cache_creation_input_tokens"));
                self.reasoning_tokens = u64_of(usage.get("reasoning_tokens"));
                self.saw_usage = true;
            }
            if value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                let detail = value
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                return (
                    chunks,
                    Some(ProviderError::new(
                        format!("claude-cli error: {detail}"),
                        500,
                        self.id.clone(),
                    )),
                );
            }
            if !self.saw_text_delta {
                let text = value
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                    .unwrap_or("");
                let final_text = if text.is_empty() {
                    self.fallback_text.clone()
                } else {
                    text.to_string()
                };
                if !final_text.is_empty() {
                    self.note_text(&mut chunks, &final_text, true);
                }
            }
            self.note_stop(value.get("stop_reason"));
        }
        (chunks, None)
    }

    fn finish_claude(
        &mut self,
        code: Option<i32>,
        stderr: &str,
        chunks: &mut Vec<LlmChunk>,
    ) -> Option<ProviderError> {
        if code != Some(0) && !self.saw_result {
            let err = clip_utf16(stderr, 500);
            return Some(ProviderError::new(
                format!("claude CLI exited {}: {err}", code.unwrap_or(-1)),
                i64::from(code.unwrap_or(500)),
                self.id.clone(),
            ));
        }
        let unified = match self.stop_reason.as_deref() {
            Some("max_tokens") => "length",
            Some("tool_use") => "tool-calls",
            _ => "stop",
        };
        self.push_finish(chunks, unified);
        None
    }

    fn note_text(&mut self, chunks: &mut Vec<LlmChunk>, text: &str, delta: bool) {
        if text.is_empty() {
            return;
        }
        if delta {
            self.saw_text_delta = true;
            self.saw_text = true;
            chunks.push(text_chunk(text));
            return;
        }
        if self.saw_text_delta {
            return;
        }
        self.saw_text = true;
        chunks.push(text_chunk(text));
    }

    fn note_reason(&mut self, chunks: &mut Vec<LlmChunk>, text: &str, delta: bool) {
        if text.is_empty() {
            return;
        }
        if delta {
            self.saw_reason_delta = true;
            chunks.push(reasoning_chunk(text));
            return;
        }
        if self.saw_reason_delta {
            return;
        }
        chunks.push(reasoning_chunk(text));
    }

    fn note_pi_usage(&mut self, usage: Option<&Value>) {
        let Some(usage) = usage else {
            return;
        };
        let input = num_any(
            usage,
            &["input", "input_tokens", "inputTokens", "promptTokens"],
        );
        let output = num_any(
            usage,
            &[
                "output",
                "output_tokens",
                "outputTokens",
                "completionTokens",
            ],
        );
        let cache_read = num_any(usage, &["cacheRead", "cache_read_tokens"]);
        let cache_write = num_any(usage, &["cacheWrite", "cache_write_tokens"]);
        if input + cache_read + cache_write == 0 && output == 0 {
            return;
        }
        self.prompt_tokens = input + cache_read + cache_write;
        self.completion_tokens = output;
        self.cache_read = cache_read;
        self.cache_write = cache_write;
        self.saw_usage = true;
    }

    fn add_opencode_usage(&mut self, tokens: &Value) {
        let cache = tokens.get("cache");
        let input = u64_of(tokens.get("input"));
        let output = u64_of(tokens.get("output"));
        let reasoning = u64_of(tokens.get("reasoning"));
        let cache_read = u64_of(cache.and_then(|c| c.get("read")));
        let cache_write = u64_of(cache.and_then(|c| c.get("write")));
        self.prompt_tokens += input + cache_read + cache_write;
        self.completion_tokens += output + reasoning;
        self.reasoning_tokens += reasoning;
        self.cache_read += cache_read;
        self.cache_write += cache_write;
        self.saw_usage = true;
    }

    fn merge_grok_usage(&mut self, raw: Option<&Value>, replace: bool) {
        let Some(raw) = raw.and_then(Value::as_object) else {
            return;
        };
        if replace {
            self.grok_usage = GrokUsage::default();
        }
        if let Some(value) = raw.get("input_tokens").and_then(Value::as_u64) {
            self.grok_usage.input = Some(value);
        }
        if let Some(value) = raw.get("output_tokens").and_then(Value::as_u64) {
            self.grok_usage.output = Some(value);
        }
        if let Some(value) = raw.get("cache_read_input_tokens").and_then(Value::as_u64) {
            self.grok_usage.cache_read = Some(value);
        }
        if let Some(value) = raw
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
        {
            self.grok_usage.cache_write = Some(value);
        }
        if let Some(value) = raw.get("reasoning_tokens").and_then(Value::as_u64) {
            self.grok_usage.reasoning = Some(value);
        }
        self.saw_usage = true;
    }

    fn apply_grok_usage(&mut self) {
        self.prompt_tokens = self.grok_usage.input.unwrap_or(0);
        self.completion_tokens = self.grok_usage.output.unwrap_or(0);
        self.cache_read = self.grok_usage.cache_read.unwrap_or(0);
        self.cache_write = self.grok_usage.cache_write.unwrap_or(0);
        self.reasoning_tokens = self.grok_usage.reasoning.unwrap_or(0);
    }

    fn note_stop(&mut self, raw: Option<&Value>) {
        if let Some(text) = raw.and_then(Value::as_str).filter(|text| !text.is_empty()) {
            self.stop_reason = Some(text.to_string());
        }
    }

    fn push_finish(&mut self, chunks: &mut Vec<LlmChunk>, unified: &str) {
        if matches!(unified, "length" | "tool-calls") {
            chunks.push(status_chunk(unified));
        }
        if self.family == Family::Grok {
            self.apply_grok_usage();
        }
        let usage = LlmUsage {
            prompt_tokens: JsNumber::from(self.prompt_tokens),
            completion_tokens: JsNumber::from(self.completion_tokens),
            reasoning_tokens: if self.reasoning_tokens > 0 {
                Some(JsNumber::from(self.reasoning_tokens))
            } else {
                None
            },
            cached_tokens: if self.cache_read > 0 {
                Some(JsNumber::from(self.cache_read))
            } else {
                None
            },
            cache_creation_tokens: if self.cache_write > 0 {
                Some(JsNumber::from(self.cache_write))
            } else {
                None
            },
            cache_read_tokens: if self.cache_read > 0 {
                Some(JsNumber::from(self.cache_read))
            } else {
                None
            },
        };
        if self.saw_usage
            || matches!(
                self.family,
                Family::Pi | Family::Qwen | Family::Opencode | Family::Grok | Family::Claude
            )
        {
            chunks.push(done_chunk(usage, &[]));
        }
    }

    fn fail_plain(&self, code: Option<i32>, stderr: &str) -> ProviderError {
        let detail = if stderr.is_empty() {
            format!("exit {}", code.unwrap_or(-1))
        } else {
            clip_utf16(stderr, 500)
        };
        ProviderError::new(format!("{} failed ({detail})", self.id), 0, self.id.clone())
    }
}

pub fn clip_utf16(text: &str, limit: usize) -> String {
    slice_to_string(text, Some(0.0), Some(limit as f64))
}

pub fn clip_utf16_tail(text: &str, keep: usize) -> String {
    if keep == 0 {
        return String::new();
    }
    slice_to_string(text, Some(-(keep as f64)), None)
}

fn slice_to_string(text: &str, start: Option<f64>, end: Option<f64>) -> String {
    protocol::js::js_slice(text, start, end)
        .to_utf8()
        .to_string()
}

fn fatal_stop(reason: &str) -> bool {
    matches!(reason.to_ascii_lowercase().as_str(), "error" | "aborted")
}

fn first_str(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value
            .get(*key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            return Some(text.to_string());
        }
    }
    None
}

fn num_any(value: &Value, keys: &[&str]) -> u64 {
    for key in keys {
        if let Some(number) = value.get(*key).and_then(Value::as_u64)
            && number > 0
        {
            return number;
        }
        if let Some(number) = value.get(*key).and_then(Value::as_f64)
            && number.is_finite()
            && number > 0.0
        {
            return number as u64;
        }
    }
    0
}

fn u64_of(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .or_else(|| value.and_then(Value::as_f64).map(|n| n as u64))
        .unwrap_or(0)
}

fn bag_usage(usage: Option<&Value>) -> Option<(u64, u64, u64)> {
    let usage = usage?;
    let input = num_any(usage, &["input_tokens", "input", "inputTokens"]);
    let output = num_any(usage, &["output_tokens", "output", "outputTokens"]);
    let cache = num_any(
        usage,
        &["cache_read_input_tokens", "cacheRead", "cache_read"],
    );
    if input == 0 && output == 0 && cache == 0 {
        None
    } else {
        Some((input, output, cache))
    }
}

fn text_of(value: &Value) -> Option<String> {
    if let Some(text) = value
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }
    value
        .get("part")
        .and_then(|part| part.get("text"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn session_of(value: &Value) -> Option<String> {
    if let Some(id) = first_str(value, &["sessionID", "sessionId", "session_id"]) {
        return Some(id);
    }
    if let Some(id) = value
        .get("session")
        .and_then(|session| session.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(id.to_string());
    }
    if let Some(part) = value.get("part")
        && let Some(id) = session_of(part)
    {
        return Some(id);
    }
    value.get("params").and_then(session_of)
}

fn tokens_of(value: &Value) -> Option<Value> {
    if let Some(tokens) = value.get("tokens").filter(|t| t.is_object()) {
        return Some(tokens.clone());
    }
    value
        .get("part")
        .and_then(|part| part.get("tokens"))
        .filter(|t| t.is_object())
        .cloned()
}

fn recognized_grok(kind: &str) -> bool {
    matches!(
        kind,
        "stream_event"
            | "assistant"
            | "user"
            | "result"
            | "error"
            | "system"
            | "message"
            | "message_start"
            | "message_delta"
            | "message_stop"
            | "content_block_start"
            | "content_block_delta"
            | "content_block_stop"
    )
}

fn session_field(value: &Value) -> Option<String> {
    first_str(value, &["session_id", "sessionId"])
}

fn grok_error_message(value: &Value) -> Option<String> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "error" {
        if let Some(text) = value
            .get("error")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            return Some(text.to_string());
        }
        if let Some(text) = value
            .get("error")
            .and_then(|err| err.get("message"))
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            return Some(text.to_string());
        }
        if let Some(text) = value
            .get("message")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            return Some(text.to_string());
        }
        return Some("grok stream error".to_string());
    }
    if kind == "result"
        && value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        let subtype = value
            .get("subtype")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty());
        let detail = value
            .get("result")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .or_else(|| {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
            });
        return Some(match (detail, subtype) {
            (Some(detail), Some(subtype)) => format!("{detail} ({subtype})"),
            (Some(detail), None) => detail.to_string(),
            (None, Some(subtype)) => format!("grok result is_error: {subtype}"),
            (None, None) => "grok result is_error".to_string(),
        });
    }
    None
}

fn grok_inner(value: &Value) -> Option<&Value> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "stream_event" {
        return value.get("event");
    }
    if matches!(
        kind,
        "content_block_delta"
            | "content_block_start"
            | "message_delta"
            | "message_start"
            | "message_stop"
            | "content_block_stop"
    ) {
        return Some(value);
    }
    None
}

fn content_blocks(value: &Value) -> Vec<&Value> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| value.get("content"));
    match content {
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn thinking_block(block: &Value) -> Option<String> {
    let ty = block.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "thinking" || ty == "reasoning" {
        if let Some(text) = block
            .get("thinking")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            return Some(text.to_string());
        }
        if let Some(text) = block
            .get("text")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            return Some(text.to_string());
        }
    }
    None
}

fn grok_unified(stop: Option<&str>) -> String {
    match stop {
        Some("max_tokens" | "length") => "length".to_string(),
        Some("tool_use" | "tool-calls") => "tool-calls".to_string(),
        _ => "stop".to_string(),
    }
}

fn first_detail(stderr: &str, stdout: &str) -> String {
    let err = stderr.trim();
    if !err.is_empty() {
        return err.to_string();
    }
    stdout.trim().to_string()
}

pub fn parse_grok_json(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && value.is_object()
    {
        return Some(value);
    }
    let start = trimmed.find('{')?;
    let bytes = trimmed.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for (offset, byte) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escape {
                escape = false;
            } else if *byte == b'\\' {
                escape = true;
            } else if *byte == b'"' {
                in_str = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&trimmed[start..=offset]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use protocol::LlmChunkType;

    use super::{Family, Machine};

    fn tool_chunk(chunk: &protocol::LlmChunk) -> bool {
        matches!(
            chunk.r#type,
            LlmChunkType::ToolCallStart | LlmChunkType::ToolCallDelta | LlmChunkType::ToolCallDone
        )
    }

    #[test]
    fn pi_tool_events_stay_internal() {
        let mut machine = Machine::new(Family::Pi, "pi");
        let (delta, _) = machine.push_line(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{\"a\":"}}"#,
        );
        assert!(delta.iter().all(|chunk| !tool_chunk(chunk)));
        let (start, _) = machine.push_line(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","id":"t","name":"Bash"}}"#,
        );
        assert!(start.iter().all(|chunk| !tool_chunk(chunk)));
        let (done, _) = machine.push_line(
            r#"{"type":"message_end","message":{"role":"toolResult","toolCallId":"t","toolName":"Bash"}}"#,
        );
        assert!(done.is_empty());
        let (text, _) = machine.push_line(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}"#,
        );
        assert_eq!(text[0].delta.as_deref(), Some("hello"));
        assert!(!tool_chunk(&text[0]));
    }

    #[test]
    fn qwen_tool_events_stay_internal() {
        let mut machine = Machine::new(Family::Qwen, "qwen");
        let (partial, _) = machine.push_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}}"#,
        );
        assert!(partial.iter().all(|chunk| !tool_chunk(chunk)));
        let (tool, _) = machine.push_line(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"read","input":{}}]}}"#,
        );
        assert!(tool.iter().all(|chunk| !tool_chunk(chunk)));
        let (text, _) = machine.push_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}"#,
        );
        assert_eq!(text[0].delta.as_deref(), Some("hi"));
    }

    #[test]
    fn qwen_resume_retry_keeps_the_recovered_answer() {
        let mut machine = Machine::new(Family::Qwen, "qwen");
        machine.arm_retry(true);
        let (rejected, _) = machine.push_line("No saved session found with ID stale");
        assert!(rejected.is_empty());
        let finish = machine.finish(Some(1), "", "");
        assert!(finish.retry_qwen);
        assert!(finish.chunks.is_empty());
        assert!(!machine.saw_text);
        assert!(!machine.saw_text_delta);
        machine.mark_retried();
        let (snap, _) = machine.push_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"recovered answer"}]}}"#,
        );
        assert_eq!(snap[0].delta.as_deref(), Some("recovered answer"));
        let mut fallback = Machine::new(Family::Qwen, "qwen");
        fallback.arm_retry(true);
        fallback.push_line("No saved session found with ID stale");
        assert!(fallback.finish(Some(1), "", "").retry_qwen);
        fallback.mark_retried();
        let (result, _) = fallback.push_line(r#"{"type":"result","result":"recovered answer"}"#);
        assert_eq!(result[0].delta.as_deref(), Some("recovered answer"));
    }

    #[test]
    fn qwen_finish_metadata_stays_internal() {
        let mut errored = Machine::new(Family::Qwen, "qwen");
        let (pushed, _) = errored.push_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#,
        );
        assert_eq!(pushed[0].delta.as_deref(), Some("hello"));
        let (result, _) =
            errored.push_line(r#"{"type":"result","is_error":true,"subtype":"boom"}"#);
        assert!(
            result
                .iter()
                .all(|chunk| chunk.r#type != LlmChunkType::Error)
        );
        let finish = errored.finish(Some(0), "", "");
        assert!(finish.error.is_none());
        assert!(
            finish
                .chunks
                .iter()
                .all(|chunk| chunk.r#type != LlmChunkType::Error && chunk.error.is_none())
        );
        assert!(
            finish
                .chunks
                .iter()
                .any(|chunk| chunk.r#type == LlmChunkType::Done),
            "usage done chunk still closes the turn"
        );

        let mut missing = Machine::new(Family::Qwen, "qwen");
        missing.push_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}"#,
        );
        let finish = missing.finish(Some(0), "", "");
        assert!(finish.chunks.iter().all(|chunk| {
            chunk.error.as_deref() != Some("missing-result")
                && chunk.delta.as_deref() != Some("missing-result")
                && chunk.r#type != LlmChunkType::Error
        }));
        assert!(
            finish
                .chunks
                .iter()
                .any(|chunk| chunk.r#type == LlmChunkType::Done)
        );
    }

    #[test]
    fn grok_mark_retried_clears_the_dead_session() {
        let mut machine = Machine::new(Family::Grok, "grok");
        machine.arm_retry(true);
        let (chunks, err) = machine.push_line(r#"{"type":"system","session_id":"dead-1"}"#);
        assert!(chunks.is_empty());
        assert!(err.is_none());
        assert_eq!(machine.session_id.as_deref(), Some("dead-1"));
        let finish = machine.finish(Some(1), "", "");
        assert!(finish.retry_grok);
        machine.mark_retried();
        assert!(machine.session_id.is_none());
    }
}
