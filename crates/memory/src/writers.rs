use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::text::{MemoryWriteTags, append_event_id, resolve_memory_write_tags, truncate_content};

#[derive(Debug, Clone)]
pub struct PreparedAppend {
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<Map<String, Value>>,
    pub tool_result: Option<String>,
    pub event_id: String,
    pub tags: MemoryWriteTags,
    pub metadata: Map<String, Value>,
}

fn as_string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn prepare_append(
    args: &Map<String, Value>,
    env: &BTreeMap<String, String>,
) -> Result<PreparedAppend, String> {
    let session_id = protocol::js::js_trim(&as_string(args.get("session_id"))).to_string();
    let content = as_string(args.get("content"));
    let role = as_string(args.get("role"));
    let tool_name = args
        .get("tool_name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let event_id_arg = args
        .get("event_id")
        .and_then(Value::as_str)
        .map(protocol::js::js_trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if session_id.is_empty() {
        return Err("memory_append: session_id is required".to_string());
    }
    if role.is_empty() {
        return Err("memory_append: role is required".to_string());
    }
    if !matches!(role.as_str(), "user" | "assistant" | "system" | "tool") {
        return Err("memory_append: role must be user|assistant|system|tool".to_string());
    }
    if content.is_empty() && tool_name.as_deref().is_none_or(str::is_empty) && role != "tool" {
        return Err(
            "memory_append: content is required (or provide tool_name for tool-call messages)"
                .to_string(),
        );
    }
    let tags = resolve_memory_write_tags(
        args.get("source").and_then(Value::as_str),
        args.get("agent").and_then(Value::as_str),
        args.get("persona").and_then(Value::as_str),
        args.get("channel").and_then(Value::as_str),
        env,
    );
    let event_id = event_id_arg.unwrap_or_else(|| {
        append_event_id(
            &session_id,
            &tags.agent,
            &role,
            &content,
            tool_name.as_deref(),
        )
    });
    let mut metadata = Map::new();
    metadata.insert("source".to_string(), Value::String(tags.source.clone()));
    metadata.insert("event_id".to_string(), Value::String(event_id.clone()));
    if let Some(persona) = &tags.persona {
        metadata.insert("persona".to_string(), Value::String(persona.clone()));
    }
    let truncated_content = truncate_content(&content, &mut metadata, "");
    let tool_args = args.get("tool_args").and_then(Value::as_object).cloned();
    let tool_result = args
        .get("tool_result")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| truncate_content(text, &mut metadata, "tool_result"));
    Ok(PreparedAppend {
        session_id,
        role,
        content: truncated_content,
        tool_name,
        tool_args,
        tool_result,
        event_id,
        tags,
        metadata,
    })
}

pub fn append_result_value(prepared: &PreparedAppend, id: &str, skipped: bool) -> Value {
    let mut map = Map::new();
    if skipped {
        map.insert("skipped".to_string(), Value::Bool(true));
    }
    map.insert("id".to_string(), Value::String(id.to_string()));
    map.insert(
        "event_id".to_string(),
        Value::String(prepared.event_id.clone()),
    );
    map.insert(
        "session_id".to_string(),
        Value::String(prepared.session_id.clone()),
    );
    map.insert(
        "source".to_string(),
        Value::String(prepared.tags.source.clone()),
    );
    map.insert(
        "agent".to_string(),
        Value::String(prepared.tags.agent.clone()),
    );
    map.insert(
        "channel".to_string(),
        Value::String(prepared.tags.channel.clone()),
    );
    if let Some(persona) = &prepared.tags.persona {
        map.insert("persona".to_string(), Value::String(persona.clone()));
    }
    if prepared.metadata.get("truncated") == Some(&Value::Bool(true)) {
        map.insert("truncated".to_string(), Value::Bool(true));
        let content_len = prepared
            .metadata
            .get("full_content_length")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let tool_len = prepared
            .metadata
            .get("full_tool_result_length")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let full = content_len.max(tool_len);
        if full > 0 {
            map.insert("full_content_length".to_string(), Value::from(full));
        }
    }
    Value::Object(map)
}

pub fn ingest_result_value(output: &crate::store::IngestOutput) -> Value {
    let mut map = Map::new();
    map.insert(
        "session_id".to_string(),
        Value::String(output.session_id.clone()),
    );
    map.insert("ingested".to_string(), Value::from(output.ingested));
    map.insert("skipped".to_string(), Value::from(output.skipped));
    map.insert(
        "ids".to_string(),
        Value::Array(output.ids.iter().cloned().map(Value::String).collect()),
    );
    map.insert("source".to_string(), Value::String(output.source.clone()));
    map.insert("agent".to_string(), Value::String(output.agent.clone()));
    map.insert("channel".to_string(), Value::String(output.channel.clone()));
    if let Some(persona) = &output.persona {
        map.insert("persona".to_string(), Value::String(persona.clone()));
    }
    if output.truncated {
        map.insert("truncated".to_string(), Value::Bool(true));
        if let Some(len) = output.full_content_length {
            map.insert("full_content_length".to_string(), Value::from(len));
        }
    }
    Value::Object(map)
}

pub fn validate_ingest_messages(raw: &Value) -> Result<Vec<crate::store::IngestMessage>, String> {
    let Some(items) = raw.as_array() else {
        return Err("memory_ingest_session: messages must be a non-empty array".to_string());
    };
    if items.is_empty() {
        return Err("memory_ingest_session: messages must be a non-empty array".to_string());
    }
    let mut out = Vec::new();
    for item in items {
        let Some(rec) = item.as_object() else {
            return Err("memory_ingest_session: bad message".to_string());
        };
        let role = as_string(rec.get("role"));
        let content = as_string(rec.get("content"));
        if role.is_empty() {
            return Err("memory_ingest_session: role is required for each message".to_string());
        }
        if !matches!(role.as_str(), "user" | "assistant" | "system" | "tool") {
            return Err("memory_ingest_session: invalid role".to_string());
        }
        let mut tool_calls = Vec::new();
        if let Some(calls) = rec.get("tool_calls").and_then(Value::as_array) {
            for tc in calls {
                if let Some(obj) = tc.as_object() {
                    tool_calls.push(crate::store::ToolCallIn {
                        id: obj.get("id").and_then(Value::as_str).map(str::to_string),
                        name: obj
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        input: obj
                            .get("input")
                            .and_then(Value::as_object)
                            .cloned()
                            .map(Value::Object),
                    });
                } else {
                    tool_calls.push(crate::store::ToolCallIn {
                        id: None,
                        name: String::new(),
                        input: None,
                    });
                }
            }
        }
        out.push(crate::store::IngestMessage {
            role,
            content,
            created_at: ingest_created_at(rec.get("created_at")),
            tool_calls,
        });
    }
    Ok(out)
}

fn ingest_created_at(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if !protocol::js::js_boolean_json(value) {
        return None;
    }
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => match number.as_f64() {
            Some(ms) => match protocol::js::to_iso_string(ms) {
                Ok(iso) => Some(iso),
                Err(_) => Some(protocol::js::js_to_string_json(value)),
            },
            None => Some(protocol::js::js_to_string_json(value)),
        },
        Value::Bool(_) => protocol::js::to_iso_string(1.0).ok(),
        other => Some(protocol::js::js_to_string_json(other)),
    }
}
