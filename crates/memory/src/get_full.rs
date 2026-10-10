use std::io::Read;
use std::path::Path;

use serde_json::{Map, Value};

use crate::text::{utf16_len, utf16_prefix};

pub const PREVIEW_GUARD: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedFull {
    pub content: String,
    pub tool_result: Option<String>,
    pub reasoning: Option<String>,
    pub tool_args: Option<String>,
}

impl ExtractedFull {
    fn text(content: impl Into<String>, tool_result: Option<String>) -> Self {
        Self {
            content: content.into(),
            tool_result,
            reasoning: None,
            tool_args: None,
        }
    }
}

fn obj<'a>(value: &'a Value) -> Option<&'a Map<String, Value>> {
    value.as_object()
}

fn s(value: &Value) -> Option<&str> {
    value.as_str()
}

fn bytes_to_string(arr: &[Value]) -> String {
    let mut bytes = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(n) = item.as_u64() else {
            return format!("[{} bytes]", arr.len());
        };
        if n > 255 {
            return format!("[{} bytes]", arr.len());
        }
        bytes.push(n as u8);
    }
    String::from_utf8(bytes).unwrap_or_else(|_| format!("[{} bytes]", arr.len()))
}

fn looks_like_bytes(arr: &[Value]) -> bool {
    arr.len() >= 16
        && arr.iter().all(|v| {
            v.as_u64().is_some_and(|n| n <= 255) && v.as_f64().is_some_and(|n| n.fract() == 0.0)
        })
}

