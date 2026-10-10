use std::sync::OnceLock;

use regex::bytes::Regex;
use serde_json::{Map, Value};

use crate::env::EnvLookup;
use crate::helpers::{self, CONTENT_LIMIT};
use crate::types::{CaptureMessage, CaptureRedactionOptions};

pub const REDACT_SCAN_LIMIT: usize = CONTENT_LIMIT;

const SECRET_STEM: &str = r"api[_-]?key|access[_-]?token|token|secret|password|passwd|credential|authorization|private[_-]?key";

protocol::wire_enum! {
    pub enum BuiltinDetectorId {
        Bearer => "bearer",
        PemPrivateKey => "pem_private_key",
        AwsAccessKey => "aws_access_key",
        GithubToken => "github_token",
        SlackToken => "slack_token",
        SkToken => "sk_token",
        Jwt => "jwt",
        Assignment => "assignment",
    }
}

#[derive(Debug, Clone)]
pub struct OperatorPattern {
    pub source: String,
    pub regex: Regex,
    pub index: usize,
}

#[derive(Debug, Clone)]
pub struct ResolvedCaptureRedaction {
    pub enabled: bool,
    pub builtins: bool,
    pub patterns: Vec<OperatorPattern>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactionApplyResult {
    pub text: String,
    pub count: usize,
}

pub fn is_unsafe_regex_source(source: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?-u)\((?:[^\\)]|\\.)*[+*](?:[^\\)]|\\.)*\)(?:[+*?]|\{\d+,?\d*\})").ok()
    })
    .as_ref()
    .is_some_and(|regex| regex.is_match(source.as_bytes()))
}

pub fn secret_key_matches(key: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let source = format!(
        r"(?i-u)^(?:[\w-]*[_-](?:{SECRET_STEM}|key|auth)|(?:{SECRET_STEM}|auth_token|client_secret))$"
    );
    RE.get_or_init(|| Regex::new(&source).ok())
        .as_ref()
        .is_some_and(|regex| regex.is_match(key.as_bytes()))
}

