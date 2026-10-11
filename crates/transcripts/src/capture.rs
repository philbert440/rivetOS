use std::collections::HashMap;

use serde_json::Value;

use crate::jsonl::{ParsedLine, lines_objects, parse_lines};
use crate::text::content_text;
use crate::turn::{CaptureMessage, Turn};
use crate::value::{Obj, js_norm, jtrim};

pub struct StoreView {
    pub turns: Vec<Turn>,
    pub messages: Vec<CaptureMessage>,
    pub truncated: bool,
}

pub fn project_claude(text: &str, source: Option<&str>, truncated: bool) -> StoreView {
    project_lines("claude", &parse_lines(text), source, truncated)
}

pub fn project_codex(text: &str) -> StoreView {
    project_lines("codex", &parse_lines(text), None, false)
}

pub fn project_kimi(text: &str) -> StoreView {
    project_lines("kimi", &parse_lines(text), None, false)
}

pub fn project_pi(text: &str) -> StoreView {
    project_lines("pi", &parse_lines(text), None, false)
}

pub fn project_qwen(text: &str) -> StoreView {
    project_lines("qwen", &parse_lines(text), None, false)
}

pub fn project_cursor(text: &str) -> StoreView {
    project_lines("cursor", &parse_lines(text), None, false)
}

pub fn project_cowork(text: &str) -> StoreView {
    project_lines("cowork", &parse_lines(text), None, false)
}

pub fn project_grok_chat(text: &str) -> StoreView {
    let lines = parse_lines(text);
    StoreView {
        turns: crate::grok::grok_turns_from_lines(&lines_objects(&lines)),
        messages: Vec::new(),
        truncated: false,
    }
}

pub fn project_grok_updates(text: &str) -> StoreView {
    let lines = parse_lines(text);
    StoreView {
        turns: Vec::new(),
        messages: grok_capture_lines(&lines),
        truncated: false,
    }
}

pub fn project_lines(
    command: &str,
    lines: &[ParsedLine],
    source: Option<&str>,
    truncated: bool,
) -> StoreView {
    let objects = lines_objects(lines);
    let turns = match command {
        "claude" => crate::claude::claude_turns_from_lines_sourced(&objects, source, truncated),
        "cowork" => crate::claude::cowork_turns_from_lines(&objects),
        "grok" => crate::grok::grok_turns_from_lines(&objects),
        "codex" => crate::codex::codex_turns_from_lines(&objects),
        "kimi" => crate::kimi::kimi_turns_from_lines(&objects),
        "pi" => crate::pi::pi_turns_from_lines(&objects),
        "qwen" => crate::qwen::qwen_turns_from_lines(&objects),
        "cursor" => crate::cursor::cursor_turns_from_objects(&objects),
        _ => Vec::new(),
    };
    let messages = match command {
        "claude" => claude_capture_lines(lines),
        "cowork" => cowork_capture_lines_parsed(lines),
        "grok" => Vec::new(),
        "codex" => codex_capture_lines(lines),
        "kimi" => kimi_capture_for(lines, None),
        "pi" => pi_capture_lines(lines),
        "qwen" => qwen_capture_lines(lines),
        "cursor" => cursor_capture_lines(lines),
        _ => Vec::new(),
    };
    StoreView {
        turns,
        messages,
        truncated,
    }
}

pub fn claude_capture_text(text: &str) -> Vec<CaptureMessage> {
    claude_capture_lines(&parse_lines(text))
}