fn strip_byte_arrays(value: &Value, depth: usize) -> Value {
    if depth > 6 || value.is_null() {
        return value.clone();
    }
    match value {
        Value::Array(items) => {
            if looks_like_bytes(items) {
                Value::String(bytes_to_string(items))
            } else {
                Value::Array(items.iter().map(|v| strip_byte_arrays(v, depth + 1)).collect())
            }
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), strip_byte_arrays(v, depth + 1));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn json_string(value: &Value) -> String {
    serde_json::to_string(&strip_byte_arrays(value, 0)).unwrap_or_else(|_| "[unserializable tool result]".to_string())
}

pub fn extract_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if content.is_null() {
        return String::new();
    }
    if let Some(items) = content.as_array() {
        return items
            .iter()
            .map(extract_text)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(map) = content.as_object() {
        if let Some(text) = map.get("text").and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn format_tool_result(update: &Value) -> Option<String> {
    let out = update.get("rawOutput")?;
    let Some(map) = out.as_object() else {
        return None;
    };
    let kind = map.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "Bash" {
        if let Some(prompt) = map.get("output_for_prompt").and_then(Value::as_str) {
            let exit = map.get("exit_code").map(|v| v.to_string()).unwrap_or_else(|| "?".to_string());
            let timed = if map.get("timed_out") == Some(&Value::Bool(true)) {
                " timed_out=true"
            } else {
                ""
            };
            let truncated = if map.get("truncated") == Some(&Value::Bool(true)) {
                " truncated=true"
            } else {
                ""
            };
            return Some(format!("{prompt}\n[exit_code={exit}{timed}{truncated}]"));
        }
    } else if kind == "GrepSearch" {
        if let Some(prompt) = map.get("output_for_prompt").and_then(Value::as_str) {
            return Some(prompt.to_string());
        }
        if let Some(stdout) = map.get("stdout").and_then(Value::as_array) {
            return Some(bytes_to_string(stdout));
        }
    } else if kind == "ReadFile" {
        if let Some(content) = map
            .get("FileContent")
            .and_then(Value::as_object)
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
        {
            return Some(content.to_string());
        }
    } else if kind == "SearchTool" {
        if let Some(content) = map.get("content").and_then(Value::as_str) {
            let prefix = map
                .get("result_count")
                .and_then(Value::as_f64)
                .map(|n| format!("[result_count={n}]\n"))
                .unwrap_or_default();
            return Some(format!("{prefix}{content}"));
        }
    } else if kind == "MCP" {
        let server = map.get("server_name").and_then(Value::as_str).unwrap_or("?");
        let tool = map.get("tool_name").and_then(Value::as_str).unwrap_or("?");
        let header = format!("[mcp {server}/{tool}]");
        let output = map.get("output");
        if let Some(text) = output.and_then(Value::as_str) {
            return Some(format!("{header}\n{text}"));
        }
        if let Some(ok) = output
            .and_then(Value::as_object)
            .and_then(|m| m.get("OkayOutput"))
            .and_then(Value::as_str)
        {
            return Some(format!("{header}\n{ok}"));
        }
        if let Some(err) = output
            .and_then(Value::as_object)
            .and_then(|m| m.get("ErrorOutput"))
            .and_then(Value::as_str)
        {
            return Some(format!("{header} ERROR\n{err}"));
        }
        if let Some(output) = output {
            return Some(format!("{header}\n{}", json_string(output)));
        }
    } else if kind == "ListDir" {
        if let Some(content) = map
            .get("Content")
            .and_then(Value::as_object)
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
        {
            return Some(content.to_string());
        }
    } else if kind == "Todo" {
        if let Some(summary) = map
            .get("TodosUpdated")
            .and_then(Value::as_object)
            .and_then(|m| m.get("summary_for_prompt"))
            .and_then(Value::as_str)
        {
            return Some(summary.to_string());
        }
    }
    Some(json_string(out))
}

pub fn format_missing_jsonl_message(file: &str, agent: Option<&str>, home: &str) -> String {
    let agent = agent.map(str::trim).filter(|s| !s.is_empty());
    let agent_bit = agent.map(|name| format!(" agent={name}")).unwrap_or_default();
    let home = home.trim_end_matches('/');
    let desk = (!home.is_empty() && !home.starts_with("/home/rivet") && file.starts_with(&format!("{home}/")))
        || file.starts_with("/Users/")
        || desk_home_path(file);
    let layout = if file.starts_with("/home/rivet/") {
        "Path is under /home/rivet/ — fleet agent home. The JSONL almost certainly lives on the mesh node that ran that harness session, not on the host serving this MCP query."
    } else if desk {
        "Path is a desk/user home directory. The JSONL is local to that machine’s interactive session store, not shared mesh storage."
    } else if file.contains("/.grok/sessions/")
        || file.contains("/.claude/")
        || file.contains("/.codex/sessions/")
        || file.contains("/opencode.db")
        || file.contains("/sessions/")
    {
        "Path looks like a per-host harness session store. Capture writes absolute paths on the node that produced the row."
    } else {
        "Capture records absolute paths on the node that produced the row; central MCP only reads what is mounted on *this* host."
    };
    let steps = [
        "Next steps (pick one):",
        "1. Re-run memory_get_full / rivet_memory_get_full on the node that owns this path (same host as the session dir), or via that node’s MCP sidecar.",
        "2. Use the truncated preview already on the row (content / tool_result) — that text is complete in Postgres up to the 16K capture cap.",
        "3. Do not treat this as permanent data loss: the elided tail is usually still on the capture host’s disk unless the session dir was deleted.",
    ]
    .join("\n");
    format!("Source JSONL not readable from this host ({file}).{agent_bit}\n\n{layout}\n\n{steps}")
}

fn desk_home_path(file: &str) -> bool {
    let rest = file.strip_prefix("/home/").unwrap_or("");
    if rest.is_empty() {
        return false;
    }
    let name = rest.split('/').next().unwrap_or("");
    !(name == "rivet" || name.is_empty())
}

pub fn is_capture_transcript_path(file: &str) -> bool {
    file.ends_with(".jsonl") || file.ends_with(".jsonl.zstd") || file.ends_with(".jsonl.zst")
}

pub fn is_capture_sqlite_path(file: &str) -> bool {
    file.ends_with(".db") || file.ends_with("opencode.db")
}

pub fn is_codex_session_key(key: Option<&str>) -> bool {
    let Some(key) = key else {
        return false;
    };
    let Some(rest) = key.strip_prefix("codex:") else {
        return false;
    };
    uuid_hex(rest)
}

fn uuid_hex(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8, 4, 4, 4, 12];
    let mut i = 0;
    for (g, size) in groups.iter().enumerate() {
        if g > 0 {
            if bytes.get(i) != Some(&b'-') {
                return false;
            }
            i += 1;
        }
        for _ in 0..*size {
            let Some(b) = bytes.get(i) else {
                return false;
            };
            if !b.is_ascii_hexdigit() {
                return false;
            }
            i += 1;
        }
    }
    i == bytes.len()
}

pub fn truncation_hint(meta: Option<&Map<String, Value>>, id: &str) -> String {
    let Some(meta) = meta else {
        return String::new();
    };
    if meta.get("truncated") != Some(&Value::Bool(true)) {
        return String::new();
    }
    let full = meta.get("full_content_length").or_else(|| meta.get("full_tool_result_length"));
    let len = match full.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => format!("{n} chars"),
        _ => "unknown length".to_string(),
    };
    format!("\n⚠ truncated at capture (full: {len}) → memory_get_full id={id}")
}

pub fn format_browse_message_body(
    id: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_result: Option<&str>,
    metadata: Option<&Map<String, Value>>,
    content_limit: usize,
    tool_result_limit: usize,
) -> String {
    let capture_trunc = metadata.and_then(|m| m.get("truncated")) == Some(&Value::Bool(true));
    let mut parts = Vec::new();
    if utf16_len(content) > content_limit {
        parts.push(format!("{}…", utf16_prefix(content, content_limit)));
        if !capture_trunc {
            parts.push(format!(
                "…[display-truncated content {} chars → memory_get_full id={id}]",
                utf16_len(content)
            ));
        }
    } else {
        parts.push(content.to_string());
    }
    if let Some(tool_result) = tool_result.filter(|text| !text.is_empty()) {
        let label = match tool_name {
            Some(name) if !name.is_empty() => format!("tool_result ({name})"),
            _ => "tool_result".to_string(),
        };
        if utf16_len(tool_result) > tool_result_limit {
            parts.push(format!(
                "[{label} {} chars]\n{}…",
                utf16_len(tool_result),
                utf16_prefix(tool_result, tool_result_limit)
            ));
            if !capture_trunc {
                parts.push(format!("…[display-truncated tool_result → memory_get_full id={id}]"));
            }
        } else {
            parts.push(format!("[{label}]\n{tool_result}"));
        }
    }
    let hint = truncation_hint(metadata, id);
    if !hint.is_empty() {
        parts.push(hint.trim_start_matches('\n').to_string());
    }
    parts.join("\n")
}

fn js_trim(text: &str) -> String {
    protocol::js::js_trim(text).to_string()
}

fn codex_content_text(content: &Value, want: &str) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    let joined = items
        .iter()
        .filter_map(obj)
        .filter_map(|block| {
            let text = block.get("text").and_then(Value::as_str)?;
            let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
            if kind != want && kind != "text" {
                return None;
            }
            Some(text)
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    js_trim(&joined)
}

pub fn extract_codex_from_line(value: &Value) -> Option<ExtractedFull> {
    let rec = obj(value)?;
    if rec.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let Some(payload) = rec.get("payload").and_then(obj) else {
        return Some(ExtractedFull::text("", None));
    };
    match payload.get("type").and_then(Value::as_str).unwrap_or("") {
        "message" => {
            let want = if payload.get("role").and_then(Value::as_str) == Some("assistant") {
                "output_text"
            } else {
                "input_text"
            };
            let content = payload.get("content").map(|c| codex_content_text(c, want)).unwrap_or_default();
            Some(ExtractedFull::text(content, None))
        }
        "reasoning" => {
            let mut parts = Vec::new();
            if let Some(text) = payload.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                parts.push(text.to_string());
            }
            let collect = |raw: Option<&Value>, parts: &mut Vec<String>| {
                let Some(items) = raw.and_then(Value::as_array) else {
                    return;
                };
                for item in items {
                    if let Some(text) = item.as_object().and_then(|m| m.get("text")).and_then(Value::as_str) {
                        if !text.is_empty() {
                            parts.push(text.to_string());
                        }
                    }
                }
            };
            collect(payload.get("summary"), &mut parts);
            collect(payload.get("content"), &mut parts);
            let thinking = parts.join("");
            let content = if thinking.is_empty() {
                String::new()
            } else {
                format!("[thinking] {thinking}")
            };
            Some(ExtractedFull::text(content, None))
        }
        "function_call" | "custom_tool_call" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| payload.get("tool").and_then(Value::as_str))
                .unwrap_or("unknown");
            let args = payload.get("input").or_else(|| payload.get("arguments"));
            let tool_result = match args {
                Some(Value::String(text)) => Some(text.clone()),
                Some(other) if !other.is_null() => Some(json_string(other)),
                _ => None,
            };
            Some(ExtractedFull::text(format!("[tool] {name}"), tool_result))
        }
        "function_call_output" | "custom_tool_call_output" => {
            let out = payload.get("output").or_else(|| payload.get("content"));
            let tool_result = match out {
                Some(Value::String(text)) => Some(text.clone()),
                Some(other) if !other.is_null() => Some(json_string(other)),
                _ => None,
            };
            Some(ExtractedFull::text("[tool-result]", tool_result))
        }
        _ => Some(ExtractedFull::text("", None)),
    }
}

