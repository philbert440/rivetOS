use serde_json::Value;

use crate::text::{objects_from_lines, summarize_turn_args};
use crate::turn::{LastBlock, Role, Tool, ToolStatus, Turn};
use crate::value::{Obj, jtrim};

pub fn cursor_turns_from_objects(objects: &[Obj]) -> Vec<Turn> {
    let mut turns = Vec::new();
    for obj in objects {
        let Some(role) = obj.get("role").and_then(Value::as_str) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let mut texts = Vec::new();
        let mut tools = Vec::new();
        let mut last_block = None;
        for part in content_parts(obj.get("message")) {
            let Some(part) = part.as_object() else {
                continue;
            };
            if part.get("type").and_then(Value::as_str) == Some("text")
                && let Some(text) = part.get("text").and_then(Value::as_str)
                    && !jtrim(text).is_empty() {
                        texts.push(text.to_string());
                        last_block = Some(LastBlock::Text);
                    }
            if part.get("type").and_then(Value::as_str) != Some("tool_use") || role != "assistant" {
                continue;
            }
            let Some(name) = part.get("name").and_then(Value::as_str) else {
                continue;
            };
            if name == "SendMessage"
                && let Some(input) = part.get("input").and_then(Value::as_object)
                    && let Some(body) = input.get("content").and_then(Value::as_str)
                        && !jtrim(body).is_empty() && !texts.iter().any(|text| text.contains(body)) {
                            texts.push(body.to_string());
                        }
            let args = part.get("input").and_then(summarize_turn_args);
            tools.push(Tool {
                name: name.to_string(),
                status: ToolStatus::Done,
                args,
                id: None,
                input: None,
                result_text: None,
            });
            last_block = Some(LastBlock::ToolUse);
        }
        let text = jtrim(&texts.join("\n")).to_string();
        if text.is_empty() && tools.is_empty() {
            continue;
        }
        let mut turn = if role == "assistant" {
            let mut turn = Turn::assistant();
            turn.tools = None;
            turn
        } else {
            Turn::user(String::new())
        };
        turn.role = if role == "assistant" { Role::Assistant } else { Role::User };
        turn.text = text;
        if !tools.is_empty() {
            turn.tools = Some(tools);
        }
        turn.last_block = last_block;
        if role == "assistant" {
            turn.complete = Some(true);
        }
        turns.push(turn);
    }
    turns
}

pub fn cursor_turns_from_text(lines: &[String]) -> Vec<Turn> {
    cursor_turns_from_objects(&objects_from_lines(lines))
}

fn content_parts(message: Option<&Value>) -> Vec<Value> {
    let Some(message) = message.and_then(Value::as_object) else {
        return Vec::new();
    };
    match message.get("content") {
        Some(Value::String(text)) => {
            let mut obj = Obj::new();
            obj.insert("type".into(), Value::String("text".into()));
            obj.insert("text".into(), Value::String(text.clone()));
            vec![Value::Object(obj)]
        }
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}