fn claude_capture_lines(lines: &[ParsedLine]) -> Vec<CaptureMessage> {
    let mut results = HashMap::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
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
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if obj.get("isMeta").is_some_and(truthy) {
            continue;
        }
        let message = obj.get("message").and_then(Value::as_object);
        let role = message
            .and_then(|row| row.get("role"))
            .and_then(Value::as_str)
            .unwrap_or(kind);
        let content = message.and_then(|row| row.get("content"));
        let mut text_parts = Vec::new();
        let mut think_parts = Vec::new();
        let mut res_parts = Vec::new();
        let mut tools: Vec<(String, Option<Value>, Option<String>)> = Vec::new();
        if let Some(raw) = content.and_then(Value::as_str) {
            text_parts.push(raw.to_string());
        } else if let Some(blocks) = content.and_then(Value::as_array) {
            for block in blocks.iter().filter_map(Value::as_object) {
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => text_parts.push(
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    ),
                    "thinking" => think_parts.push(
                        block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .or_else(|| block.get("text").and_then(Value::as_str))
                            .unwrap_or("")
                            .to_string(),
                    ),
                    "tool_use" => {
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        let id = block.get("id").and_then(Value::as_str).map(str::to_string);
                        let result = id.as_ref().and_then(|id| results.get(id).cloned());
                        let input = block.get("input").cloned().map(|value| js_norm(&value));
                        tools.push((name, input, result));
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
        let tool_result = if res_parts.is_empty() {
            None
        } else {
            Some(res_parts.join("\n"))
        };
        if body.is_empty() && !tools.is_empty() {
            let names = tools
                .iter()
                .map(|(name, _, _)| name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            body = format!("[tool call] {names}");
        }
        if body.is_empty()
            && let Some(result) = &tool_result
        {
            body.clone_from(result);
        }
        if body.is_empty() && tool_result.is_none() {
            continue;
        }
        let mut message = CaptureMessage::new(role, body);
        if let Some((name, input, result)) = tools.first() {
            message.tool_name = Some(name.clone());
            message.tool_args = input.clone();
            if message.tool_result.is_none() {
                message.tool_result = result.clone();
            }
        }
        if message.tool_result.is_none() {
            message.tool_result = tool_result;
        }
        message.event_id = obj.get("uuid").and_then(Value::as_str).map(str::to_string);
        message.event_ts = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        message.session_id = obj
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        out.push(place(message, line));
    }
    out
}

pub fn codex_capture_text(text: &str) -> Vec<CaptureMessage> {
    codex_capture_lines(&parse_lines(text))
}

fn codex_capture_lines(lines: &[ParsedLine]) -> Vec<CaptureMessage> {
    let mut session_id = "unknown".to_string();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(payload) = obj.get("payload").and_then(Value::as_object) else {
            continue;
        };
        if let Some(id) = payload.get("id").and_then(Value::as_str)
            && native_session(id)
        {
            session_id = id.to_string();
        }
    }
    let mut names = HashMap::new();
    let mut out = Vec::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        let Some(payload) = obj
            .get("payload")
            .and_then(Value::as_object)
            .cloned()
            .or_else(|| {
                if kind == "response_item" {
                    obj.get("item").and_then(Value::as_object).cloned()
                } else {
                    None
                }
            })
        else {
            continue;
        };
        if kind != "response_item" {
            continue;
        }
        let event_ts =
            event_ts_of(obj.get("timestamp").or_else(|| obj.get("time")), true).or_else(|| {
                event_ts_of(
                    payload.get("timestamp").or_else(|| payload.get("time")),
                    true,
                )
            });
        let event_id = payload
            .get("id")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .or_else(|| {
                payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
            })
            .map(str::to_string)
            .unwrap_or_else(|| format!("codex:{session_id}:line:{}", line.index));
        let source_event = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        match source_event {
            "message" => {
                let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                if role == "developer" {
                    continue;
                }
                let want = if role == "user" {
                    "input_text"
                } else {
                    "output_text"
                };
                let Some(body) = content_text(payload.get("content").unwrap_or(&Value::Null), want)
                else {
                    continue;
                };
                if role != "user" && role != "assistant" {
                    continue;
                }
                let mut message = CaptureMessage::new(role, body);
                message.event_id = Some(event_id);
                message.event_ts = event_ts;
                message.session_id = Some(session_id.clone());
                message.extra = Some(extra_pairs(&[
                    ("sourceEvent", format!("response_item:{source_event}")),
                    ("source", "codex".into()),
                ]));
                out.push(place(message, line));
            }
            "reasoning" => {
                if let Some(chunk) = reasoning_text(&payload) {
                    let mut message =
                        CaptureMessage::new("assistant", format!("[thinking] {chunk}"));
                    message.event_id = Some(event_id);
                    message.event_ts = event_ts;
                    message.session_id = Some(session_id.clone());
                    message.extra = Some(extra_pairs(&[
                        ("sourceEvent", "response_item:reasoning".into()),
                        ("source", "codex".into()),
                        ("partType", "think".into()),
                    ]));
                    out.push(place(message, line));
                }
            }
            "function_call" | "custom_tool_call" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("tool").and_then(Value::as_str))
                    .unwrap_or("unknown");
                let call_id = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("id").and_then(Value::as_str));
                if let Some(id) = call_id {
                    names.insert(id.to_string(), name.to_string());
                }
                let args = payload
                    .get("input")
                    .or_else(|| payload.get("arguments"))
                    .map(parse_tool_input);
                let mut message = CaptureMessage::tool(format!("[tool] {name}"), name, None);
                message.tool_args = args;
                message.event_id = Some(event_id);
                message.event_ts = event_ts;
                message.session_id = Some(session_id.clone());
                message.extra = Some(extra_pairs(&[
                    ("sourceEvent", format!("response_item:{source_event}")),
                    ("source", "codex".into()),
                    ("callId", call_id.unwrap_or("").to_string()),
                ]));
                out.push(place(message, line));
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("id").and_then(Value::as_str));
                let name = call_id
                    .and_then(|id| names.get(id))
                    .map(String::as_str)
                    .unwrap_or("unknown");
                let failure = payload.get("error").is_some_and(truthy);
                let result = payload
                    .get("output")
                    .or_else(|| payload.get("content"))
                    .map(js_text);
                let label = if failure {
                    "tool-failure"
                } else {
                    "tool-result"
                };
                let mut message = CaptureMessage::tool(format!("[{label}] {name}"), name, result);
                message.event_id = Some(event_id);
                message.event_ts = event_ts;
                message.session_id = Some(session_id.clone());
                let mut extra = extra_map(&[
                    ("sourceEvent", format!("response_item:{source_event}")),
                    ("source", "codex".into()),
                ]);
                if let Some(id) = call_id {
                    extra.insert("callId".into(), Value::String(id.to_string()));
                }
                extra.insert("failure".into(), Value::Bool(failure));
                message.extra = Some(Value::Object(extra));
                out.push(place(message, line));
            }
            _ => {}
        }
    }
    out
}

pub fn kimi_capture_text(text: &str) -> Vec<CaptureMessage> {
    kimi_capture_for(&parse_lines(text), None)
}