fn record_items(raw: &Value) -> Vec<&Map<String, Value>> {
    if let Some(text) = raw.as_str().filter(|t| !t.is_empty()) {
        return Vec::new();
    }
    raw.as_array()
        .map(|items| items.iter().filter_map(obj).collect())
        .unwrap_or_default()
}

fn string_item(raw: &Value) -> Option<Vec<Map<String, Value>>> {
    if let Some(text) = raw.as_str().filter(|t| !t.is_empty()) {
        let mut map = Map::new();
        map.insert("type".to_string(), Value::String("text".to_string()));
        map.insert("text".to_string(), Value::String(text.to_string()));
        return Some(vec![map]);
    }
    None
}

pub fn extract_pi_from_line(value: &Value) -> Option<ExtractedFull> {
    let rec = obj(value)?;
    if rec.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = rec.get("message").and_then(obj).unwrap_or(rec);
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    if role.is_empty() {
        return None;
    }
    let owned;
    let items: Vec<&Map<String, Value>> = if let Some(raw) = message.get("content") {
        if let Some(list) = string_item(raw) {
            owned = list;
            owned.iter().collect()
        } else {
            record_items(raw)
        }
    } else {
        Vec::new()
    };
    let text_from = |list: &[&Map<String, Value>]| {
        let joined = list
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    return item.get("text").and_then(Value::as_str);
                }
                if item.get("type").is_none() {
                    return item.get("text").and_then(Value::as_str);
                }
                None
            })
            .filter(|text| !js_trim(text).is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        js_trim(&joined)
    };
    let thinking_from = |list: &[&Map<String, Value>]| {
        list.iter()
            .filter_map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("thinking") {
                    item.get("thinking").and_then(Value::as_str).filter(|t| !t.is_empty())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("")
    };
    if role == "toolResult" || role == "tool_result" {
        let name = message
            .get("toolName")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .or_else(|| message.get("name").and_then(Value::as_str).filter(|t| !t.is_empty()))
            .unwrap_or("unknown");
        let nested: Vec<&Map<String, Value>> = items
            .iter()
            .copied()
            .filter(|it| {
                matches!(it.get("type").and_then(Value::as_str), Some("toolResult" | "tool_result"))
            })
            .collect();
        let body = if nested.is_empty() { &items } else { &nested };
        let mut tool_result = text_from(body);
        if tool_result.is_empty() {
            let raw_result = message.get("result").or_else(|| message.get("content"));
            tool_result = match raw_result {
                Some(Value::String(text)) => text.clone(),
                Some(other) if !other.is_null() && !other.is_array() => json_string(other),
                _ => String::new(),
            };
        }
        let tool_result = if tool_result.is_empty() { None } else { Some(tool_result) };
        return Some(ExtractedFull {
            content: format!("[tool-result] {name}"),
            tool_result,
            reasoning: None,
            tool_args: None,
        });
    }
    if role == "user" {
        return Some(ExtractedFull::text(text_from(&items), None));
    }
    if role != "assistant" {
        return Some(ExtractedFull::text("", None));
    }
    let text = text_from(&items);
    let thinking = thinking_from(&items);
    let calls: Vec<&Map<String, Value>> = items
        .iter()
        .copied()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("toolCall" | "tool_call" | "toolUse" | "tool_use")
            )
        })
        .collect();
    if !calls.is_empty() {
        let first = calls[0];
        let name = first
            .get("name")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .or_else(|| first.get("toolName").and_then(Value::as_str).filter(|t| !t.is_empty()))
            .unwrap_or("unknown");
        let args = first.get("arguments").or_else(|| first.get("input"));
        let args_str = match args {
            Some(Value::String(text)) => Some(text.clone()),
            Some(other) if !other.is_null() => Some(json_string(other)),
            _ => None,
        };
        if text.is_empty() && thinking.is_empty() {
            return Some(ExtractedFull::text(format!("[tool] {name}"), args_str));
        }
        return Some(ExtractedFull {
            content: text,
            tool_result: args_str,
            reasoning: if thinking.is_empty() { None } else { Some(thinking) },
            tool_args: None,
        });
    }
    Some(ExtractedFull {
        content: text,
        tool_result: None,
        reasoning: if thinking.is_empty() { None } else { Some(thinking) },
        tool_args: None,
    })
}

