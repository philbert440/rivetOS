use serde_json::Value;

use crate::text::{
    as_i64, blocks_of, extract_turn_text, finite_num, objects_from_lines, pick_nonempty, summarize_turn_args,
};
use crate::turn::{Tool, ToolStatus, Turn, Usage, cap_thinking};
use crate::value::{Obj, jtrim};

pub fn pi_turns_from_lines(lines: &[Obj]) -> Vec<Turn> {
    let mut turns = Vec::new();
    for obj in lines {
        if obj.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = obj.get("message").and_then(Value::as_object) else {
            continue;
        };
        let raw_role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if raw_role == "toolResult" || raw_role == "tool_result" {
            complete_running(
                &mut turns,
                pick_nonempty(message, &["toolCallId", "id"]),
                pick_nonempty(message, &["toolName", "name"]),
            );
            continue;
        }
        let role = if raw_role == "assistant" {
            "assistant"
        } else if raw_role == "user" {
            "user"
        } else {
            ""
        };
        if role.is_empty() {
            continue;
        }
        absorb_message(&mut turns, message, role);
    }
    turns
}

pub fn pi_turns_from_text(lines: &[String]) -> Vec<Turn> {
    pi_turns_from_lines(&objects_from_lines(lines))
}

fn absorb_message(turns: &mut Vec<Turn>, message: &Obj, role: &str) {
    let mut tools = Vec::new();
    let mut thinking = String::new();
    let mut text_parts = Vec::new();
    for item in content_items(message) {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "text" {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                let trimmed = jtrim(text);
                if !trimmed.is_empty() {
                    text_parts.push(trimmed.to_string());
                }
            }
        } else if kind == "thinking" {
            if let Some(text) = item.get("thinking").and_then(Value::as_str)
                && !text.is_empty() {
                    thinking.push_str(text);
                }
        } else if matches!(kind, "toolCall" | "tool_call" | "toolUse" | "tool_use") {
            let Some(name) = pick_nonempty(&item, &["name", "toolName"]) else {
                continue;
            };
            let mut entry = Tool {
                name,
                status: ToolStatus::Running,
                args: None,
                id: pick_nonempty(&item, &["id", "toolCallId"]),
                input: None,
                result_text: None,
            };
            let raw_args = item.get("arguments").or_else(|| item.get("input")).unwrap_or(&Value::Null);
            entry.args = summarize_turn_args(raw_args);
            tools.push(entry);
        } else if matches!(kind, "toolResult" | "tool_result") {
            let id = pick_nonempty(&item, &["id", "toolCallId"]);
            if let Some(entry) = find_running(&mut tools, id.as_deref(), None) {
                entry.status = ToolStatus::Done;
            }
        }
    }
    let joined = text_parts.join("\n");
    let extracted = extract_turn_text(&Value::String(joined.clone()), role);
    let text = extracted.unwrap_or_else(|| jtrim(&joined).to_string());
    if text.is_empty() && thinking.is_empty() && tools.is_empty() {
        return;
    }
    let mut turn = if role == "assistant" {
        let mut turn = Turn::assistant();
        turn.tools = None;
        turn
    } else {
        Turn::user(String::new())
    };
    turn.text = text;
    if !thinking.is_empty() {
        turn.raw_thinking = Some(thinking.clone());
        turn.thinking = Some(cap_thinking(&thinking));
    }
    if !tools.is_empty() {
        turn.tools = Some(tools);
    }
    if role == "assistant" {
        if let Some(usage) = usage_from_message(message) {
            turn.usage = Some(usage);
        }
        if let Some(reason) = message.get("stopReason").and_then(Value::as_str)
            && !reason.is_empty() {
                turn.stop_reason = Some(reason.to_string());
            }
    }
    turns.push(turn);
}

fn content_items(message: &Obj) -> Vec<Obj> {
    match message.get("content") {
        Some(Value::String(text)) if !text.is_empty() => blocks_of(&Value::String(text.clone())),
        Some(value) if value.is_array() => blocks_of(value),
        _ => Vec::new(),
    }
}

fn usage_from_message(message: &Obj) -> Option<Usage> {
    let usage = message.get("usage").and_then(Value::as_object)?;
    let input = first_num(usage, &["input", "input_tokens", "inputTokens", "promptTokens"]);
    let output = first_num(usage, &["output", "output_tokens", "outputTokens", "completionTokens"]);
    let cached = first_num(usage, &["cacheRead", "cache_read_tokens"]);
    let cache_write = first_num(usage, &["cacheWrite", "cache_write_tokens"]);
    let cached_tokens = cached + cache_write;
    if input <= 0.0 && output <= 0.0 && cached_tokens <= 0.0 {
        return None;
    }
    Some(Usage {
        prompt_tokens: as_i64(input + cached_tokens),
        completion_tokens: as_i64(output),
        cached_tokens: as_i64(cached_tokens),
    })
}

fn first_num(obj: &Obj, keys: &[&str]) -> f64 {
    for key in keys {
        let number = finite_num(obj.get(*key));
        if number != 0.0 {
            return number;
        }
    }
    0.0
}

fn complete_running(turns: &mut [Turn], id: Option<String>, name: Option<String>) {
    for turn in turns.iter_mut().rev() {
        let Some(tools) = turn.tools.as_mut() else {
            continue;
        };
        if find_running(tools, id.as_deref(), name.as_deref()).is_some() {
            if let Some(entry) = find_running(tools, id.as_deref(), name.as_deref()) {
                entry.status = ToolStatus::Done;
            }
            return;
        }
    }
}

fn find_running<'a>(tools: &'a mut [Tool], id: Option<&str>, name: Option<&str>) -> Option<&'a mut Tool> {
    if let Some(id) = id {
        return tools.iter_mut().find(|tool| tool.id.as_deref() == Some(id) && tool.status == ToolStatus::Running);
    }
    tools.iter_mut().find(|tool| {
        tool.status == ToolStatus::Running && name.is_none_or(|name| tool.name == name)
    })
}