pub(crate) fn kimi_capture_for(lines: &[ParsedLine], hint: Option<&str>) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    let mut last_ms = 0_i64;
    let mut occurrences: HashMap<String, u32> = HashMap::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
            continue;
        }
        let Some(wire_ms) = obj
            .get("time")
            .and_then(Value::as_f64)
            .filter(|ms| ms.is_finite())
        else {
            continue;
        };
        let Some(event) = obj.get("event").and_then(Value::as_object) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("content.part") {
            continue;
        }
        let Some(part) = event.get("part").and_then(Value::as_object) else {
            continue;
        };
        let Some(uuid) = event
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        else {
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
        let content = if part_type == "think" {
            format!("[thinking] {body}")
        } else {
            body.to_string()
        };
        let session_id = obj
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(hint.unwrap_or("unknown"));
        let tuple = protocol::js::stringify(&Value::Array(vec![
            Value::String("assistant".into()),
            Value::String(content.clone()),
            Value::Null,
        ]));
        let occurrence = occurrences.get(&tuple).copied().unwrap_or(0);
        occurrences.insert(tuple, occurrence + 1);
        let source_event = format!("wire:content.part:{uuid}");
        let mut material = format!("{session_id}\0assistant\0{content}\0\0\0{source_event}");
        if occurrence > 0 {
            material.push_str(&format!("\0occurrence:{occurrence}"));
        }
        let wire_i = wire_ms as i64;
        let created_ms = if wire_i > last_ms {
            wire_i
        } else {
            last_ms + 1
        };
        last_ms = created_ms;
        let event_ts = crate::timeutil::iso_from_ms(wire_i);
        let mut message = CaptureMessage::new("assistant", content);
        message.event_ts = Some(event_ts);
        message.created_at = Some(crate::timeutil::iso_from_ms(created_ms));
        message.session_id = Some(session_id.to_string());
        let mut extra = serde_json::Map::new();
        extra.insert(
            "sourceEvent".into(),
            Value::String("wire:content.part".into()),
        );
        extra.insert("hashSourceEvent".into(), Value::String(source_event));
        extra.insert("agentSlot".into(), Value::String("main".into()));
        extra.insert("partType".into(), Value::String(part_type.to_string()));
        extra.insert("uuid".into(), Value::String(uuid.to_string()));
        extra.insert("source".into(), Value::String("kimi-wire".into()));
        extra.insert("session_jsonl_line".into(), Value::from(line.index as u64));
        extra.insert("occurrence".into(), Value::from(occurrence));
        extra.insert("hashMaterial".into(), Value::String(material));
        extra.insert(
            "eventIdDeferred".into(),
            Value::String("protocol::digest".into()),
        );
        if let Some(turn) = event.get("turnId") {
            match turn {
                Value::String(text) => {
                    extra.insert("turnId".into(), Value::String(text.clone()));
                }
                Value::Number(number) => {
                    extra.insert("turnId".into(), Value::String(number.to_string()));
                }
                _ => {}
            }
        }
        if let Some(step) = event.get("step").filter(|value| value.is_number()) {
            extra.insert("step".into(), step.clone());
        }
        message.extra = Some(Value::Object(extra));
        out.push(place(message, line));
    }
    out
}

pub fn grok_capture_updates(text: &str) -> Vec<CaptureMessage> {
    grok_capture_lines(&parse_lines(text))
}

struct GrokPending {
    name: Option<String>,
    raw_input: Option<Value>,
    event_id: Option<String>,
}

pub(crate) fn grok_capture_lines(lines: &[ParsedLine]) -> Vec<CaptureMessage> {
    let mut prompt_turns: HashMap<String, i64> = HashMap::new();
    for line in lines {
        let Some(params) = line.value.get("params").and_then(Value::as_object) else {
            continue;
        };
        let Some(prompt_id) = params
            .get("_meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("promptId"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if !prompt_turns.contains_key(prompt_id) {
            prompt_turns.insert(prompt_id.to_string(), prompt_turns.len() as i64);
        }
    }
    let mut user_chunks: HashMap<i64, i64> = HashMap::new();
    let mut pending: HashMap<String, GrokPending> = HashMap::new();
    let mut current_turn = -1_i64;
    let mut out = Vec::new();
    for line in lines {
        let Some(params) = line.value.get("params").and_then(Value::as_object) else {
            continue;
        };
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            continue;
        };
        let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
            continue;
        };
        let meta = params.get("_meta").and_then(Value::as_object);
        let update_meta = update.get("_meta").and_then(Value::as_object);
        let event_id = meta
            .and_then(|row| row.get("eventId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let event_ts = meta
            .and_then(|row| row.get("agentTimestampMs"))
            .and_then(truthy_ms)
            .map(crate::timeutil::iso_from_ms);
        let (turn, sub_order) = if kind == "user_message_chunk" {
            let indexed = update_meta
                .and_then(|row| row.get("promptIndex"))
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|value| value as i64);
            let turn = indexed.unwrap_or(if current_turn < 0 { 0 } else { current_turn });
            let sub_order = user_chunks.get(&turn).copied().unwrap_or(0);
            user_chunks.insert(turn, sub_order + 1);
            current_turn = turn;
            (turn, sub_order)
        } else if let Some(prompt_id) = meta
            .and_then(|row| row.get("promptId"))
            .and_then(Value::as_str)
            && let Some(turn) = prompt_turns.get(prompt_id).copied()
        {
            current_turn = turn;
            (turn, 10_000 + line.index as i64)
        } else {
            (current_turn, 10_000 + line.index as i64)
        };
        let ordinal = turn.saturating_mul(1_000_000).saturating_add(sub_order);
        let stamp = |message: &mut CaptureMessage| {
            message.event_id = event_id.clone();
            message.event_ts = event_ts.clone();
            message.ordinal = Some(ordinal);
            message.line_index = Some(line.index as u64);
            message.source_offset = Some(line.offset);
        };
        match kind {
            "user_message_chunk" => {
                if let Some(body) = extract_text(update.get("content")) {
                    let mut message = CaptureMessage::new("user", body);
                    stamp(&mut message);
                    let mut extra = serde_json::Map::new();
                    extra.insert("sessionUpdate".into(), Value::String(kind.into()));
                    if let Some(model) = update_meta.and_then(|row| row.get("modelId")) {
                        extra.insert("modelId".into(), model.clone());
                    }
                    if let Some(index) = update_meta.and_then(|row| row.get("promptIndex")) {
                        extra.insert("promptIndex".into(), index.clone());
                    }
                    message.extra = Some(Value::Object(extra));
                    out.push(message);
                }
            }
            "agent_message_chunk" | "agent_thought_chunk" => {
                if let Some(body) = extract_text(update.get("content")) {
                    let content = if kind == "agent_thought_chunk" {
                        format!("[thinking] {body}")
                    } else {
                        body
                    };
                    let mut message = CaptureMessage::new("assistant", content);
                    stamp(&mut message);
                    message.extra = Some(extra_pairs(&[("sessionUpdate", kind.to_string())]));
                    out.push(message);
                }
            }
            "tool_call" => {
                if let Some(id) = update.get("toolCallId").and_then(Value::as_str) {
                    pending.insert(
                        id.to_string(),
                        GrokPending {
                            name: update
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            raw_input: update.get("rawInput").cloned(),
                            event_id: event_id.clone(),
                        },
                    );
                }
            }
            "tool_call_update"
                if update.get("status").and_then(Value::as_str) == Some("completed") =>
            {
                let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                    continue;
                };
                let initial = pending.remove(id);
                let name = initial
                    .as_ref()
                    .and_then(|row| row.name.clone())
                    .or_else(|| {
                        update
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "?".into());
                let raw_input = initial
                    .as_ref()
                    .and_then(|row| row.raw_input.clone())
                    .or_else(|| update.get("rawInput").cloned());
                let mut message = CaptureMessage::tool(
                    format!("[tool] {name}"),
                    name,
                    format_tool_result(update),
                );
                message.tool_args = raw_input.map(|value| js_norm(&value));
                stamp(&mut message);
                let mut extra = extra_map(&[
                    ("sessionUpdate", kind.to_string()),
                    ("toolCallId", id.to_string()),
                ]);
                if let Some(row) = initial.as_ref()
                    && let Some(id) = &row.event_id
                {
                    extra.insert("toolCallEventId".into(), Value::String(id.clone()));
                }
                if let Some(kind_value) = update.get("kind") {
                    extra.insert("kind".into(), kind_value.clone());
                }
                message.extra = Some(Value::Object(extra));
                out.push(message);
            }
            "memory_flush_started" | "memory_flush_completed" => {
                let mut message = CaptureMessage::new("system", format!("[grok.{kind}]"));
                stamp(&mut message);
                message.extra = Some(extra_pairs(&[("sessionUpdate", kind.to_string())]));
                out.push(message);
            }
            _ => {}
        }
    }
    out
}

