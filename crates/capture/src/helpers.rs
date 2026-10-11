use std::path::Path;

use serde_json::Value;

pub const CONTENT_LIMIT: usize = 16_000;

pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

pub fn as_string(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.as_str()),
        _ => None,
    }
}

pub fn safe_json(value: &Value) -> String {
    protocol::js::stringify(&protocol::js::from_serde(value))
}

pub struct CappedText {
    pub text: String,
    pub truncated: bool,
    pub full_length: usize,
}

pub fn cap_for_storage(text: &str, limit: Option<usize>) -> CappedText {
    let limit = limit.unwrap_or(CONTENT_LIMIT);
    let full_length = protocol::js::utf16_len(text);
    let sliced = protocol::js::js_slice(text, Some(0.0), Some(limit as f64));
    CappedText {
        text: sliced.to_utf8().to_string(),
        truncated: full_length > limit,
        full_length,
    }
}

pub fn cap_field(text: &str) -> CappedText {
    cap_for_storage(text, Some(CONTENT_LIMIT))
}

pub fn load_env_file(path: impl AsRef<Path>) -> std::collections::BTreeMap<String, String> {
    let mut values = std::collections::BTreeMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return values;
    };
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r');
        let Some((key, raw_value)) = parse_env_line(line) else {
            continue;
        };
        if key.is_empty()
            || values
                .get(key)
                .is_some_and(|value: &String| !value.is_empty())
        {
            continue;
        }
        values.insert(key.to_string(), strip_one_quote(raw_value));
    }
    values
}

fn parse_env_line(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() && is_ascii_ws(bytes[index]) {
        index += 1;
    }
    let key_start = index;
    while index < bytes.len() && is_env_key(bytes[index]) {
        index += 1;
    }
    if index == key_start {
        return None;
    }
    let key_end = index;
    while index < bytes.len() && is_ascii_ws(bytes[index]) {
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b'=' {
        return None;
    }
    index += 1;
    while index < bytes.len() && is_ascii_ws(bytes[index]) {
        index += 1;
    }
    Some((&line[key_start..key_end], &line[index..]))
}

fn is_ascii_ws(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0c | 0x0b)
}

fn is_env_key(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
}

fn strip_one_quote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return String::new();
    }
    let mut start = 0;
    let mut end = bytes.len();
    if bytes[start] == b'"' || bytes[start] == b'\'' {
        start += 1;
    }
    if end > start && (bytes[end - 1] == b'"' || bytes[end - 1] == b'\'') {
        end -= 1;
    }
    value[start..end].to_string()
}

pub fn json_utf8_len(value: &impl serde::Serialize) -> usize {
    match serde_json::to_value(value) {
        Ok(parsed) => protocol::js::stringify(&protocol::js::from_serde(&parsed)).len(),
        Err(_) => 0,
    }
}
