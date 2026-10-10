use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::jsonl::{objects_of, parse_object};
use crate::text::content_text;
use crate::value::{Obj, jtrim};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<String>,
}

impl CaptureMessage {
    fn new(role: &str, content: impl Into<String>) -> Self {
        Self { role: role.into(), content: content.into(), tool_name: None, tool_result: None }
    }

    fn tool(content: impl Into<String>, name: impl Into<String>, result: Option<String>) -> Self {
        Self { role: "tool".into(), content: content.into(), tool_name: Some(name.into()), tool_result: result }
    }
}

pub fn claude_capture_text(text: &str) -> Vec<CaptureMessage> {
    let lines = split_keep(text);
    let objects: Vec<(usize, Obj)> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| parse_object(jtrim(line)).map(|obj| (index, obj)))
        .collect();
    let mut results = HashMap::new();
    for (_, obj) in &objects {
        for block in blocks(obj) {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            results.insert(id.to_string(), block_text(block.get("content")));
        }
    }
    let mut out = Vec::new();
    for (_, obj) in &objects {
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if obj.get("isMeta").is_some_and(|value| !matches!(value, Value::Null | Value::Bool(false))) && obj.get("isMeta") != Some(&Value::Bool(false))
            && obj.get("isMeta").is_some_and(truthy)
        {
            continue;
        }
        let message = obj.get("message").and_then(Value::as_object);
        let role = message.and_then(|row| row.get("role")).and_then(Value::as_str).unwrap_or(kind);
        let content = message.and_then(|row| row.get("content"));
        let mut text_parts = Vec::new();
        let mut think_parts = Vec::new();
        let mut res_parts = Vec::new();
        let mut tools = Vec::new();
        if let Some(raw) = content.and_then(Value::as_str) {
            text_parts.push(raw.to_string());
        } else if let Some(blocks) = content.and_then(Value::as_array) {
            for block in blocks.iter().filter_map(Value::as_object) {
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => text_parts.push(block.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                    "thinking" => think_parts.push(
                        block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .or_else(|| block.get("text").and_then(Value::as_str))
                            .unwrap_or("")
                            .to_string(),
                    ),
                    "tool_use" => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("unknown").to_string();
                        let id = block.get("id").and_then(Value::as_str).map(str::to_string);
                        let result = id.as_ref().and_then(|id| results.get(id).cloned());
                        tools.push((name, result));
                    }
                    "tool_result" => res_parts.push(block_text(block.get("content"))),
                    _ => {}
                }
            }
        }
        let mut body = text_parts.join("\n");
        body = jtrim(&body).to_string();
        if body.is_empty() && !think_parts.is_empty() {
            body = format!("[thinking] {}", jtrim(&think_parts.join("\n")));
        }
        let tool_result = if res_parts.is_empty() { None } else { Some(res_parts.join("\n")) };
        if body.is_empty() && !tools.is_empty() {
            let names = tools.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(", ");
            body = format!("[tool call] {names}");
        }
        if body.is_empty()
            && let Some(result) = &tool_result {
                body.clone_from(result);
            }
        if body.is_empty() && tool_result.is_none() {
            continue;
        }
        let mut message = CaptureMessage::new(role, body);
        if let Some((name, result)) = tools.first() {
            message.tool_name = Some(name.clone());
            if message.tool_result.is_none() {
                message.tool_result = result.clone();
            }
        }
        if message.tool_result.is_none() {
            message.tool_result = tool_result;
        }
        out.push(message);
    }
    out
}