pub fn extract_qwen_from_line(value: &Value) -> Option<ExtractedFull> {
    let rec = obj(value)?;
    let kind = rec.get("type").and_then(Value::as_str)?;
    if !matches!(kind, "user" | "assistant" | "tool_result") {
        return None;
    }
    let message = rec.get("message").and_then(obj)?;
    let parts = message.get("parts")?.as_array()?;
    let parts: Vec<&Map<String, Value>> = parts.iter().filter_map(obj).collect();
    let text_from = |thought: Option<bool>| {
        parts
            .iter()
            .filter_map(|p| {
                let text = p.get("text").and_then(Value::as_str).filter(|t| !t.is_empty())?;
                let is_thought = p.get("thought") == Some(&Value::Bool(true));
                match thought {
                    Some(true) if !is_thought => None,
                    Some(false) if is_thought => None,
                    _ => Some(text),
                }
            })
            .collect::<String>()
    };
    if kind == "user" {
        return Some(ExtractedFull::text(js_trim(&text_from(None)), None));
    }
    if kind == "tool_result" {
        let mut name = "unknown".to_string();
        let mut output = None;
        for p in &parts {
            let Some(fr) = p.get("functionResponse").and_then(obj) else {
                continue;
            };
            if let Some(n) = fr.get("name").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                name = n.to_string();
            }
            if let Some(resp) = fr.get("response").and_then(obj) {
                if let Some(out) = resp.get("output") {
                    output = match out {
                        Value::String(text) => Some(text.clone()),
                        other if !other.is_null() => Some(json_string(other)),
                        _ => None,
                    };
                }
            }
        }
        return Some(ExtractedFull::text(format!("[tool-result] {name}"), output));
    }
    let thinking = text_from(Some(true));
    let text = js_trim(&text_from(Some(false)));
    let calls: Vec<&Map<String, Value>> = parts.iter().filter_map(|p| p.get("functionCall").and_then(obj)).collect();
    if !calls.is_empty() {
        let first = calls[0];
        let name = first.get("name").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("unknown");
        let args = first.get("args").or_else(|| first.get("arguments"));
        let args_str = match args {
            Some(Value::String(text)) => Some(text.clone()),
            Some(other) if !other.is_null() => Some(json_string(other)),
            _ => None,
        };
        if text.is_empty() && thinking.is_empty() {
            return Some(ExtractedFull::text(format!("[tool] {name}"), args_str));
        }
        if text.is_empty() {
            return Some(ExtractedFull {
                content: format!("[tool] {name}"),
                tool_result: args_str,
                reasoning: if thinking.is_empty() { None } else { Some(thinking) },
                tool_args: None,
            });
        }
        return Some(ExtractedFull {
            content: text,
            tool_result: args_str,
            reasoning: if thinking.is_empty() { None } else { Some(thinking) },
            tool_args: None,
        });
    }
    Some(ExtractedFull {
        content: text,
        tool_result: None,
        reasoning: if thinking.is_empty() { None } else { Some(thinking) },
        tool_args: None,
    })
}

