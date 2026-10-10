use std::collections::HashMap;

use serde_json::Value;

use crate::text::{as_i64, extract_turn_text, finite_num, summarize_turn_args};
use crate::turn::{LastBlock, Tool, ToolStatus, Turn, Usage, cap_thinking};
use crate::value::{Obj, jtrim};

pub fn opencode_turns_from_messages(messages: &[Obj], parts_by_message: &HashMap<String, Vec<Obj>>) -> Vec<Turn> {
    let mut ordered: Vec<&Obj> = messages.iter().collect();
    ordered.sort_by(|left, right| message_time(left).total_cmp(&message_time(right)));
    let mut turns = Vec::new();
    for msg in ordered {
        let role_raw = msg.get("role").and_then(Value::as_str).unwrap_or("");
        if role_raw == "system" {
            continue;
        }
        let role = if role_raw == "assistant" { "assistant" } else { "user" };
        let id = msg.get("id").and_then(Value::as_str).unwrap_or("");
        let mut parts = inline_parts(msg);
        if let Some(extra) = parts_by_message.get(id) {
            parts.extend(extra.iter().cloned());
        }
        if role == "user" {
            push_user(&mut turns, msg, &parts);
        } else {
            push_assistant(&mut turns, msg, &parts);
        }
    }
    turns
}

fn push_user(turns: &mut Vec<Turn>, msg: &Obj, parts: &[Obj]) {
    let from_content = msg.get("content").and_then(Value::as_str).unwrap_or("");
    let from_parts = parts.iter().map(part_text).collect::<String>();
    let extracted = msg.get("content").and_then(|content| extract_turn_text(content, "user")).unwrap_or_default();
    let text = if !from_content.is_empty() {
        from_content.to_string()
    } else if !from_parts.is_empty() {
        from_parts
    } else {
        extracted
    };
    let text = jtrim(&text).to_string();
    if !text.is_empty() {
        turns.push(Turn::user(text));
    }
}

fn push_assistant(turns: &mut Vec<Turn>, msg: &Obj, parts: &[Obj]) {
    let mut text = String::new();
    let mut thinking = String::new();
    let mut last_block = None;
    let mut saw_step_finish = false;
    let mut tools = Vec::new();
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "step-start" || kind == "step_start" {
            continue;
        }
        if kind == "step-finish" || kind == "step_finish" {
            saw_step_finish = true;
            continue;
        }
        if kind == "reasoning" || kind == "thinking" || kind == "think" {
            thinking.push_str(&part_text(part));
            last_block = Some(LastBlock::Thinking);
            continue;
        }
        if kind == "tool" || kind == "tool_use" || kind == "tool-call" {
            tools.push(tool_from_part(part, tools.len()));
            let status = tools.last().map(|tool| tool.status);
            last_block = Some(if status == Some(ToolStatus::Running) {
                LastBlock::ToolUse
            } else {
                LastBlock::ToolResult
            });
            continue;
        }
        if kind == "text" || kind.is_empty() || kind == "content" {
            let piece = part_text(part);
            text.push_str(&piece);
            if !piece.is_empty() {
                last_block = Some(LastBlock::Text);
            }
        }
    }
    if text.is_empty()
        && let Some(content) = msg.get("content").and_then(Value::as_str) {
            text = content.to_string();
        }
    if text.is_empty() && parts.is_empty() {
        text = extract_turn_text(msg.get("content").unwrap_or(&Value::Null), "assistant").unwrap_or_default();
    }
    let mut turn = Turn::assistant();
    turn.tools = None;
    turn.text = jtrim(&text).to_string();
    if !thinking.is_empty() {
        turn.raw_thinking = Some(thinking.clone());
        turn.thinking = Some(cap_thinking(&thinking));
    }
    let running = tools.iter().any(|tool| tool.status == ToolStatus::Running);
    if !tools.is_empty() {
        turn.tools = Some(tools);
    }
    turn.model = model_of(msg);
    if let Some(usage) = usage_from_msg(msg) {
        turn.usage = Some(usage);
    }
    let completed = msg
        .get("time")
        .and_then(Value::as_object)
        .and_then(|time| time.get("completed"))
        .and_then(Value::as_f64);
    let finished = saw_step_finish || completed.is_some();
    turn.last_block = last_block;
    if running {
        turn.stop_reason = Some("tool_use".into());
    } else if finished {
        turn.stop_reason = Some("end_turn".into());
        if !turn.text.is_empty() {
            turn.last_block = Some(LastBlock::Text);
        }
        turn.complete = Some(true);
    }
    if !turn.text.is_empty() || turn.thinking.is_some() || turn.tools.is_some() {
        turns.push(turn);
    }
}

