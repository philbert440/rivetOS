use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::helpers::safe_json;

#[derive(Debug, Clone, PartialEq)]
pub struct OccurrenceKey {
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct EventIdParts {
    pub session_key: String,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<Value>,
    pub occurrence: Option<u64>,
}

pub fn sha256_hex(material: &str) -> String {
    let digest = Sha256::digest(material.as_bytes());
    hex::encode(digest)
}

fn tuple_fields(
    role: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_args: Option<&Value>,
) -> [String; 4] {
    let args = match tool_args {
        None => String::new(),
        Some(value) => safe_json(value),
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
    sha256_hex(&join_fields(&fields))
}

pub fn content_tuple_hash(parts: &OccurrenceKey) -> String {
    let fields = tuple_fields(
        &parts.role,
        &parts.content,
        parts.tool_name.as_deref(),
        parts.tool_args.as_ref(),
    );
    sha256_hex(&join_fields(&fields))
}

pub fn occurrence_index(rows: &[OccurrenceKey], key: &OccurrenceKey) -> u64 {
    let want = join_fields(&tuple_fields(
        &key.role,
        &key.content,
        key.tool_name.as_deref(),
        key.tool_args.as_ref(),
    ));
    let mut count = 0u64;
    for row in rows {
        let have = join_fields(&tuple_fields(
            &row.role,
            &row.content,
            row.tool_name.as_deref(),
            row.tool_args.as_ref(),
        ));
        if have == want {
            count += 1;
        }
    }
    if count == 0 { 0 } else { count - 1 }
}