fn truthy_env(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn resolve_capture_redaction(
    input: Option<&CaptureRedactionOptions>,
) -> Option<ResolvedCaptureRedaction> {
    let input = input?;
    if input.enabled != Some(true) {
        return None;
    }
    let builtins = input.builtins != Some(false);
    let mut patterns = Vec::new();
    if let Some(sources) = &input.patterns {
        for (index, source) in sources.iter().enumerate() {
            if source.is_empty() || is_unsafe_regex_source(source) {
                continue;
            }
            let prefixed = if source.starts_with("(?") {
                source.clone()
            } else {
                format!("(?-u){source}")
            };
            if let Ok(regex) = Regex::new(&prefixed) {
                patterns.push(OperatorPattern {
                    source: source.clone(),
                    regex,
                    index,
                });
            }
        }
    }
    if !builtins && patterns.is_empty() {
        return None;
    }
    Some(ResolvedCaptureRedaction {
        enabled: true,
        builtins,
        patterns,
    })
}

pub fn capture_redaction_from_env(env: &dyn EnvLookup) -> Option<CaptureRedactionOptions> {
    if !truthy_env(env.get("RIVETOS_CAPTURE_REDACTION").as_deref()) {
        return None;
    }
    Some(CaptureRedactionOptions {
        enabled: Some(true),
        builtins: Some(true),
        patterns: None,
    })
}

pub fn redact_text(text: &str, resolved: &ResolvedCaptureRedaction) -> RedactionApplyResult {
    if helpers::utf16_len(text) <= REDACT_SCAN_LIMIT {
        return redact_text_body(text, resolved);
    }
    let (head, tail) = helpers::split_utf16(text, REDACT_SCAN_LIMIT);
    let result = redact_text_body(head, resolved);
    RedactionApplyResult {
        text: format!("{}{tail}", result.text),
        count: result.count,
    }
}

fn redact_text_body(text: &str, resolved: &ResolvedCaptureRedaction) -> RedactionApplyResult {
    let mut current = text.to_string();
    let mut count = 0;
    if resolved.builtins {
        for apply in [
            redact_bearer,
            redact_pem,
            redact_aws,
            redact_github,
            redact_slack,
            redact_sk,
            redact_jwt,
            redact_assignment,
        ] {
            let result = apply(&current);
            current = result.text;
            count += result.count;
        }
    }
    for pattern in &resolved.patterns {
        let result = apply_regex(
            &current,
            &pattern.regex,
            &format!("[REDACTED:pattern:{}]", pattern.index),
        );
        current = result.text;
        count += result.count;
    }
    RedactionApplyResult {
        text: current,
        count,
    }
}

fn apply_regex(text: &str, regex: &Regex, replacement: &str) -> RedactionApplyResult {
    let mut count = 0usize;
    let mut out = String::new();
    let mut last = 0usize;
    for caps in regex.captures_iter(text.as_bytes()) {
        let Some(whole) = caps.get(0) else {
            continue;
        };
        let start = whole.start();
        let end = whole.end();
        if start < last || !text.is_char_boundary(start) || !text.is_char_boundary(end) {
            continue;
        }
        out.push_str(&text[last..start]);
        count += 1;
        if replacement.contains("$1") {
            let group = caps
                .get(1)
                .and_then(|item| std::str::from_utf8(item.as_bytes()).ok())
                .unwrap_or("");
            out.push_str(&replacement.replace("$1", group));
        } else {
            out.push_str(replacement);
        }
        last = end;
    }
    if text.is_char_boundary(last) {
        out.push_str(&text[last..]);
    }
    RedactionApplyResult { text: out, count }
}

fn regex_named(name: &str) -> Option<&'static Regex> {
    match name {
        "pem" => once_regex(
            "pem",
            r"(?-u)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?s:.*?)-----END [A-Z0-9 ]*PRIVATE KEY-----",
        ),
        "aws" => once_regex("aws", r"(?-u)\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
        "github" => once_regex(
            "github",
            r"(?-u)\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b",
        ),
        "slack" => once_regex("slack", r"(?-u)\bxox[a-z]-[\w-]{10,}\b"),
        "sk" => once_regex("sk", r"(?-u)\bsk-[A-Za-z0-9_-]{16,}\b"),
        "jwt" => once_regex("jwt", r"(?-u)\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+\b"),
        "assign" => once_regex(
            "assign",
            &format!(
                r"(?i-u)\b((?:[\w-]*[_-](?:{SECRET_STEM}|key|auth)|(?:{SECRET_STEM}))\s*[=:]\s*)"
            ),
        ),
        _ => None,
    }
}

fn once_regex(slot: &str, source: &str) -> Option<&'static Regex> {
    match slot {
        "pem" => leak_slot(0, source),
        "aws" => leak_slot(1, source),
        "github" => leak_slot(2, source),
        "slack" => leak_slot(3, source),
        "sk" => leak_slot(4, source),
        "jwt" => leak_slot(5, source),
        "assign" => leak_slot(6, source),
        _ => None,
    }
}

fn leak_slot(index: usize, source: &str) -> Option<&'static Regex> {
    static SLOTS: [OnceLock<Option<Regex>>; 7] = [
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
    ];
    SLOTS[index]
        .get_or_init(|| Regex::new(source).ok())
        .as_ref()
}

fn redact_pem(text: &str) -> RedactionApplyResult {
    apply_fixed(text, "pem", "[REDACTED:pem_private_key]")
}

fn redact_aws(text: &str) -> RedactionApplyResult {
    apply_fixed(text, "aws", "[REDACTED:aws_access_key]")
}

fn redact_github(text: &str) -> RedactionApplyResult {
    apply_fixed(text, "github", "[REDACTED:github_token]")
}

fn redact_slack(text: &str) -> RedactionApplyResult {
    apply_fixed(text, "slack", "[REDACTED:slack_token]")
}

fn redact_sk(text: &str) -> RedactionApplyResult {
    apply_fixed(text, "sk", "[REDACTED:sk_token]")
}

fn redact_jwt(text: &str) -> RedactionApplyResult {
    apply_fixed(text, "jwt", "[REDACTED:jwt]")
}