pub fn codex_capture_text(text: &str) -> Vec<CaptureMessage> {
    let mut names = HashMap::new();
    let mut out = Vec::new();
    for obj in objects_of(text) {
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        let Some(payload) = obj.get("payload").and_then(Value::as_object).cloned().or_else(|| {
            if kind == "response_item" { obj.get("item").and_then(Value::as_object).cloned() } else { None }
        }) else {
            continue;
        };
        if kind != "response_item" {
            continue;
        }
        match payload.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => {
                let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                if role == "developer" {
                    continue;
                }
                let want = if role == "user" { "input_text" } else { "output_text" };
                let Some(body) = content_text(payload.get("content").unwrap_or(&Value::Null), want) else {
                    continue;
                };
                if role == "user" || role == "assistant" {
                    out.push(CaptureMessage::new(role, body));
                }
            }
            "reasoning" => {
                if let Some(chunk) = reasoning_text(&payload) {
                    out.push(CaptureMessage::new("assistant", format!("[thinking] {chunk}")));
                }
            }
            "function_call" | "custom_tool_call" => {
                let name = payload.get("name").and_then(Value::as_str).or_else(|| payload.get("tool").and_then(Value::as_str)).unwrap_or("unknown");
                if let Some(id) = payload.get("call_id").and_then(Value::as_str).or_else(|| payload.get("id").and_then(Value::as_str)) {
                    names.insert(id.to_string(), name.to_string());
                }
                out.push(CaptureMessage::tool(format!("[tool] {name}"), name, None));
            }
            "function_call_output" | "custom_tool_call_output" => {
                let id = payload.get("call_id").and_then(Value::as_str).or_else(|| payload.get("id").and_then(Value::as_str));
                let name = id.and_then(|id| names.get(id)).map(String::as_str).unwrap_or("unknown");
                let failure = payload.get("error").is_some_and(truthy);
                let result = payload.get("output").or_else(|| payload.get("content")).map(jsonish);
                let label = if failure { "tool-failure" } else { "tool-result" };
                out.push(CaptureMessage::tool(format!("[{label}] {name}"), name, result));
            }
            _ => {}
        }
    }
    out
}

pub fn kimi_capture_text(text: &str) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    for obj in objects_of(text) {
        if obj.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
            continue;
        }
        let Some(event) = obj.get("event").and_then(Value::as_object) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("content.part") {
            continue;
        }
        let Some(part) = event.get("part").and_then(Value::as_object) else {
            continue;
        };
        let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
        let body = if part_type == "text" {
            part.get("text").and_then(Value::as_str)
        } else if part_type == "think" {
            part.get("think").and_then(Value::as_str)
        } else {
            None
        };
        let Some(body) = body.filter(|text| !text.is_empty()) else {
            continue;
        };
        let content = if part_type == "think" { format!("[thinking] {body}") } else { body.to_string() };
        out.push(CaptureMessage::new("assistant", content));
    }
    out
}

pub fn grok_capture_updates(text: &str) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    let mut pending = HashMap::new();
    for obj in objects_of(text) {
        let Some(params) = obj.get("params").and_then(Value::as_object) else {
            continue;
        };
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            continue;
        };
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
        match kind {
            "user_message_chunk" => {
                if let Some(body) = update_text(update.get("content")) {
                    out.push(CaptureMessage::new("user", body));
                }
            }
            "agent_message_chunk" => {
                if let Some(body) = update_text(update.get("content")) {
                    out.push(CaptureMessage::new("assistant", body));
                }
            }
            "agent_thought_chunk" => {
                if let Some(body) = update_text(update.get("content")) {
                    out.push(CaptureMessage::new("assistant", format!("[thinking] {body}")));
                }
            }
            "tool_call" => {
                if let Some(id) = update.get("toolCallId").and_then(Value::as_str) {
                    pending.insert(id.to_string(), update.get("title").and_then(Value::as_str).unwrap_or("?").to_string());
                }
            }
            "tool_call_update"
                if update.get("status").and_then(Value::as_str) == Some("completed") => {
                    let id = update.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                    let name = pending.get(id).cloned().or_else(|| update.get("title").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| "?".into());
                    let result = update.get("rawOutput").or_else(|| update.get("content")).or_else(|| update.get("output")).map(jsonish);
                    out.push(CaptureMessage::tool(format!("[tool] {name}"), name, result));
                }
            _ => {}
        }
    }
    out
}

