use std::sync::atomic::{AtomicU64, Ordering};

use protocol::js::{self, JsValue};
use serde_json::{Map, Value};

pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

pub fn json_number(literal: &str) -> Value {
    match literal.parse::<serde_json::Number>() {
        Ok(number) => Value::Number(number),
        Err(_) => Value::from(0),
    }
}

pub fn to_compact(value: &Value) -> Result<String, ()> {
    serde_json::to_string(value).map_err(|_| ())
}

pub fn canonical_json(text: &str) -> String {
    match js::parse(text) {
        Ok(value) => js::stringify(&value),
        Err(_) => text.to_string(),
    }
}

pub fn canonical_pair(raw: &str) -> (String, Value) {
    let source = if raw.is_empty() { "{}" } else { raw };
    let text = canonical_json(source);
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    (text, value)
}

pub fn canonical_from_value(value: &Value) -> (String, Value) {
    match serde_json::to_string(value) {
        Ok(raw) => canonical_pair(&raw),
        Err(_) => ("null".to_string(), Value::Null),
    }
}

pub fn js_norm(text: &str) -> String {
    match js::parse(text) {
        Ok(value) => js::stringify(&value),
        Err(_) => text.to_string(),
    }
}

pub fn parse_schema(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::Object(Map::new()))
}

pub fn gemini_schema(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let preferred = ["required", "description", "type", "properties", "items"];
            let mut out = Map::new();
            for key in preferred {
                if let Some(child) = map.get(key) {
                    out.insert(key.to_string(), gemini_schema(child));
                }
            }
            for (key, child) in map {
                if !preferred.contains(&key.as_str()) {
                    out.insert(key.clone(), gemini_schema(child));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(gemini_schema).collect()),
        other => other.clone(),
    }
}

pub fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

pub fn encode_path_segment(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn encode_query(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub struct IdGen {
    next: AtomicU64,
}

impl IdGen {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(0),
        }
    }

    pub fn next_id(&self) -> String {
        let value = self.next.fetch_add(1, Ordering::Relaxed);
        format_id(value)
    }
}

impl Default for IdGen {
    fn default() -> Self {
        Self::new()
    }
}

fn format_id(mut value: u64) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut chars = [b'0'; 16];
    for index in (0..16).rev() {
        chars[index] = ALPHABET[(value % 62) as usize];
        value /= 62;
    }
    match String::from_utf8(chars.to_vec()) {
        Ok(text) => text,
        Err(_) => "0000000000000000".to_string(),
    }
}

pub fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

pub fn f64_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

pub fn is_claude_4(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    lower.starts_with("claude-opus-4")
        || lower.starts_with("claude-sonnet-4")
        || lower.starts_with("claude-haiku-4")
}

pub fn thinking_name(level: protocol::ThinkingLevel) -> &'static str {
    match level {
        protocol::ThinkingLevel::Off => "off",
        protocol::ThinkingLevel::Low => "low",
        protocol::ThinkingLevel::Medium => "medium",
        protocol::ThinkingLevel::High => "high",
        protocol::ThinkingLevel::XHigh => "xhigh",
    }
}

pub fn map_xai_reasoning_effort(
    model: &str,
    thinking: Option<protocol::ThinkingLevel>,
    configured: Option<&str>,
) -> Option<&'static str> {
    let level = match thinking {
        Some(protocol::ThinkingLevel::Off) => return None,
        Some(protocol::ThinkingLevel::Low) => "low",
        Some(protocol::ThinkingLevel::Medium) => "medium",
        Some(protocol::ThinkingLevel::High) => "high",
        Some(protocol::ThinkingLevel::XHigh) => "xhigh",
        None => match configured {
            Some("low") => "low",
            Some("medium") => "medium",
            Some("high") => "high",
            Some("xhigh") => "xhigh",
            _ => return None,
        },
    };
    if !model.contains("multi-agent") {
        return None;
    }
    if level == "xhigh" {
        Some("high")
    } else {
        Some(level)
    }
}

pub fn b64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= data.len() {
        let n = (u32::from(data[index]) << 16)
            | (u32::from(data[index + 1]) << 8)
            | u32::from(data[index + 2]);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        index += 3;
    }
    let rest = data.len() - index;
    if rest == 1 {
        let n = u32::from(data[index]) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let n = (u32::from(data[index]) << 16) | (u32::from(data[index + 1]) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

pub fn b64_decode(text: &str) -> Vec<u8> {
    fn val(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let b0 = bytes.get(index).copied().unwrap_or(b'=');
        let b1 = bytes.get(index + 1).copied().unwrap_or(b'=');
        let b2 = bytes.get(index + 2).copied().unwrap_or(b'=');
        let b3 = bytes.get(index + 3).copied().unwrap_or(b'=');
        index += 4;
        let (Some(v0), Some(v1)) = (val(b0), val(b1)) else {
            break;
        };
        out.push((v0 << 2) | (v1 >> 4));
        if b2 != b'=' {
            let Some(v2) = val(b2) else { break };
            out.push((v1 << 4) | (v2 >> 2));
            if b3 != b'=' {
                let Some(v3) = val(b3) else { break };
                out.push((v2 << 6) | v3);
            }
        }
    }
    out
}

pub fn splice_video_urls(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages {
        let Some(content) = message.get("content").cloned() else {
            continue;
        };
        let Value::String(text) = content else {
            continue;
        };
        let (stripped, urls) = strip_video_markers(&text);
        if urls.is_empty() {
            continue;
        }
        let mut parts = Vec::new();
        if !stripped.trim().is_empty() {
            parts.push(obj(vec![
                ("type", Value::from("text")),
                ("text", Value::from(stripped)),
            ]));
        }
        for url in urls {
            parts.push(obj(vec![
                ("type", Value::from("video_url")),
                (
                    "video_url",
                    obj(vec![("url", Value::from(url))]),
                ),
            ]));
        }
        if let Some(object) = message.as_object_mut() {
            object.insert("content".to_string(), Value::Array(parts));
        }
    }
}

fn strip_video_markers(text: &str) -> (String, Vec<String>) {
    let bytes = text.as_bytes();
    let marker = b"RVT_VIDEO[";
    let mut out = String::new();
    let mut urls = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(marker) {
            let start = index + marker.len();
            if let Some(end) = bytes[start..].iter().position(|byte| *byte == b']') {
                let encoded = &text[start..start + end];
                if encoded
                    .bytes()
                    .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'='))
                {
                    let decoded = b64_decode(encoded);
                    if let Ok(url) = String::from_utf8(decoded) {
                        urls.push(url);
                        index = start + end + 1;
                        continue;
                    }
                }
            }
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    (out, urls)
}

pub fn value_from_js(value: &JsValue) -> Value {
    match serde_json::from_str::<Value>(&js::stringify(value)) {
        Ok(parsed) => parsed,
        Err(_) => Value::Null,
    }
}