fn grokbot_body(part: &Map<String, Value>) -> Option<String> {
    let body = part.get("result").or_else(|| part.get("content")).or_else(|| part.get("output"))?;
    match body {
        Value::String(text) => Some(text.clone()),
        other if !other.is_null() => Some(json_string(other)),
        _ => None,
    }
}

fn grokbot_id(part: &Map<String, Value>) -> Option<String> {
    for key in ["tool_use_id", "toolUseId", "id"] {
        if let Some(text) = part.get(key).and_then(Value::as_str).filter(|t| !t.is_empty()) {
            return Some(text.to_string());
        }
    }
    None
}

pub fn extract_grokbot_from_line(value: &Value, meta: Option<&Map<String, Value>>) -> Option<ExtractedFull> {
    let rec = obj(value)?;
    let role = rec.get("role").and_then(Value::as_str).unwrap_or("");
    if role.is_empty() {
        return None;
    }
    let message = rec.get("message").and_then(obj).unwrap_or(rec);
    let content = message.get("content")?.as_array()?;
    let mut texts = Vec::new();
    let mut results = Vec::new();
    for part in content.iter().filter_map(obj) {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "tool_result" || role == "tool" {
            if let Some(body) = grokbot_body(part) {
                results.push((body, grokbot_id(part), part.get("name").and_then(Value::as_str).map(str::to_string)));
            }
            continue;
        }
        if kind == "text" {
            if let Some(text) = part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                texts.push(text.to_string());
            }
        }
    }
    Some(ExtractedFull::text(texts.join("\n"), pick_grokbot(&results, meta)))
}