pub fn pi_capture_text(text: &str) -> Vec<CaptureMessage> {
    pi_capture_lines(&parse_lines(text))
}

fn pi_capture_lines(lines: &[ParsedLine]) -> Vec<CaptureMessage> {
    let mut session_id = "unknown".to_string();
    let mut names = HashMap::new();
    let mut out = Vec::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) == Some("session") {
            if let Some(id) = obj.get("id").and_then(Value::as_str)
                && native_session(id)
            {
                session_id = id.to_string();
            }
            continue;
        }
        if obj.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let line_id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        let event_id = match line_id {
            Some(id) => format!("pi:{session_id}:{id}"),
            None => format!("pi:{session_id}:line:{}", line.index),
        };
        let message = obj.get("message").and_then(Value::as_object).unwrap_or(obj);
        let event_ts = event_ts_of(
            message.get("timestamp").or_else(|| message.get("time")),
            true,
        )
        .or_else(|| event_ts_of(obj.get("timestamp").or_else(|| obj.get("time")), true));
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "toolResult" || role == "tool_result" {
            let call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .or_else(|| message.get("id").and_then(Value::as_str));
            let name = message
                .get("toolName")
                .and_then(Value::as_str)
                .or_else(|| call_id.and_then(|id| names.get(id)).map(String::as_str))
                .unwrap_or("unknown");
            let result = message
                .get("result")
                .or_else(|| message.get("content"))
                .map(js_text);
            let mut row = CaptureMessage::tool(format!("[tool-result] {name}"), name, result);
            row.event_id = Some(event_id);
            row.event_ts = event_ts;
            row.session_id = Some(session_id.clone());
            out.push(place(row, line));
            continue;
        }
        if role == "user" {
            if let Some(body) = text_items(message) {
                let mut row = CaptureMessage::new("user", body);
                row.event_id = Some(event_id);
                row.event_ts = event_ts;
                row.session_id = Some(session_id.clone());
                out.push(place(row, line));
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
            let mut row = CaptureMessage::new("assistant", body.unwrap_or_default());
            if row.content.is_empty()
                && let Some(think) = thinking.clone()
            {
                row.content = format!("[thinking] {think}");
            }
            row.event_id = Some(event_id.clone());
            row.event_ts = event_ts.clone();
            row.session_id = Some(session_id.clone());
            out.push(place(row, line));
        }
        for item in tool_items(message) {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| item.get("toolName").and_then(Value::as_str))
                .unwrap_or("unknown");
            if let Some(id) = item
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| item.get("toolCallId").and_then(Value::as_str))
            {
                names.insert(id.to_string(), name.to_string());
            }
            let mut row = CaptureMessage::tool(format!("[tool] {name}"), name, None);
            row.tool_args = item
                .get("arguments")
                .or_else(|| item.get("input"))
                .map(parse_tool_input);
            row.event_id = Some(event_id.clone());
            row.event_ts = event_ts.clone();
            row.session_id = Some(session_id.clone());
            out.push(place(row, line));
        }
    }
    out
}

pub fn qwen_capture_text(text: &str) -> Vec<CaptureMessage> {
    qwen_capture_lines(&parse_lines(text))
}