fn tool_from_part(part: &Obj, index: usize) -> Tool {
    let name = part
        .get("tool")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .or_else(|| part.get("name").and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string))
        .or_else(|| {
            part.get("tool")
                .and_then(Value::as_object)
                .and_then(|tool| tool.get("name"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "tool".into());
    let state = part.get("state").and_then(Value::as_object);
    let call_id = part
        .get("id")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .or_else(|| nonempty_str(part, "toolCallId"))
        .or_else(|| nonempty_str(part, "callID"))
        .unwrap_or_else(|| format!("{name}_{index}"));
    let args_value = state
        .and_then(|state| state.get("input"))
        .or_else(|| {
            part.get("tool").and_then(Value::as_object).and_then(|tool| tool.get("input").or_else(|| tool.get("args")))
        })
        .or_else(|| part.get("input"))
        .or_else(|| part.get("args"));
    let status = if part.get("isError") == Some(&Value::Bool(true))
        || state.and_then(|state| state.get("status")).and_then(Value::as_str) == Some("error")
    {
        ToolStatus::Error
    } else if state.and_then(|state| state.get("status")).and_then(Value::as_str) == Some("running") {
        ToolStatus::Running
    } else {
        ToolStatus::Done
    };
    Tool {
        name,
        status,
        args: args_value.and_then(summarize_turn_args),
        id: Some(call_id),
        input: None,
        result_text: None,
    }
}

fn nonempty_str(obj: &Obj, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string)
}

fn part_text(part: &Obj) -> String {
    if let Some(text) = part.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = part.get("text").and_then(Value::as_object).and_then(|obj| obj.get("value")).and_then(Value::as_str)
    {
        return text.to_string();
    }
    part.get("content").and_then(|content| extract_turn_text(content, "assistant")).unwrap_or_default()
}

fn model_of(msg: &Obj) -> Option<String> {
    if let Some(id) = msg.get("modelID").and_then(Value::as_str) {
        let provider = msg.get("providerID").and_then(Value::as_str).unwrap_or("");
        return Some(if provider.is_empty() { id.to_string() } else { format!("{provider}/{id}") });
    }
    if let Some(model) = msg.get("model").and_then(Value::as_object)
        && let Some(id) = model.get("modelID").and_then(Value::as_str) {
            return Some(id.to_string());
        }
    msg.get("model").and_then(Value::as_str).map(str::to_string)
}

fn usage_from_msg(msg: &Obj) -> Option<Usage> {
    let tokens = msg.get("tokens").and_then(Value::as_object)?;
    let cache = tokens.get("cache").and_then(Value::as_object);
    let prompt = finite_num(tokens.get("input"))
        + cache.map(|cache| finite_num(cache.get("read"))).unwrap_or(0.0)
        + cache.map(|cache| finite_num(cache.get("write"))).unwrap_or(0.0);
    let completion = finite_num(tokens.get("output")) + finite_num(tokens.get("reasoning"));
    if prompt <= 0.0 && completion <= 0.0 {
        return None;
    }
    Some(Usage {
        prompt_tokens: as_i64(prompt),
        completion_tokens: as_i64(completion),
        cached_tokens: as_i64(cache.map(|cache| finite_num(cache.get("read"))).unwrap_or(0.0)),
    })
}

fn message_time(msg: &Obj) -> f64 {
    if let Some(number) = msg.get("time_created").and_then(Value::as_f64)
        && number.is_finite() {
            return number;
        }
    if let Some(time) = msg.get("time").and_then(Value::as_object)
        && let Some(number) = time.get("created").and_then(Value::as_f64)
            && number.is_finite() {
                return number;
            }
    msg.get("createdAt").and_then(Value::as_f64).filter(|number| number.is_finite()).unwrap_or(0.0)
}

fn inline_parts(msg: &Obj) -> Vec<Obj> {
    if let Some(parts) = msg.get("parts").and_then(Value::as_array) {
        return parts.iter().filter_map(|item| item.as_object().cloned()).collect();
    }
    if let Some(parts) = msg.get("content").and_then(Value::as_array) {
        return parts.iter().filter_map(|item| item.as_object().cloned()).collect();
    }
    Vec::new()
}