pub fn pi_capture_text(text: &str) -> Vec<CaptureMessage> {
    let mut names = HashMap::new();
    let mut out = Vec::new();
    for obj in objects_of(text) {
        if obj.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = obj.get("message").and_then(Value::as_object).unwrap_or(&obj);
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "toolResult" || role == "tool_result" {
            let call_id = message.get("toolCallId").and_then(Value::as_str).or_else(|| message.get("id").and_then(Value::as_str));
            let name = message
                .get("toolName")
                .and_then(Value::as_str)
                .or_else(|| call_id.and_then(|id| names.get(id)).map(String::as_str))
                .unwrap_or("unknown");
            let result = message.get("result").or_else(|| message.get("content")).map(jsonish);
            out.push(CaptureMessage::tool(format!("[tool-result] {name}"), name, result));
            continue;
        }
        if role == "user" {
            if let Some(body) = text_items(message) {
                out.push(CaptureMessage::new("user", body));
            }
            continue;
        }
        if role != "assistant" {
            continue;
        }
        let body = text_items(message);
        let thinking = thinking_items(message);
        if body.is_none() && thinking.is_none() && tool_items(message).is_empty() {
            continue;
        }
        if body.is_some() || thinking.is_some() {
            let mut message_out = CaptureMessage::new("assistant", body.unwrap_or_default());
            if message_out.content.is_empty()
                && let Some(think) = thinking.clone() {
                    message_out.content = format!("[thinking] {think}");
                }
            out.push(message_out);
        }
        for item in tool_items(message) {
            let name = item.get("name").and_then(Value::as_str).or_else(|| item.get("toolName").and_then(Value::as_str)).unwrap_or("unknown");
            if let Some(id) = item.get("id").and_then(Value::as_str).or_else(|| item.get("toolCallId").and_then(Value::as_str)) {
                names.insert(id.to_string(), name.to_string());
            }
            out.push(CaptureMessage::tool(format!("[tool] {name}"), name, None));
        }
    }
    out
}

pub fn qwen_capture_text(text: &str) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    for obj in objects_of(text) {
        match obj.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                if obj.get("provenance").and_then(Value::as_str) != Some("real_user") {
                    continue;
                }
                let message = obj.get("message").and_then(Value::as_object);
                let owned = join_parts(message, false);
                let body = jtrim(&owned);
                if !body.is_empty() {
                    out.push(CaptureMessage::new("user", body));
                }
            }
            "assistant" => {
                let message = obj.get("message").and_then(Value::as_object);
                let thinking = join_parts(message, true);
                let content = jtrim(&join_parts(message, false)).to_string();
                let call = first_call(message);
                if content.is_empty() && !thinking.is_empty() && call.is_none() {
                    out.push(CaptureMessage::new("assistant", format!("[thinking] {thinking}")));
                    continue;
                }
                if content.is_empty()
                    && let Some(name) = call {
                        out.push(CaptureMessage::tool(format!("[tool] {name}"), name, None));
                        continue;
                    }
                if content.is_empty() && thinking.is_empty() {
                    continue;
                }
                let body = if content.is_empty() { format!("[thinking] {thinking}") } else { content };
                out.push(CaptureMessage::new("assistant", body));
            }
            "tool_result" => {
                let message = obj.get("message").and_then(Value::as_object);
                let (name, output) = qwen_result(message);
                out.push(CaptureMessage::tool(format!("[tool-result] {name}"), name, output));
            }
            _ => {}
        }
    }
    out
}

pub fn cursor_capture_objects(objects: &[Obj]) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    for obj in objects {
        let role = obj.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let message = obj.get("message").and_then(Value::as_object).unwrap_or(obj);
        let Some(content) = message.get("content") else {
            continue;
        };
        if let Some(text) = content.as_str() {
            let trimmed = jtrim(text);
            if !trimmed.is_empty() {
                out.push(CaptureMessage::new(role, trimmed));
            }
            continue;
        }
        let Some(parts) = content.as_array() else {
            continue;
        };
        for part in parts.iter().filter_map(Value::as_object) {
            match part.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    if let Some(text) = part.get("text").and_then(Value::as_str)
                        && !jtrim(text).is_empty() {
                            out.push(CaptureMessage::new(role, text));
                        }
                }
                "tool_use" => {
                    let name = part.get("name").and_then(Value::as_str).unwrap_or("unknown");
                    out.push(CaptureMessage::tool(format!("[tool] {name}"), name, None));
                }
                _ => {}
            }
        }
    }
    out
}