fn pick_grokbot(
    results: &[(String, Option<String>, Option<String>)],
    meta: Option<&Map<String, Value>>,
) -> Option<String> {
    if results.is_empty() {
        return None;
    }
    if let Some(tool_id) = meta.and_then(|m| m.get("tool_id")).and_then(Value::as_str).filter(|t| !t.is_empty()) {
        if let Some((body, _, _)) = results.iter().find(|(_, id, _)| id.as_deref() == Some(tool_id)) {
            return Some(body.clone());
        }
    }
    if let Some(ordinal) = meta.and_then(|m| m.get("ordinal")).and_then(Value::as_f64).filter(|n| n.is_finite()) {
        let idx = ((ordinal as i64).rem_euclid(1000)) as usize;
        if let Some((body, _, _)) = results.get(idx) {
            return Some(body.clone());
        }
    }
    if let Some(name) = meta.and_then(|m| m.get("tool_name")).and_then(Value::as_str).filter(|t| !t.is_empty()) {
        let matches: Vec<_> = results.iter().filter(|(_, _, n)| n.as_deref() == Some(name)).collect();
        if matches.len() == 1 {
            return Some(matches[0].0.clone());
        }
    }
    results.last().map(|(body, _, _)| body.clone())
}

fn part_text(part: &Map<String, Value>) -> String {
    if let Some(text) = part.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = part.get("text").and_then(obj) {
        if let Some(value) = text.get("value").and_then(Value::as_str) {
            return value.to_string();
        }
    }
    part.get("content").and_then(Value::as_str).unwrap_or("").to_string()
}

fn stringify_args(args: Option<&Value>) -> Option<String> {
    match args {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(json_string(other)),
    }
}

pub fn extract_opencode_from_part(data: &Value) -> ExtractedFull {
    let Some(part) = data.as_object() else {
        return ExtractedFull::text("", None);
    };
    let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
    if matches!(kind, "reasoning" | "thinking" | "think") {
        let chunk = js_trim(&part_text(part));
        let content = if chunk.is_empty() { String::new() } else { format!("[thinking] {chunk}") };
        return ExtractedFull::text(content, None);
    }
    if matches!(kind, "tool" | "tool_use" | "tool-call") {
        let name = part
            .get("tool")
            .and_then(Value::as_str)
            .or_else(|| part.get("name").and_then(Value::as_str))
            .unwrap_or("tool");
        let state = part.get("state").and_then(obj);
        let out = state.and_then(|m| m.get("output")).or_else(|| part.get("output")).or_else(|| part.get("result"));
        let tool_result = match out {
            Some(Value::String(text)) => Some(text.clone()),
            Some(other) if !other.is_null() => Some(json_string(other)),
            _ => None,
        };
        let nested = part.get("tool").and_then(obj);
        let args = state
            .and_then(|m| m.get("input"))
            .or_else(|| nested.and_then(|m| m.get("input")))
            .or_else(|| nested.and_then(|m| m.get("args")))
            .or_else(|| part.get("input"))
            .or_else(|| part.get("args"));
        let is_error = part.get("isError") == Some(&Value::Bool(true))
            || state.and_then(|m| m.get("status")).and_then(Value::as_str) == Some("error");
        let content = if is_error {
            format!("[tool-failure] {name}")
        } else {
            format!("[tool-result] {name}")
        };
        return ExtractedFull {
            content,
            tool_result,
            reasoning: None,
            tool_args: stringify_args(args),
        };
    }
    ExtractedFull::text(part_text(part), None)
}

pub fn read_opencode_part(db_path: &str, part_id: &str) -> Option<ExtractedFull> {
    let conn = rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut stmt = conn.prepare("SELECT data FROM part WHERE id = ?").ok()?;
    let data: String = stmt.query_row([part_id], |row| row.get(0)).ok()?;
    let parsed = serde_json::from_str::<Value>(&data).ok();
    Some(match parsed {
        Some(value) => extract_opencode_from_part(&value),
        None => ExtractedFull::text(data, None),
    })
}

