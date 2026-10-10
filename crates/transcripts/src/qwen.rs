use serde_json::Value;

use crate::text::{as_i64, extract_turn_text, finite_num, objects_from_lines, pick_nonempty, summarize_turn_args};
use crate::turn::{LastBlock, Role, Tool, ToolStatus, Turn, Usage, cap_thinking};
use crate::value::{Obj, jtrim};

pub fn qwen_turns_from_lines(lines: &[Obj]) -> Vec<Turn> {
    let mut turns = Vec::new();
    for obj in lines {
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "system" {
            maybe_close_from_telemetry(&mut turns, obj);
            continue;
        }
        if kind == "tool_result" {
            apply_tool_result(&mut turns, obj);
            continue;
        }
        if kind == "user" {
            if obj.get("provenance").and_then(Value::as_str) != Some("real_user") {
                continue;
            }
            push_user(&mut turns, obj);
            continue;
        }
        if kind == "assistant" {
            push_assistant(&mut turns, obj);
        }
    }
    turns
}

pub fn qwen_turns_from_text(lines: &[String]) -> Vec<Turn> {
    qwen_turns_from_lines(&objects_from_lines(lines))
}

fn maybe_close_from_telemetry(turns: &mut [Turn], obj: &Obj) {
    let Some(ui) = ui_event(obj) else {
        return;
    };
    if pick_nonempty(&ui, &["event.name"]).as_deref() != Some("qwen-code.api_response") {
        return;
    }
    if !ui.get("response_text").is_some_and(Value::is_string) {
        return;
    }
    let Some(last) = turns.last() else {
        return;
    };
    if last.role == Role::Assistant
        && last.complete != Some(true)
        && last.last_block == Some(LastBlock::Text)
        && !last.tools.as_ref().is_some_and(|tools| tools.iter().any(|tool| tool.status == ToolStatus::Running))
    {
        close_last(turns);
    }
}

fn ui_event(obj: &Obj) -> Option<Obj> {
    if obj.get("type").and_then(Value::as_str) != Some("system") {
        return None;
    }
    if obj.get("subtype").and_then(Value::as_str) != Some("ui_telemetry") {
        return None;
    }
    let payload = obj.get("systemPayload").and_then(Value::as_object)?;
    payload.get("uiEvent").and_then(Value::as_object).cloned()
}

fn apply_tool_result(turns: &mut [Turn], obj: &Obj) {
    let Some(message) = obj.get("message").and_then(Value::as_object) else {
        return;
    };
    for part in message_parts(message) {
        let Some(response) = part.get("functionResponse").and_then(Value::as_object) else {
            continue;
        };
        complete_running(turns, pick_nonempty(response, &["id"]), pick_nonempty(response, &["name"]));
    }
}