fn apply_fixed(text: &str, name: &str, placeholder: &str) -> RedactionApplyResult {
    let Some(regex) = regex_named(name) else {
        return RedactionApplyResult {
            text: text.to_string(),
            count: 0,
        };
    };
    apply_regex(text, regex, placeholder)
}

fn redact_bearer(text: &str) -> RedactionApplyResult {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut count = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(end) = bearer_match(bytes, index) {
            out.push_str("[REDACTED:bearer]");
            count += 1;
            index = end;
        } else {
            let width = next_char_len(text, index);
            let end = (index + width).min(text.len());
            out.push_str(&text[index..end]);
            index = end;
        }
    }
    RedactionApplyResult { text: out, count }
}

fn next_char_len(text: &str, index: usize) -> usize {
    text[index..]
        .chars()
        .next()
        .map(|ch| ch.len_utf8())
        .unwrap_or(1)
}

fn bearer_match(bytes: &[u8], index: usize) -> Option<usize> {
    if !word_boundary(bytes, index) {
        return None;
    }
    if starts_with_ignore_ascii(bytes, index, b"bearer") {
        return bearer_token_end(bytes, index + 6);
    }
    if starts_with_ignore_ascii(bytes, index, b"basic") {
        return basic_token_end(bytes, index + 5);
    }
    None
}

fn bearer_token_end(bytes: &[u8], mut index: usize) -> Option<usize> {
    let ws = take_ascii_ws(bytes, index);
    if ws == index {
        return None;
    }
    index = ws;
    let start = index;
    while index < bytes.len() && is_bearer_token_byte(bytes[index]) {
        index += 1;
    }
    let token = &bytes[start..index];
    if token.len() < 8 || !token.iter().any(|byte| is_bearer_symbol(*byte)) {
        return None;
    }
    Some(index)
}

fn basic_token_end(bytes: &[u8], mut index: usize) -> Option<usize> {
    let ws = take_ascii_ws(bytes, index);
    if ws == index {
        return None;
    }
    index = ws;
    let start = index;
    while index < bytes.len() && is_basic_byte(bytes[index]) {
        index += 1;
    }
    if index - start < 16 {
        return None;
    }
    let mut equals = 0;
    while equals < 2 && index < bytes.len() && bytes[index] == b'=' {
        equals += 1;
        index += 1;
    }
    if index < bytes.len() && is_basic_lookahead(bytes[index]) {
        return None;
    }
    Some(index)
}

fn is_bearer_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'+' | b'/' | b'=')
}

fn is_bearer_symbol(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'+' | b'/' | b'=')
}

fn is_basic_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')
}

fn is_basic_lookahead(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
}

fn take_ascii_ws(bytes: &[u8], mut index: usize) -> usize {
    let start = index;
    while index < bytes.len() && is_ascii_ws(bytes[index]) {
        index += 1;
    }
    if index == start { start } else { index }
}

fn is_ascii_ws(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0c | 0x0b)
}

fn word_boundary(bytes: &[u8], index: usize) -> bool {
    let prev = index > 0 && is_word_byte(bytes[index - 1]);
    let current = index < bytes.len() && is_word_byte(bytes[index]);
    prev != current
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn starts_with_ignore_ascii(bytes: &[u8], index: usize, literal: &[u8]) -> bool {
    if index + literal.len() > bytes.len() {
        return false;
    }
    bytes[index..index + literal.len()]
        .iter()
        .zip(literal)
        .all(|(&have, &want)| have.eq_ignore_ascii_case(&want))
}

fn redact_assignment(text: &str) -> RedactionApplyResult {
    let Some(regex) = regex_named("assign") else {
        return RedactionApplyResult {
            text: text.to_string(),
            count: 0,
        };
    };
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut count = 0usize;
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let Some(mat) = regex.find_at(bytes, cursor) else {
            break;
        };
        let end = mat.end();
        if text[end..].starts_with("[REDACTED") || consume_value(bytes, end) == end {
            let next = mat.start() + next_char_len(text, mat.start());
            out.push_str(&text[cursor..next.min(text.len())]);
            cursor = next.min(text.len());
            continue;
        }
        let value_end = consume_value(bytes, end);
        out.push_str(&text[cursor..mat.start()]);
        let group = regex
            .captures_at(bytes, mat.start())
            .and_then(|caps| caps.get(1))
            .and_then(|item| std::str::from_utf8(item.as_bytes()).ok())
            .unwrap_or("")
            .to_string();
        out.push_str(&group);
        out.push_str("[REDACTED:assignment]");
        count += 1;
        cursor = value_end;
    }
    out.push_str(&text[cursor..]);
    RedactionApplyResult { text: out, count }
}