fn is_grokbot_meta(meta: Option<&Map<String, Value>>) -> bool {
    let Some(meta) = meta else {
        return false;
    };
    if meta.get("source").and_then(Value::as_str) == Some("grokbot") {
        return true;
    }
    meta.get("capture_source")
        .and_then(Value::as_str)
        .is_some_and(|cs| cs.starts_with("grokbot"))
}

fn is_pi_meta(meta: Option<&Map<String, Value>>) -> bool {
    let Some(meta) = meta else {
        return false;
    };
    if meta.get("source").and_then(Value::as_str) == Some("pi-session") {
        return true;
    }
    meta.get("sourceEvent")
        .and_then(Value::as_str)
        .is_some_and(|event| event.starts_with("message:"))
}

fn is_qwen_meta(meta: Option<&Map<String, Value>>) -> bool {
    meta.and_then(|m| m.get("source")).and_then(Value::as_str) == Some("qwen-session")
}

pub fn extract_full_from_line(raw: &str, meta: Option<&Map<String, Value>>) -> ExtractedFull {
    let value = match serde_json::from_str::<Value>(raw) {
        Ok(value) => value,
        Err(_) => return ExtractedFull::text("", None),
    };
    if is_grokbot_meta(meta) {
        if let Some(hit) = extract_grokbot_from_line(&value, meta) {
            return hit;
        }
    }
    if is_pi_meta(meta) {
        if let Some(hit) = extract_pi_from_line(&value) {
            return hit;
        }
    }
    if is_qwen_meta(meta) {
        if let Some(hit) = extract_qwen_from_line(&value) {
            return hit;
        }
    }
    if let Some(hit) = extract_codex_from_line(&value) {
        return hit;
    }
    if let Some(hit) = extract_qwen_from_line(&value) {
        return hit;
    }
    if let Some(hit) = extract_pi_from_line(&value) {
        return hit;
    }
    if let Some(event_type) = value.get("type").and_then(Value::as_str) {
        if event_type.contains('/') {
            return extract_dsh(&value, event_type);
        }
    }
    let update = value
        .get("params")
        .and_then(|p| p.get("update"))
        .or_else(|| value.get("update"))
        .unwrap_or(&value);
    let text = update.get("content").map(extract_text).unwrap_or_default();
    let content = if update.get("sessionUpdate").and_then(Value::as_str) == Some("agent_thought_chunk") {
        format!("[thinking] {text}")
    } else {
        text
    };
    ExtractedFull::text(content, format_tool_result(update))
}

fn extract_dsh(value: &Value, event_type: &str) -> ExtractedFull {
    let data = value.get("data").and_then(obj);
    let empty = Map::new();
    let data = data.unwrap_or(&empty);
    if event_type == "user/message" {
        let content = data.get("content").map(extract_text).unwrap_or_default();
        return ExtractedFull::text(content, None);
    }
    if event_type == "assistant/message" {
        let message = data.get("message").and_then(obj);
        let content = message
            .and_then(|m| m.get("content"))
            .or_else(|| data.get("content"))
            .map(extract_text)
            .unwrap_or_default();
        return ExtractedFull::text(content, None);
    }
    if event_type == "tool/call" {
        let name = data.get("name").and_then(Value::as_str).unwrap_or("unknown");
        let args = data.get("arguments").and_then(Value::as_str).map(str::to_string);
        return ExtractedFull::text(format!("[tool] {name}"), args);
    }
    if event_type == "tool/result" {
        let message = data.get("message").and_then(obj);
        let name = message
            .and_then(|m| m.get("name"))
            .and_then(Value::as_str)
            .or_else(|| data.get("name").and_then(Value::as_str))
            .unwrap_or("unknown");
        let raw_content = message.and_then(|m| m.get("content")).or_else(|| data.get("content"));
        let mut result = raw_content.map(extract_text).unwrap_or_default();
        if let Some(items) = raw_content.and_then(Value::as_array) {
            let nested = items
                .iter()
                .filter(|p| {
                    matches!(
                        p.get("type").and_then(Value::as_str),
                        Some("tool-result" | "tool_result")
                    )
                })
                .map(|p| p.get("content").map(extract_text).unwrap_or_default())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>();
            if !nested.is_empty() {
                result = nested.join("\n");
            }
        }
        let tool_result = if result.is_empty() { None } else { Some(result) };
        return ExtractedFull::text(format!("[tool-result] {name}"), tool_result);
    }
    ExtractedFull::text("", None)
}