fn qwen_capture_lines(lines: &[ParsedLine]) -> Vec<CaptureMessage> {
    let mut session_id = "unknown".to_string();
    let mut out = Vec::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        if let Some(id) = obj.get("sessionId").and_then(Value::as_str)
            && native_session(id)
        {
            session_id = id.to_string();
        }
        let uuid = obj
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        let event_id = match uuid {
            Some(id) => format!("qwen-code:{session_id}:{id}"),
            None => format!("qwen-code:{session_id}:line:{}", line.index),
        };
        let event_ts = event_ts_of(obj.get("timestamp").or_else(|| obj.get("time")), false);
        let stamp = |row: &mut CaptureMessage| {
            row.event_id = Some(event_id.clone());
            row.event_ts = event_ts.clone();
            row.session_id = Some(session_id.clone());
        };
        match obj.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                if obj.get("provenance").and_then(Value::as_str) != Some("real_user") {
                    continue;
                }
                let message = obj.get("message").and_then(Value::as_object);
                let owned = join_parts(message, false);
                let body = jtrim(&owned);
                if !body.is_empty() {
                    let mut row = CaptureMessage::new("user", body);
                    stamp(&mut row);
                    out.push(place(row, line));
                }
            }
            "assistant" => {
                let message = obj.get("message").and_then(Value::as_object);
                let thinking = join_parts(message, true);
                let content = jtrim(&join_parts(message, false)).to_string();
                let call = qwen_call(message);
                if content.is_empty() && !thinking.is_empty() && call.is_none() {
                    let mut row =
                        CaptureMessage::new("assistant", format!("[thinking] {thinking}"));
                    stamp(&mut row);
                    out.push(place(row, line));
                    continue;
                }
                if content.is_empty()
                    && let Some((name, args)) = call
                {
                    let mut row = CaptureMessage::tool(format!("[tool] {name}"), name, None);
                    row.tool_args = args;
                    stamp(&mut row);
                    out.push(place(row, line));
                    continue;
                }
                if content.is_empty() && thinking.is_empty() {
                    continue;
                }
                let body = if content.is_empty() {
                    format!("[thinking] {thinking}")
                } else {
                    content
                };
                let mut row = CaptureMessage::new("assistant", body);
                if let Some((name, args)) = qwen_call(message) {
                    row.tool_name = Some(name);
                    row.tool_args = args;
                }
                stamp(&mut row);
                out.push(place(row, line));
            }
            "tool_result" => {
                let message = obj.get("message").and_then(Value::as_object);
                let (name, output) = qwen_result(message);
                let mut row = CaptureMessage::tool(format!("[tool-result] {name}"), name, output);
                stamp(&mut row);
                out.push(place(row, line));
            }
            _ => {}
        }
    }
    out
}

pub fn cursor_capture_objects(objects: &[Obj]) -> Vec<CaptureMessage> {
    let lines = objects
        .iter()
        .enumerate()
        .map(|(index, obj)| ParsedLine {
            index,
            offset: 0,
            value: Value::Object(obj.clone()),
        })
        .collect::<Vec<_>>();
    cursor_capture_lines(&lines)
}

fn cursor_capture_lines(lines: &[ParsedLine]) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        let role = obj.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let conversation = obj
            .get("conversationId")
            .or_else(|| obj.get("sessionId"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or("unknown");
        let message = obj.get("message").and_then(Value::as_object).unwrap_or(obj);
        let Some(content) = message.get("content") else {
            continue;
        };
        let mut push = |part: usize, mut row: CaptureMessage| {
            row.event_id = Some(format!(
                "cursor:{conversation}:line:{}:part:{part}",
                line.index
            ));
            row.session_id = Some(conversation.to_string());
            out.push(place(row, line));
        };
        if let Some(text) = content.as_str() {
            let trimmed = jtrim(text);
            if !trimmed.is_empty() {
                push(0, CaptureMessage::new(role, trimmed));
            }
            continue;
        }
        let Some(parts) = content.as_array() else {
            continue;
        };
        for (part_index, part) in parts.iter().filter_map(Value::as_object).enumerate() {
            match part.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    if let Some(text) = part.get("text").and_then(Value::as_str)
                        && !jtrim(text).is_empty()
                    {
                        push(part_index, CaptureMessage::new(role, text));
                    }
                }
                "tool_use" => {
                    let name = part
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let mut row = CaptureMessage::tool(format!("[tool] {name}"), name, None);
                    row.tool_args = part.get("input").map(js_norm);
                    push(part_index, row);
                }
                _ => {}
            }
        }
    }
    out
}

pub fn cowork_capture_lines(lines: &[String]) -> Vec<CaptureMessage> {
    let parsed = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let value = protocol::js::parse(line).ok()?;
            value.is_object().then_some(ParsedLine {
                index,
                offset: 0,
                value,
            })
        })
        .collect::<Vec<_>>();
    cowork_capture_lines_parsed(&parsed)
}