fn consume_value(bytes: &[u8], mut index: usize) -> usize {
    let start = index;
    if index >= bytes.len() || !is_value_byte(bytes[index]) {
        return start;
    }
    while index < bytes.len() && is_value_byte(bytes[index]) {
        index += 1;
    }
    loop {
        let mut probe = index;
        if probe >= bytes.len() || !matches!(bytes[probe], b' ' | b'\t') {
            break;
        }
        while probe < bytes.len() && matches!(bytes[probe], b' ' | b'\t') {
            probe += 1;
        }
        if probe >= bytes.len() || !is_value_byte(bytes[probe]) {
            break;
        }
        while probe < bytes.len() && is_value_byte(bytes[probe]) {
            probe += 1;
        }
        index = probe;
    }
    index
}

fn is_value_byte(byte: u8) -> bool {
    !is_ascii_ws(byte) && !matches!(byte, b',' | b';' | b'[' | b']')
}

pub fn redact_message(
    message: CaptureMessage,
    resolved: &ResolvedCaptureRedaction,
) -> (CaptureMessage, usize) {
    let mut count = 0usize;
    let content = redact_text(&message.content, resolved);
    count += content.count;
    let tool_result = message.tool_result.as_ref().map(|text| {
        let result = redact_text(text, resolved);
        count += result.count;
        result.text
    });
    let tool_args = message.tool_args.as_ref().map(|value| {
        let (next, added) = redact_value(value, resolved);
        count += added;
        next
    });
    if count == 0 {
        return (message, 0);
    }
    let mut next = message;
    next.content = content.text;
    if tool_result.is_some() {
        next.tool_result = tool_result;
    }
    if tool_args.is_some() {
        next.tool_args = tool_args;
    }
    (next, count)
}

fn redact_value(value: &Value, resolved: &ResolvedCaptureRedaction) -> (Value, usize) {
    match value {
        Value::String(text) => {
            let result = redact_text_body(text, resolved);
            (Value::String(result.text), result.count)
        }
        Value::Array(items) => {
            let mut count = 0;
            let mut next = Vec::with_capacity(items.len());
            for item in items {
                let (child, added) = redact_value(item, resolved);
                count += added;
                next.push(child);
            }
            (Value::Array(next), count)
        }
        Value::Object(map) => {
            let mut count = 0;
            let mut out = Map::new();
            for (key, child) in map {
                if secret_key_matches(key) && child.is_string() {
                    out.insert(
                        key.clone(),
                        Value::String("[REDACTED:secret_key]".to_string()),
                    );
                    count += 1;
                    continue;
                }
                let (redacted, added) = redact_value(child, resolved);
                out.insert(key.clone(), redacted);
                count += added;
            }
            (Value::Object(out), count)
        }
        other => (other.clone(), 0),
    }
}

pub fn keep_metadata_key(key: &str) -> bool {
    const KEEP: &[&str] = &[
        "event_id",
        "session_jsonl_path",
        "session_jsonl_line",
        "session_sqlite_path",
        "session_sqlite_part_id",
        "truncated",
        "ordinal",
        "native_event_id",
        "source",
        "metadata_elided",
        "full_metadata_bytes",
    ];
    if KEEP.contains(&key) {
        return true;
    }
    let Some(middle) = key
        .strip_prefix("full_")
        .and_then(|rest| rest.strip_suffix("_length"))
    else {
        return false;
    };
    !middle.is_empty() && !middle.contains('\n')
}
