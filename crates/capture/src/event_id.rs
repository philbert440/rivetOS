use std::collections::HashMap;

use protocol::js::JsValue;

#[derive(Debug, Clone, PartialEq)]
pub struct OccurrenceKey {
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<JsValue>,
}

#[derive(Debug, Clone)]
pub struct EventIdParts {
    pub session_key: String,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<JsValue>,
    pub occurrence: Option<u64>,
}

fn tuple_fields(
    role: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_args: Option<&JsValue>,
) -> [String; 4] {
    let args = match tool_args {
        None => String::new(),
        Some(value) => protocol::js::stringify(value),
    };
    [
        role.to_string(),
        content.to_string(),
        tool_name.unwrap_or("").to_string(),
        args,
    ]
}

fn join_fields(fields: &[String]) -> String {
    fields.join("\0")
}

pub fn event_id_from_content(parts: &EventIdParts) -> String {
    let tuple = tuple_fields(
        &parts.role,
        &parts.content,
        parts.tool_name.as_deref(),
        parts.tool_args.as_ref(),
    );
    let mut fields = Vec::with_capacity(6);
    fields.push(parts.session_key.clone());
    fields.extend(tuple);
    if let Some(occurrence) = parts.occurrence {
        fields.push(occurrence.to_string());
    }
    protocol::digest::sha256_hex(join_fields(&fields).as_bytes())
}

fn content_tuple(parts: &OccurrenceKey) -> String {
    join_fields(&tuple_fields(
        &parts.role,
        &parts.content,
        parts.tool_name.as_deref(),
        parts.tool_args.as_ref(),
    ))
}

pub fn content_tuple_hash(parts: &OccurrenceKey) -> String {
    protocol::digest::sha256_hex(content_tuple(parts).as_bytes())
}

pub fn occurrence_index(rows: &[OccurrenceKey], key: &OccurrenceKey) -> u64 {
    let want = content_tuple(key);
    let mut count = 0u64;
    for row in rows {
        if content_tuple(row) == want {
            count += 1;
        }
    }
    if count == 0 { 0 } else { count - 1 }
}

#[derive(Debug, Default)]
pub struct OccurrenceCounts {
    seen: HashMap<String, u64>,
}

impl OccurrenceCounts {
    pub fn next(&mut self, key: &OccurrenceKey) -> (u64, String) {
        let tuple = content_tuple(key);
        let seen = self.seen.entry(tuple.clone()).or_insert(0);
        let index = *seen;
        *seen += 1;
        (index, tuple)
    }
}