fn cowork_capture_lines_parsed(lines: &[ParsedLine]) -> Vec<CaptureMessage> {
    let mut results = HashMap::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        for (id, text) in tool_results(obj) {
            results.insert(id, text);
        }
    }
    let mut out = Vec::new();
    for line in lines {
        let Some(obj) = line.value.as_object() else {
            continue;
        };
        let part = obj
            .get("cliSessionId")
            .or_else(|| obj.get("sessionId"))
            .or_else(|| obj.get("session_id"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or("unknown");
        let uuid = obj
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        let created = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        let prompt = text_of(obj);
        let uses = tool_uses(obj);
        let here = tool_results(obj);
        let assistant = obj.get("type").and_then(Value::as_str) == Some("assistant")
            || obj
                .get("message")
                .and_then(Value::as_object)
                .and_then(|row| row.get("role"))
                .and_then(Value::as_str)
                == Some("assistant");
        let mut push_text = |role: &str, content: String| {
            let mut row = CaptureMessage::new(role, content);
            row.event_id = uuid.map(|id| format!("cowork:{part}:{id}"));
            row.event_ts = created.clone();
            row.created_at = created.clone();
            row.session_id = Some(part.to_string());
            row.extra = Some(extra_pairs(&[("source", "cowork-transcript".into())]));
            out.push(place(row, line));
        };
        if !prompt.is_empty()
            && uses.is_empty()
            && here.is_empty()
            && obj.get("type").and_then(Value::as_str) != Some("ai-title")
        {
            push_text(if assistant { "assistant" } else { "user" }, prompt.clone());
        } else if !prompt.is_empty() && !uses.is_empty() {
            push_text("assistant", prompt);
        }
        for (name, id, input) in &uses {
            let result = id.as_ref().and_then(|id| results.get(id).cloned());
            let mut row = CaptureMessage::tool(format!("[tool call] {name}"), name, result);
            row.tool_args = input.clone().map(|value| js_norm(&value));
            row.event_id = id
                .as_ref()
                .map(|id| format!("cowork:{part}:tool:{id}"))
                .or_else(|| uuid.map(|id| format!("cowork:{part}:{id}")));
            row.event_ts = created.clone();
            row.created_at = created.clone();
            row.session_id = Some(part.to_string());
            row.extra = Some(extra_pairs(&[("source", "cowork-transcript".into())]));
            out.push(place(row, line));
        }
    }
    out
}

pub fn hermes_capture_rows(rows: &[Obj]) -> Vec<CaptureMessage> {
    rows.iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let role = row.get("role").and_then(Value::as_str).unwrap_or("");
            let content = row.get("content").and_then(Value::as_str).unwrap_or("");
            let mut message = if role == "tool"
                || row.get("tool_call_id").and_then(Value::as_str).is_some()
            {
                let name = row
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let mut message =
                    CaptureMessage::tool(format!("[tool] {name}"), name, Some(content.to_string()));
                message.tool_args = row
                    .get("tool_args")
                    .or_else(|| row.get("arguments"))
                    .map(js_norm);
                message
            } else if content.is_empty() {
                return None;
            } else {
                CaptureMessage::new(role, content)
            };
            message.line_index = Some(index as u64);
            message.event_id = row.get("id").map(js_text).filter(|text| !text.is_empty());
            message.event_ts =
                event_ts_of(row.get("timestamp").or_else(|| row.get("created_at")), true);
            message.created_at = message.event_ts.clone();
            Some(message)
        })
        .collect()
}

pub fn opencode_capture_parts(parts: &[Obj]) -> Vec<CaptureMessage> {
    let mut out = Vec::new();
    for part in parts {
        let role_raw = part.get("role").and_then(Value::as_str).unwrap_or("");
        if role_raw == "system" {
            continue;
        }
        let data_value = part
            .get("data")
            .cloned()
            .unwrap_or_else(|| Value::Object(part.clone()));
        let Some(data) = data_value.as_object() else {
            continue;
        };
        let kind = data.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(
            kind,
            "step-start" | "step_start" | "step-finish" | "step_finish"
        ) {
            continue;
        }
        let event_id = part.get("id").and_then(Value::as_str).map(str::to_string);
        let session_id = part
            .get("session_id")
            .or_else(|| part.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let event_ts = part
            .get("time_created")
            .and_then(Value::as_f64)
            .and_then(iso_positive);
        let mut base = CaptureMessage::new("", "");
        base.event_id = event_id;
        base.session_id = session_id;
        base.event_ts = event_ts.clone();
        base.created_at = event_ts;
        if matches!(kind, "reasoning" | "thinking" | "think") {
            if !part_has_time_end(data) {
                continue;
            }
            let owned = part_body(data);
            let chunk = jtrim(&owned);
            if chunk.is_empty() {
                continue;
            }
            base.role = "assistant".into();
            base.content = format!("[thinking] {chunk}");
            base.extra = Some(extra_pairs(&[
                ("source", "opencode".into()),
                ("sourceEvent", format!("part:{kind}")),
                ("partType", "think".into()),
            ]));
            out.push(base);
            continue;
        }
        if matches!(kind, "tool" | "tool_use" | "tool-call") {
            let name = data
                .get("tool")
                .and_then(Value::as_str)
                .or_else(|| data.get("name").and_then(Value::as_str))
                .or_else(|| {
                    data.get("tool")
                        .and_then(Value::as_object)
                        .and_then(|tool| tool.get("name"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("tool");
            let state = data.get("state").and_then(Value::as_object);
            let status = state
                .and_then(|row| row.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let failure = data.get("isError") == Some(&Value::Bool(true)) || status == "error";
            let args = state
                .and_then(|row| row.get("input"))
                .or_else(|| {
                    data.get("tool")
                        .and_then(Value::as_object)
                        .and_then(|tool| tool.get("input").or_else(|| tool.get("args")))
                })
                .or_else(|| data.get("input"))
                .or_else(|| data.get("args"))
                .map(js_norm);
            let raw_out = if failure {
                state
                    .and_then(|row| {
                        row.get("error")
                            .or_else(|| row.get("output"))
                            .or_else(|| row.get("title"))
                    })
                    .or_else(|| data.get("output"))
                    .or_else(|| data.get("result"))
            } else if state.is_some_and(|row| row.contains_key("output")) {
                state.and_then(|row| row.get("output"))
            } else {
                data.get("output").or_else(|| data.get("result"))
            };
            let result = raw_out.map(js_text);
            if (status == "running" || status == "pending") && result.is_none() {
                continue;
            }
            let label = if failure {
                "tool-failure"
            } else {
                "tool-result"
            };
            base.role = "tool".into();
            base.content = format!("[{label}] {name}");
            base.tool_name = Some(name.to_string());
            base.tool_args = args;
            base.tool_result = result;
            base.extra = Some(extra_pairs(&[
                ("source", "opencode".into()),
                ("sourceEvent", format!("part:{kind}")),
                ("toolStatus", if failure { "error" } else { "done" }.into()),
            ]));
            out.push(base);
            continue;
        }
        if kind == "text" || kind.is_empty() || kind == "content" {
            let role = if role_raw == "assistant" {
                "assistant"
            } else {
                "user"
            };
            if role == "assistant" && !part_has_time_end(data) {
                continue;
            }
            let owned = part_body(data);
            let text = jtrim(&owned);
            if text.is_empty() {
                continue;
            }
            base.role = role.into();
            base.content = text.to_string();
            base.extra = Some(extra_pairs(&[
                ("source", "opencode".into()),
                ("sourceEvent", format!("part:{kind}")),
            ]));
            out.push(base);
        }
    }
    out
}

fn place(mut message: CaptureMessage, line: &ParsedLine) -> CaptureMessage {
    message.line_index = Some(line.index as u64);
    message.source_offset = Some(line.offset);
    message
}

fn native_session(id: &str) -> bool {
    crate::identity::is_bare_native_uuid(id) && !id.contains('/') && !id.contains("..")
}

fn event_ts_of(value: Option<&Value>, numbers: bool) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) if numbers => {
            let raw = number.as_f64()?;
            if !raw.is_finite() {
                return None;
            }
            let ms = if raw > 1e12 { raw } else { raw * 1000.0 };
            ms.is_finite()
                .then(|| crate::timeutil::iso_from_ms(ms as i64))
        }
        _ => None,
    }
}

fn iso_positive(ms: f64) -> Option<String> {
    (ms.is_finite() && ms > 0.0).then(|| crate::timeutil::iso_from_ms(ms as i64))
}

fn truthy_ms(value: &Value) -> Option<i64> {
    let ms = value.as_f64()?;
    (ms.is_finite() && ms != 0.0).then_some(ms as i64)
}

fn extra_pairs(pairs: &[(&str, String)]) -> Value {
    Value::Object(extra_map(pairs))
}

fn extra_map(pairs: &[(&str, String)]) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    for (key, value) in pairs {
        if !value.is_empty() {
            map.insert((*key).to_string(), Value::String(value.clone()));
        }
    }
    map
}

fn js_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        text.to_string()
    } else {
        protocol::js::stringify(value)
    }
}