fn push_user(turns: &mut Vec<Turn>, obj: &Obj) {
    let Some(message) = obj.get("message").and_then(Value::as_object) else {
        return;
    };
    let mut parts = Vec::new();
    for part in message_parts(message) {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            let trimmed = jtrim(text);
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    let joined = parts.join("\n");
    let text = extract_turn_text(&Value::String(joined.clone()), "user").unwrap_or_else(|| jtrim(&joined).to_string());
    if text.is_empty() {
        return;
    }
    close_last(turns);
    turns.push(Turn::user(text));
}

fn push_assistant(turns: &mut Vec<Turn>, obj: &Obj) {
    let Some(message) = obj.get("message").and_then(Value::as_object) else {
        return;
    };
    let mut tools = Vec::new();
    let mut thinking = String::new();
    let mut text_parts = Vec::new();
    let mut last_block = None;
    for part in message_parts(message) {
        if part.get("thought") == Some(&Value::Bool(true)) {
            if let Some(text) = part.get("text").and_then(Value::as_str)
                && !text.is_empty() {
                    thinking.push_str(text);
                    last_block = Some(LastBlock::Thinking);
                }
            continue;
        }
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            let trimmed = jtrim(text);
            if !trimmed.is_empty() {
                text_parts.push(trimmed.to_string());
                last_block = Some(LastBlock::Text);
                continue;
            }
        }
        let Some(call) = part.get("functionCall").and_then(Value::as_object) else {
            continue;
        };
        let Some(name) = pick_nonempty(call, &["name"]) else {
            continue;
        };
        let entry = Tool {
            name,
            status: ToolStatus::Running,
            args: call.get("args").and_then(summarize_turn_args),
            id: pick_nonempty(call, &["id"]),
            input: None,
            result_text: None,
        };
        tools.push(entry);
        last_block = Some(LastBlock::ToolUse);
    }
    let joined = text_parts.join("\n");
    let extracted = extract_turn_text(&Value::String(joined.clone()), "assistant");
    let text = extracted.unwrap_or_else(|| jtrim(&joined).to_string());
    if text.is_empty() && thinking.is_empty() && tools.is_empty() {
        return;
    }
    let mut turn = Turn::assistant();
    turn.tools = None;
    turn.text = text;
    if !thinking.is_empty() {
        turn.raw_thinking = Some(thinking.clone());
        turn.thinking = Some(cap_thinking(&thinking));
    }
    let running = tools.iter().any(|tool| tool.status == ToolStatus::Running);
    if !tools.is_empty() {
        turn.tools = Some(tools);
    }
    turn.last_block = last_block;
    if let Some(usage) = usage_from_metadata(obj) {
        turn.usage = Some(usage);
    }
    if let Some(model) = obj.get("model").and_then(Value::as_str) {
        let trimmed = jtrim(model);
        if !trimmed.is_empty() {
            turn.model = Some(trimmed.to_string());
        }
    }
    if last_block == Some(LastBlock::Text) && !running {
        turn.stop_reason = Some("end_turn".into());
        turn.complete = Some(true);
    } else if turn.tools.is_some() {
        turn.stop_reason = Some("tool_use".into());
    }
    turns.push(turn);
}

fn close_last(turns: &mut [Turn]) {
    let Some(last) = turns.last_mut() else {
        return;
    };
    if last.role != Role::Assistant || last.complete == Some(true) {
        return;
    }
    last.complete = Some(true);
    if last.stop_reason.is_none() || last.stop_reason.as_deref() == Some("tool_use") {
        last.stop_reason = Some("end_turn".into());
    }
}

fn message_parts(message: &Obj) -> Vec<Obj> {
    message
        .get("parts")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_object().cloned()).collect())
        .unwrap_or_default()
}

fn usage_from_metadata(obj: &Obj) -> Option<Usage> {
    let usage = obj.get("usageMetadata").and_then(Value::as_object)?;
    let input = finite_num(usage.get("promptTokenCount"));
    let output = finite_num(usage.get("candidatesTokenCount"));
    let cache_read = finite_num(usage.get("cachedContentTokenCount"));
    if input <= 0.0 && output <= 0.0 && cache_read <= 0.0 {
        return None;
    }
    Some(Usage {
        prompt_tokens: as_i64(input),
        completion_tokens: as_i64(output),
        cached_tokens: as_i64(cache_read),
    })
}

fn complete_running(turns: &mut [Turn], id: Option<String>, name: Option<String>) {
    for turn in turns.iter_mut().rev() {
        let Some(tools) = turn.tools.as_mut() else {
            continue;
        };
        let found = if let Some(id) = id.as_deref() {
            tools.iter_mut().find(|tool| tool.id.as_deref() == Some(id) && tool.status == ToolStatus::Running)
        } else {
            tools.iter_mut().find(|tool| {
                tool.status == ToolStatus::Running && name.as_ref().is_none_or(|name| &tool.name == name)
            })
        };
        if let Some(entry) = found {
            entry.status = ToolStatus::Done;
            return;
        }
    }
}