pub fn cowork_capture_lines(lines: &[String]) -> Vec<CaptureMessage> {
    let parsed: Vec<Obj> = lines.iter().filter_map(|line| parse_object(line)).collect();
    let mut results = HashMap::new();
    for obj in &parsed {
        for (id, text) in tool_results(obj) {
            results.insert(id, text);
        }
    }
    let mut out = Vec::new();
    for obj in &parsed {
        let prompt = text_of(obj);
        let uses = tool_uses(obj);
        let here = tool_results(obj);
        let assistant = obj.get("type").and_then(Value::as_str) == Some("assistant")
            || obj.get("message").and_then(Value::as_object).and_then(|row| row.get("role")).and_then(Value::as_str) == Some("assistant");
        if !prompt.is_empty() && uses.is_empty() && here.is_empty() && obj.get("type").and_then(Value::as_str) != Some("ai-title") {
            out.push(CaptureMessage::new(if assistant { "assistant" } else { "user" }, prompt.clone()));
        } else if !prompt.is_empty() && !uses.is_empty() {
            out.push(CaptureMessage::new("assistant", prompt));
        }
        for (name, id) in &uses {
            let result = id.as_ref().and_then(|id| results.get(id).cloned());
            out.push(CaptureMessage::tool(format!("[tool call] {name}"), name, result));
        }
    }
    out
}

pub fn hermes_capture_rows(rows: &[Obj]) -> Vec<CaptureMessage> {
    rows.iter()
        .filter_map(|row| {
            let role = row.get("role").and_then(Value::as_str).unwrap_or("");
            let content = row.get("content").and_then(Value::as_str).unwrap_or("");
            if role == "tool" || row.get("tool_call_id").and_then(Value::as_str).is_some() {
                let name = row.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
                return Some(CaptureMessage::tool(format!("[tool] {name}"), name, Some(content.to_string())));
            }
            if content.is_empty() {
                return None;
            }
            Some(CaptureMessage::new(role, content))
        })
        .collect()
}

pub fn opencode_capture_parts(parts: &[Obj]) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    for part in parts {
        let data = part.get("data").cloned().or_else(|| Some(Value::Object(part.clone()))).unwrap_or(Value::Null);
        let Some(data) = data.as_object() else {
            continue;
        };
        let kind = data.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "step-start" | "step_start" | "step-finish" | "step_finish") {
            continue;
        }
        let role = part.get("role").and_then(Value::as_str).or_else(|| data.get("role").and_then(Value::as_str)).unwrap_or("assistant");
        if role == "system" {
            continue;
        }
        if matches!(kind, "reasoning" | "thinking" | "think") {
            let chunk = jtrim(data.get("text").and_then(Value::as_str).unwrap_or(""));
            if !chunk.is_empty() {
                out.push(CaptureMessage::new("assistant", format!("[thinking] {chunk}")));
            }
            continue;
        }
        if matches!(kind, "tool" | "tool_use" | "tool-call") {
            let name = data.get("tool").and_then(Value::as_str).or_else(|| data.get("name").and_then(Value::as_str)).unwrap_or("tool");
            let state = data.get("state").and_then(Value::as_object);
            let status = state.and_then(|row| row.get("status")).and_then(Value::as_str).unwrap_or("");
            let failure = data.get("isError") == Some(&Value::Bool(true)) || status == "error";
            let result = state.and_then(|row| row.get("output").or_else(|| row.get("error"))).or_else(|| data.get("output")).map(jsonish);
            if (status == "running" || status == "pending") && result.is_none() {
                continue;
            }
            let label = if failure { "tool-failure" } else { "tool-result" };
            out.push(CaptureMessage::tool(format!("[{label}] {name}"), name, result));
            continue;
        }
        if kind == "text" || kind.is_empty() || kind == "content" {
            let text = jtrim(data.get("text").and_then(Value::as_str).unwrap_or(""));
            if text.is_empty() {
                continue;
            }
            let role = if role == "assistant" { "assistant" } else { "user" };
            out.push(CaptureMessage::new(role, text));
        }
    }
    out
}

fn jtrim_used(text: &str) -> String {
    jtrim(text).to_string()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) if text.is_empty() => false,
        Value::Number(number) if number.as_f64() == Some(0.0) => false,
        _ => true,
    }
}

fn split_keep(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_string).collect()
}