fn parse_tool_input(value: &Value) -> Value {
    if let Some(text) = value.as_str() {
        return protocol::js::parse(text).unwrap_or_else(|_| Value::String(text.to_string()));
    }
    js_norm(value)
}

fn part_has_time_end(data: &Obj) -> bool {
    let Some(time) = data.get("time").and_then(Value::as_object) else {
        return false;
    };
    match time.get("end") {
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|end| end.is_finite() && end > 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        _ => false,
    }
}

fn part_body(data: &Obj) -> String {
    if let Some(text) = data.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = data
        .get("text")
        .and_then(Value::as_object)
        .and_then(|row| row.get("value"))
        .and_then(Value::as_str)
    {
        return text.to_string();
    }
    data.get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn format_tool_result(update: &Obj) -> Option<String> {
    if let Some(out) = update.get("rawOutput").and_then(Value::as_object) {
        let kind = out.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "Bash" {
            if let Some(text) = out.get("output_for_prompt").and_then(Value::as_str) {
                let code = out
                    .get("exit_code")
                    .and_then(Value::as_f64)
                    .filter(|number| number.is_finite())
                    .map(|number| {
                        if number.fract() == 0.0 {
                            format!("{}", number as i64)
                        } else {
                            protocol::js::stringify(&Value::from(number))
                        }
                    })
                    .unwrap_or_else(|| "?".into());
                let mut tail = format!("exit_code={code}");
                if out.get("timed_out").is_some_and(truthy) {
                    tail.push_str(" timed_out=true");
                }
                if out.get("truncated").is_some_and(truthy) {
                    tail.push_str(" truncated=true");
                }
                return Some(format!("{text}\n[{tail}]"));
            }
        } else if kind == "GrepSearch" {
            if let Some(text) = out.get("output_for_prompt").and_then(Value::as_str) {
                return Some(text.to_string());
            }
            if let Some(stdout) = out.get("stdout").and_then(Value::as_array) {
                let bytes = stdout
                    .iter()
                    .filter(|value| value.is_number())
                    .cloned()
                    .collect::<Vec<_>>();
                return Some(bytes_to_string(&bytes));
            }
        } else if kind == "ReadFile" {
            if let Some(text) = out
                .get("FileContent")
                .and_then(Value::as_object)
                .and_then(|row| row.get("content"))
                .and_then(Value::as_str)
            {
                return Some(text.to_string());
            }
        } else if kind == "SearchTool" {
            if let Some(text) = out.get("content").and_then(Value::as_str) {
                let prefix = out
                    .get("result_count")
                    .and_then(Value::as_f64)
                    .filter(|number| number.is_finite())
                    .map(|number| format!("[result_count={number}]\n"))
                    .unwrap_or_default();
                return Some(format!("{prefix}{text}"));
            }
        } else if kind == "MCP" {
            let server = out
                .get("server_name")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let tool = out.get("tool_name").and_then(Value::as_str).unwrap_or("?");
            let header = format!("[mcp {server}/{tool}]");
            let output = out.get("output");
            if let Some(text) = output.and_then(Value::as_str) {
                return Some(format!("{header}\n{text}"));
            }
            if let Some(text) = output
                .and_then(Value::as_object)
                .and_then(|row| row.get("OkayOutput"))
                .and_then(Value::as_str)
            {
                return Some(format!("{header}\n{text}"));
            }
            if let Some(text) = output
                .and_then(Value::as_object)
                .and_then(|row| row.get("ErrorOutput"))
                .and_then(Value::as_str)
            {
                return Some(format!("{header} ERROR\n{text}"));
            }
            return Some(format!(
                "{header}\n{}",
                protocol::js::stringify(&strip_byte_arrays(
                    output.cloned().unwrap_or(Value::Null),
                    0
                ))
            ));
        } else if kind == "ListDir"
            && let Some(text) = out
                .get("Content")
                .and_then(Value::as_object)
                .and_then(|row| row.get("content"))
                .and_then(Value::as_str)
        {
            return Some(text.to_string());
        } else if kind == "Todo"
            && let Some(text) = out
                .get("TodosUpdated")
                .and_then(Value::as_object)
                .and_then(|row| row.get("summary_for_prompt"))
                .and_then(Value::as_str)
        {
            return Some(text.to_string());
        }
        return Some(protocol::js::stringify(&strip_byte_arrays(
            Value::Object(out.clone()),
            0,
        )));
    }
    let items = update.get("content").and_then(Value::as_array)?;
    let parts = items
        .iter()
        .filter_map(|item| item.as_object())
        .filter_map(|item| extract_text(item.get("content")))
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn bytes_to_string(values: &[Value]) -> String {
    let bytes = values
        .iter()
        .filter_map(|value| value.as_u64().and_then(|number| u8::try_from(number).ok()))
        .collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn strip_byte_arrays(value: Value, depth: usize) -> Value {
    if depth > 6 || value.is_null() {
        return value;
    }
    match value {
        Value::Array(items) => {
            let bytes = items.len() >= 16
                && items.iter().all(|item| {
                    item.as_u64().is_some_and(|number| number <= 255)
                        && item.as_f64().is_some_and(|number| number.fract() == 0.0)
                });
            if bytes {
                Value::String(bytes_to_string(&items))
            } else {
                Value::Array(
                    items
                        .into_iter()
                        .map(|item| strip_byte_arrays(item, depth + 1))
                        .collect(),
                )
            }
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, strip_byte_arrays(item, depth + 1)))
                .collect(),
        ),
        other => other,
    }
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
            .map(|item| {
                item.as_str()
                    .or_else(|| {
                        item.as_object()
                            .and_then(|row| row.get("text"))
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn jsonish(value: &Value) -> String {
    js_text(value)
}

fn reasoning_text(payload: &Obj) -> Option<String> {
    if let Some(text) = payload.get("text").and_then(Value::as_str)
        && !text.is_empty()
    {
        return Some(text.to_string());
    }
    payload
        .get("summary")
        .and_then(Value::as_array)
        .and_then(|items| {
            let text = items
                .iter()
                .filter_map(|item| item.as_object())
                .filter_map(|row| row.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            (!text.is_empty()).then_some(text)
        })
}

fn extract_text(content: Option<&Value>) -> Option<String> {
    let row = content?.as_object()?;
    if row.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    let text = row.get("text").and_then(Value::as_str)?;
    (!text.is_empty()).then(|| text.to_string())
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
                        (kind == "thinking" || kind == "reasoning").then(|| {
                            row.get("thinking")
                                .or_else(|| row.get("text"))
                                .and_then(Value::as_str)
                                .unwrap_or("")
                        })
                    } else {
                        (kind == "text" || kind == "input_text" || kind == "output_text")
                            .then(|| row.get("text").and_then(Value::as_str).unwrap_or(""))
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
    let Some(parts) = message
        .and_then(|row| row.get("parts").or_else(|| row.get("content")))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(Value::as_object)
        .filter(|part| {
            part.get("thought") == Some(&Value::Bool(true))
                || part.get("thought") == Some(&Value::Bool(false))
                || true
        })
        .filter(|part| (part.get("thought") == Some(&Value::Bool(true))) == thought)
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn qwen_call(message: Option<&Obj>) -> Option<(String, Option<Value>)> {
    let parts = message?
        .get("parts")
        .or_else(|| message?.get("content"))?
        .as_array()?;
    for part in parts.iter().filter_map(Value::as_object) {
        if let Some(call) = part.get("functionCall").and_then(Value::as_object) {
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let args = call
                .get("args")
                .or_else(|| call.get("arguments"))
                .map(js_norm);
            return Some((name, args));
        }
    }
    None
}

fn qwen_result(message: Option<&Obj>) -> (String, Option<String>) {
    let Some(parts) = message
        .and_then(|row| row.get("parts").or_else(|| row.get("content")))
        .and_then(Value::as_array)
    else {
        return ("unknown".into(), None);
    };
    for part in parts.iter().filter_map(Value::as_object) {
        let Some(response) = part.get("functionResponse").and_then(Value::as_object) else {
            continue;
        };
        let name = response
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let output = response
            .get("response")
            .and_then(Value::as_object)
            .and_then(|row| row.get("output"))
            .map(jsonish);
        return (name, output);
    }
    ("unknown".into(), None)
}

fn text_of(obj: &Obj) -> String {
    let content = obj
        .get("message")
        .and_then(Value::as_object)
        .and_then(|row| row.get("content"))
        .or_else(|| obj.get("content"));
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

fn tool_uses(obj: &Obj) -> Vec<(String, Option<String>, Option<Value>)> {
    let content = obj
        .get("message")
        .and_then(Value::as_object)
        .and_then(|row| row.get("content"))
        .or_else(|| obj.get("content"));
    let Some(items) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_object)
        .filter(|row| row.get("type").and_then(Value::as_str) == Some("tool_use"))
        .map(|row| {
            (
                row.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                row.get("id").and_then(Value::as_str).map(str::to_string),
                row.get("input").cloned(),
            )
        })
        .collect()
}

fn tool_results(obj: &Obj) -> Vec<(String, String)> {
    let content = obj
        .get("message")
        .and_then(Value::as_object)
        .and_then(|row| row.get("content"))
        .or_else(|| obj.get("content"));
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
