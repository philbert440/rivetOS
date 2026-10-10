use std::collections::BTreeMap;

use protocol::js::js_trim;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const MAX_CONTENT: usize = 16000;
pub const TRUNCATION_MARKER: &str = "\n…[truncated]";

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn utf16_prefix(text: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let units = ch.len_utf16();
        if used + units > max_units {
            break;
        }
        out.push(ch);
        used += units;
    }
    out
}

pub fn capture_cap(text: &str, metadata: &mut Map<String, Value>, field: &str) -> String {
    if utf16_len(text) <= MAX_CONTENT {
        return text.to_string();
    }
    metadata.insert(format!("full_{field}_length"), Value::from(utf16_len(text) as u64));
    metadata.insert("truncated".to_string(), Value::Bool(true));
    utf16_prefix(text, MAX_CONTENT)
}

pub fn truncate_content(content: &str, metadata: &mut Map<String, Value>, field_prefix: &str) -> String {
    if utf16_len(content) <= MAX_CONTENT {
        return content.to_string();
    }
    if content.ends_with(TRUNCATION_MARKER) {
        return content.to_string();
    }
    let key = if field_prefix.is_empty() {
        "full_content_length".to_string()
    } else {
        format!("full_{field_prefix}_length")
    };
    metadata.insert(key, Value::from(utf16_len(content) as u64));
    metadata.insert("truncated".to_string(), Value::Bool(true));
    format!("{}{TRUNCATION_MARKER}", utf16_prefix(content, MAX_CONTENT))
}

fn sha256_hex(material: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(material.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn ingest_event_id(
    session_id: &str,
    agent: &str,
    role: &str,
    content: &str,
    ordinal: u64,
    tool_name: Option<&str>,
) -> String {
    sha256_hex(&format!(
        "{session_id}\0{agent}\0{role}\0{content}\0{ordinal}\0{}",
        tool_name.unwrap_or("")
    ))
}

pub fn append_event_id(
    session_id: &str,
    agent: &str,
    role: &str,
    content: &str,
    tool_name: Option<&str>,
) -> String {
    sha256_hex(&format!(
        "append\0{session_id}\0{agent}\0{role}\0{content}\0{}",
        tool_name.unwrap_or("")
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryWriteTags {
    pub source: String,
    pub agent: String,
    pub channel: String,
    pub persona: Option<String>,
}

pub fn resolve_memory_write_tags(
    source: Option<&str>,
    agent: Option<&str>,
    persona: Option<&str>,
    channel: Option<&str>,
    env: &BTreeMap<String, String>,
) -> MemoryWriteTags {
    let pick = |arg: Option<&str>, key: &str, default: &str| {
        js_trim(arg.unwrap_or_else(|| env.get(key).map(String::as_str).unwrap_or(default))).to_string()
    };
    let persona = js_trim(persona.unwrap_or_else(|| {
        env.get("RIVETOS_MEMORY_PERSONA").map(String::as_str).unwrap_or("")
    }))
    .to_string();
    MemoryWriteTags {
        source: pick(source, "RIVETOS_MEMORY_SOURCE", "mcp"),
        agent: pick(agent, "RIVETOS_MEMORY_AGENT", "mcp"),
        channel: pick(channel, "RIVETOS_MEMORY_CHANNEL", "mcp"),
        persona: if persona.is_empty() { None } else { Some(persona) },
    }
}