fn blocks(obj: &Obj) -> Vec<&Obj> {
    obj.get("message")
        .and_then(Value::as_object)
        .and_then(|row| row.get("content"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

fn block_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().or_else(|| item.as_object().and_then(|row| row.get("text")).and_then(Value::as_str)).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn jsonish(value: &Value) -> String {
    if let Some(text) = value.as_str() { text.to_string() } else { value.to_string() }
}

fn reasoning_text(payload: &Obj) -> Option<String> {
    if let Some(text) = payload.get("text").and_then(Value::as_str)
        && !text.is_empty() {
            return Some(text.to_string());
        }
    payload.get("summary").and_then(Value::as_array).and_then(|items| {
        let text = items.iter().filter_map(|item| item.as_object()).filter_map(|row| row.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("");
        (!text.is_empty()).then_some(text)
    })
}

fn update_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(text) = content.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    let text = content
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|row| row.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn text_items(message: &Obj) -> Option<String> {
    let text = item_texts(message, false);
    (!text.is_empty()).then_some(text)
}

fn thinking_items(message: &Obj) -> Option<String> {
    let text = item_texts(message, true);
    (!text.is_empty()).then_some(text)
}

fn item_texts(message: &Obj, thinking: bool) -> String {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_object)
                .filter_map(|row| {
                    let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
                    if thinking {
                        (kind == "thinking" || kind == "reasoning").then(|| row.get("thinking").or_else(|| row.get("text")).and_then(Value::as_str).unwrap_or(""))
                    } else {
                        (kind == "text" || kind == "input_text" || kind == "output_text").then(|| row.get("text").and_then(Value::as_str).unwrap_or(""))
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn tool_items(message: &Obj) -> Vec<Obj> {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_object)
                .filter(|row| {
                    let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
                    kind == "toolCall" || kind == "tool_call" || kind == "functionCall"
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn join_parts(message: Option<&Obj>, thought: bool) -> String {
    let Some(parts) = message.and_then(|row| row.get("parts").or_else(|| row.get("content"))).and_then(Value::as_array) else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(Value::as_object)
        .filter(|part| part.get("thought") == Some(&Value::Bool(true)) || part.get("thought") == Some(&Value::Bool(false)) || true)
        .filter(|part| (part.get("thought") == Some(&Value::Bool(true))) == thought)
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn first_call(message: Option<&Obj>) -> Option<String> {
    let parts = message?.get("parts").or_else(|| message?.get("content"))?.as_array()?;
    for part in parts.iter().filter_map(Value::as_object) {
        if let Some(call) = part.get("functionCall").and_then(Value::as_object) {
            return Some(call.get("name").and_then(Value::as_str).unwrap_or("unknown").to_string());
        }
    }
    None
}

fn qwen_result(message: Option<&Obj>) -> (String, Option<String>) {
    let Some(parts) = message.and_then(|row| row.get("parts").or_else(|| row.get("content"))).and_then(Value::as_array) else {
        return ("unknown".into(), None);
    };
    for part in parts.iter().filter_map(Value::as_object) {
        let Some(response) = part.get("functionResponse").and_then(Value::as_object) else {
            continue;
        };
        let name = response.get("name").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let output = response.get("response").and_then(Value::as_object).and_then(|row| row.get("output")).map(jsonish);
        return (name, output);
    }
    ("unknown".into(), None)
}

fn text_of(obj: &Obj) -> String {
    let content = obj.get("message").and_then(Value::as_object).and_then(|row| row.get("content")).or_else(|| obj.get("content"));
    match content {
        Some(Value::String(text)) => jtrim_used(text),
        Some(Value::Array(items)) => jtrim_used(
            &items
                .iter()
                .filter_map(Value::as_object)
                .filter(|row| row.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|row| row.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => String::new(),
    }
}

fn tool_uses(obj: &Obj) -> Vec<(String, Option<String>)> {
    let content = obj.get("message").and_then(Value::as_object).and_then(|row| row.get("content")).or_else(|| obj.get("content"));
    let Some(items) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_object)
        .filter(|row| row.get("type").and_then(Value::as_str) == Some("tool_use"))
        .map(|row| {
            (
                row.get("name").and_then(Value::as_str).unwrap_or("unknown").to_string(),
                row.get("id").and_then(Value::as_str).map(str::to_string),
            )
        })
        .collect()
}

fn tool_results(obj: &Obj) -> Vec<(String, String)> {
    let content = obj.get("message").and_then(Value::as_object).and_then(|row| row.get("content")).or_else(|| obj.get("content"));
    let Some(items) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_object)
        .filter(|row| row.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|row| {
            let id = row.get("tool_use_id").and_then(Value::as_str)?.to_string();
            Some((id, block_text(row.get("content"))))
        })
        .collect()
}

