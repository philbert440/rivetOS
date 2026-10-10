use std::sync::OnceLock;

use regex::bytes::Regex as BytesRegex;
use regress::Regex;
use serde_json::{Map, Value};

use crate::env::EnvLookup;
use crate::helpers::CONTENT_LIMIT;
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

struct Detector {
    regex: Regex,
    replacement: &'static str,
}

pub fn is_unsafe_regex_source(source: &str) -> bool {
    static RE: OnceLock<Option<BytesRegex>> = OnceLock::new();
    RE.get_or_init(|| {
        BytesRegex::new(r"(?-u)\((?:[^\\)]|\\.)*[+*](?:[^\\)]|\\.)*\)(?:[+*?]|\{\d+,?\d*\})").ok()
    })
    .as_ref()
    .is_some_and(|regex| regex.is_match(source.as_bytes()))
}

pub fn secret_key_matches(key: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let source = format!(
        r"^(?:[\w-]*[_-](?:{SECRET_STEM}|key|auth)|(?:{SECRET_STEM}|auth_token|client_secret))$"
    );
    RE.get_or_init(|| Regex::with_flags(&source, "i").ok())
        .as_ref()
        .is_some_and(|regex| regex.find(key).is_some())
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
    let supplied = input
        .patterns
        .as_ref()
        .is_some_and(|sources| !sources.is_empty());
    let mut patterns = Vec::new();
    if let Some(sources) = &input.patterns {
        for (index, source) in sources.iter().enumerate() {
            if source.is_empty() || is_unsafe_regex_source(source) {
                continue;
            }
            if let Ok(regex) = Regex::with_flags(source, "g") {
                patterns.push(OperatorPattern {
                    source: source.clone(),
                    regex,
                    index,
                });
            }
        }
    }
    if !builtins && patterns.is_empty() && !supplied {
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
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= REDACT_SCAN_LIMIT {
        return finish_units(redact_units(&units, resolved));
    }
    let (mut head, count) = redact_units(&units[..REDACT_SCAN_LIMIT], resolved);
    head.extend_from_slice(&units[REDACT_SCAN_LIMIT..]);
    finish_units((head, count))
}

fn redact_text_body(text: &str, resolved: &ResolvedCaptureRedaction) -> RedactionApplyResult {
    let units: Vec<u16> = text.encode_utf16().collect();
    finish_units(redact_units(&units, resolved))
}

fn finish_units(pair: (Vec<u16>, usize)) -> RedactionApplyResult {
    let (units, count) = pair;
    let text = String::from_utf16(&units).unwrap_or_else(|_| String::from_utf16_lossy(&units));
    RedactionApplyResult { text, count }
}

fn redact_units(units: &[u16], resolved: &ResolvedCaptureRedaction) -> (Vec<u16>, usize) {
    let mut current = units.to_vec();
    let mut count = 0usize;
    if resolved.builtins {
        for detector in builtin_detectors() {
            let (next, added) = apply_units(&current, &detector.regex, detector.replacement);
            current = next;
            count += added;
        }
    }
    for pattern in &resolved.patterns {
        let replacement = format!("[REDACTED:pattern:{}]", pattern.index);
        let (next, added) = apply_units(&current, &pattern.regex, &replacement);
        current = next;
        count += added;
    }
    (current, count)
}

fn apply_units(units: &[u16], regex: &Regex, replacement: &str) -> (Vec<u16>, usize) {
    let mut out = Vec::with_capacity(units.len());
    let mut last = 0usize;
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some(found) = regex.find_from_utf16(units, cursor).next() {
        let start = found.start();
        let end = found.end();
        if start < last || start > units.len() {
            break;
        }
        out.extend_from_slice(&units[last..start.min(units.len())]);
        count += 1;
        out.extend(expand_replacement(&found, units, replacement).encode_utf16());
        if end <= start {
            if start >= units.len() {
                last = start;
                break;
            }
            out.push(units[start]);
            last = start + 1;
            cursor = start + 1;
            continue;
        }
        let end = end.min(units.len());
        last = end;
        cursor = end;
        if cursor >= units.len() {
            break;
        }
    }
    if last < units.len() {
        out.extend_from_slice(&units[last..]);
    }
    (out, count)
}

fn expand_replacement(found: &regress::Match, units: &[u16], replacement: &str) -> String {
    if !replacement.contains("$1") {
        return replacement.to_string();
    }
    let group = found
        .group(1)
        .map(|range| {
            let start = range.start.min(units.len());
            let end = range.end.min(units.len());
            String::from_utf16_lossy(&units[start..end])
        })
        .unwrap_or_default();
    replacement.replace("$1", &group)
}

fn builtin_detectors() -> &'static [Detector] {
    static SLOTS: OnceLock<Vec<Detector>> = OnceLock::new();
    SLOTS.get_or_init(|| {
        let specs = [
            (
                r"\b(?:Bearer\s+(?=[A-Za-z0-9_\-+/=]*[0-9_\-+/=])[A-Za-z0-9_\-+/=]{8,}|Basic\s+[A-Za-z0-9+/]{16,}={0,2})(?![A-Za-z0-9+/=])",
                "gi",
                "[REDACTED:bearer]",
            ),
            (
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
                "g",
                "[REDACTED:pem_private_key]",
            ),
            (
                r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
                "g",
                "[REDACTED:aws_access_key]",
            ),
            (
                r"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b",
                "g",
                "[REDACTED:github_token]",
            ),
            (r"\bxox[a-z]-[\w-]{10,}\b", "g", "[REDACTED:slack_token]"),
            (r"\bsk-[A-Za-z0-9_-]{16,}\b", "g", "[REDACTED:sk_token]"),
            (
                r"\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+\b",
                "g",
                "[REDACTED:jwt]",
            ),
        ];
        let mut compiled = Vec::new();
        for (source, flags, replacement) in specs {
            if let Ok(regex) = Regex::with_flags(source, flags) {
                compiled.push(Detector { regex, replacement });
            }
        }
        let assignment = format!(
            r"\b((?:[\w-]*[_-](?:{SECRET_STEM}|key|auth)|(?:{SECRET_STEM}))\s*[=:]\s*)(?!\[REDACTED)[^\s\n\r,;[\]]+(?:[ \t]+[^\s\n\r,;[\]]+)*"
        );
        if let Ok(regex) = Regex::with_flags(&assignment, "gi") {
            compiled.push(Detector {
                regex,
                replacement: "$1[REDACTED:assignment]",
            });
        }
        compiled
    })
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
    !middle.is_empty()
        && !middle
            .chars()
            .any(|ch| matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}