pub fn read_jsonl_line(file: &str, line_index: usize) -> Result<Option<String>, String> {
    let text = if file.ends_with(".jsonl.zstd") || file.ends_with(".jsonl.zst") {
        let bytes = std::fs::read(file).map_err(|err| err.to_string())?;
        let decoded = zstd::stream::decode_all(bytes.as_slice()).map_err(|err| err.to_string())?;
        String::from_utf8(decoded).map_err(|err| err.to_string())?
    } else {
        std::fs::read_to_string(file).map_err(|err| err.to_string())?
    };
    Ok(line_at(&text, line_index))
}

fn line_at(text: &str, line_index: usize) -> Option<String> {
    let mut lines = Vec::new();
    for line in text.split('\n') {
        lines.push(line);
    }
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.get(line_index).map(|line| (*line).to_string())
}

pub fn render_stored_row(id: &str, content: &str, tool_name: Option<&str>, tool_result: Option<&str>) -> String {
    let tool = match tool_name {
        Some(name) if !name.is_empty() => format!("\n\n[tool: {name}]\n{}", tool_result.unwrap_or("")),
        _ => String::new(),
    };
    format!("(row was not truncated — stored payload is complete)\n\n{content}{tool}")
}

pub fn render_extracted(id: &str, source: &str, meta: &Map<String, Value>, extracted: &ExtractedFull, tool_name: Option<&str>) -> String {
    let mut sections = vec![format!("## Full payload for {id} (from {source})")];
    if meta.get("full_content_length").and_then(Value::as_f64).is_some() && !extracted.content.is_empty() {
        let shown = utf16_prefix(&extracted.content, PREVIEW_GUARD);
        sections.push(format!("### content ({} chars)\n{shown}", utf16_len(&extracted.content)));
    }
    if let Some(reasoning) = &extracted.reasoning {
        if meta.get("full_reasoning_length").and_then(Value::as_f64).is_some() && !reasoning.is_empty() {
            let shown = utf16_prefix(reasoning, PREVIEW_GUARD);
            sections.push(format!("### reasoning ({} chars)\n{shown}", utf16_len(reasoning)));
        }
    }
    if let Some(args) = &extracted.tool_args {
        if meta.get("full_tool_args_length").and_then(Value::as_f64).is_some() && !args.is_empty() {
            let label = tool_name.map(|name| format!(" ({name})")).unwrap_or_default();
            let shown = utf16_prefix(args, PREVIEW_GUARD);
            sections.push(format!("### tool_args{label} ({} chars)\n{shown}", utf16_len(args)));
        }
    }
    if let Some(tool_result) = &extracted.tool_result {
        if meta.get("full_tool_result_length").and_then(Value::as_f64).is_some() && !tool_result.is_empty() {
            let label = tool_name.map(|name| format!(" ({name})")).unwrap_or_default();
            let shown = utf16_prefix(tool_result, PREVIEW_GUARD);
            sections.push(format!("### tool_result{label} ({} chars)\n{shown}", utf16_len(tool_result)));
        }
    }
    if sections.len() == 1 {
        if source.contains(" part ") {
            let part = source.rsplit(" part ").next().unwrap_or("");
            let file = source.split(" part ").next().unwrap_or(source);
            return format!("Re-read {file} part {part} but could not re-derive the elided field — the part shape may have changed.");
        }
        return format!("Re-read {source} but could not re-derive the elided field — the line shape may have changed.");
    }
    sections.join("\n\n")
}

pub fn missing_pointer_message() -> &'static str {
    "Row is truncated but carries no disk pointer (pre-#196 capture, or a non-grok source) — the elided tail is unrecoverable."
}

pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

pub fn file_missing_message(file: &str, agent: Option<&str>) -> String {
    format_missing_jsonl_message(file, agent, &home_dir())
}

pub fn path_exists(file: &str) -> bool {
    Path::new(file).exists()
}

pub fn read_prefix<R: Read>(reader: &mut R, limit: usize) -> Result<Vec<u8>, std::io::Error> {
    let mut buf = vec![0; limit];
    let n = reader.read(&mut buf)?;
    buf.truncate(n);
    Ok(buf)
}
