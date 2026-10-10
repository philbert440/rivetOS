use std::collections::HashMap;

use serde_json::Value;

use crate::text::{extract_turn_text, field_str, objects_from_lines, parse_json_value, summarize_turn_args};
use crate::turn::{LastBlock, Tool, ToolStatus, Turn, cap_thinking, cap_result, is_prompt_tool_name, prompt_input};
use crate::value::{Obj, jtrim};

pub fn grok_turns_from_lines(lines: &[Obj]) -> Vec<Turn> {
    let mut fold = Fold::default();
    for obj in lines {
        fold.line(obj);
    }
    fold.finish();
    fold.turns
}

pub fn grok_turns_from_text(lines: &[String]) -> Vec<Turn> {
    grok_turns_from_lines(&objects_from_lines(lines))
}

pub fn grok_pick_turn(obj: &Obj) -> Option<Turn> {
    let kind = line_type(obj);
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if kind == "user" && synthetic_skip(obj) {
        return None;
    }
    let text = extract_turn_text(obj.get("content").unwrap_or(&Value::Null), kind)?;
    Some(Turn::user_role(kind, text))
}

#[derive(Default)]
struct Fold {
    turns: Vec<Turn>,
    cur: Option<Turn>,
    tools: Vec<Tool>,
    by_id: HashMap<String, usize>,
    thinking: String,
    last_final: bool,
}


impl Fold {
    fn finish(&mut self) {
        let Some(mut cur) = self.cur.take() else {
            return;
        };
        if !self.thinking.is_empty() {
            cur.raw_thinking = Some(self.thinking.clone());
            cur.thinking = Some(cap_thinking(&self.thinking));
        }
        cur.tools = if self.tools.is_empty() { None } else { Some(std::mem::take(&mut self.tools)) };
        let running = cur.tools.as_ref().is_some_and(|tools| tools.iter().any(|tool| tool.status == ToolStatus::Running));
        if cur.stop_reason.as_deref() == Some("end_turn") && self.last_final && !running {
            cur.complete = Some(true);
        }
        if !cur.text.is_empty() || cur.thinking.is_some() || cur.tools.is_some() {
            self.turns.push(cur);
        }
        self.thinking.clear();
        self.last_final = false;
        self.tools.clear();
        self.by_id.clear();
    }

    fn ensure(&mut self) {
        if self.cur.is_none() {
            let mut turn = Turn::assistant();
            turn.tools = None;
            self.cur = Some(turn);
        }
    }

    fn line(&mut self, obj: &Obj) {
        let kind = line_type(obj);
        if kind == "system" {
            return;
        }
        if kind == "reasoning" {
            self.reasoning(obj);
            return;
        }
        if kind == "tool_result" || kind == "tool" {
            self.tool_result(obj);
            return;
        }
        if kind == "user" {
            self.user(obj);
            return;
        }
        if kind == "assistant" {
            self.assistant(obj);
        }
    }

    fn reasoning(&mut self, obj: &Obj) {
        self.ensure();
        let text = grok_reasoning_text(obj);
        if !text.is_empty() {
            self.thinking.push_str(&text);
        }
        if let Some(cur) = self.cur.as_mut() {
            cur.last_block = Some(LastBlock::Thinking);
            if cur.stop_reason.as_deref() != Some("end_turn") {
                cur.stop_reason = Some("tool_use".into());
            }
        }
        self.last_final = false;
    }

    fn tool_result(&mut self, obj: &Obj) {
        if let Some(cur) = self.cur.as_mut() {
            cur.last_block = Some(LastBlock::ToolResult);
        }
        let id = obj.get("tool_call_id").and_then(Value::as_str);
        let Some(index) = id.and_then(|id| self.by_id.get(id).copied()) else {
            self.last_final = false;
            return;
        };
        if let Some(entry) = self.tools.get_mut(index) {
            entry.status = ToolStatus::Done;
            if is_prompt_tool_name(&entry.name) {
                let text = result_text(obj.get("content"));
                if !text.is_empty() {
                    entry.result_text = Some(cap_result(&text));
                }
            }
        }
        self.last_final = false;
    }

    fn user(&mut self, obj: &Obj) {
        if synthetic_skip(obj) {
            return;
        }
        let Some(text) = extract_turn_text(obj.get("content").unwrap_or(&Value::Null), "user") else {
            return;
        };
        self.finish();
        self.turns.push(Turn::user(text));
    }

    fn assistant(&mut self, obj: &Obj) {
        self.ensure();
        if let Some(model) = grok_model(obj)
            && let Some(cur) = self.cur.as_mut() {
                cur.model = Some(model);
            }
        let text = extract_turn_text(obj.get("content").unwrap_or(&Value::Null), "assistant");
        if let Some(text) = text.clone()
            && let Some(cur) = self.cur.as_mut() {
                if cur.text.is_empty() {
                    cur.text = text;
                } else {
                    cur.text = format!("{}\n\n{text}", cur.text);
                }
            }
        let calls = obj.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();
        if !calls.is_empty() {
            for call in &calls {
                self.push_call(call);
            }
            if let Some(cur) = self.cur.as_mut() {
                cur.last_block = Some(LastBlock::ToolUse);
                cur.stop_reason = Some("tool_use".into());
            }
            self.last_final = false;
        } else {
            if text.is_some()
                && let Some(cur) = self.cur.as_mut() {
                    cur.last_block = Some(LastBlock::Text);
                }
            if let Some(cur) = self.cur.as_mut() {
                cur.stop_reason = Some("end_turn".into());
            }
            self.last_final = true;
        }
    }

    fn push_call(&mut self, raw: &Value) {
        let Some(parsed) = parse_grok_tool_call(raw) else {
            return;
        };
        let mut entry = Tool {
            name: parsed.name.clone(),
            status: ToolStatus::Running,
            args: summarize_turn_args(&parsed.args),
            id: parsed.id.clone(),
            input: None,
            result_text: None,
        };
        if is_prompt_tool_name(&parsed.name) {
            entry.input = Some(prompt_input(&parsed.args));
        }
        if let Some(id) = entry.id.clone() {
            self.by_id.insert(id, self.tools.len());
        }
        self.tools.push(entry);
    }
}

struct ParsedCall {
    id: Option<String>,
    name: String,
    args: Value,
}

fn parse_grok_tool_call(raw: &Value) -> Option<ParsedCall> {
    let obj = raw.as_object()?;
    let function = obj.get("function").and_then(Value::as_object);
    let name = field_str(obj, "name")
        .or_else(|| function.and_then(|item| field_str(item, "name")))?;
    let args = obj
        .get("arguments")
        .or_else(|| function.and_then(|item| item.get("arguments")))
        .map(parse_json_value)
        .unwrap_or(Value::Null);
    Some(ParsedCall { id: field_str(obj, "id"), name, args })
}

fn grok_reasoning_text(obj: &Obj) -> String {
    let Some(summary) = obj.get("summary").and_then(Value::as_array) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in summary {
        let Some(block) = item.as_object() else {
            continue;
        };
        if block.get("type").and_then(Value::as_str) != Some("summary_text") {
            continue;
        }
        let Some(text) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        if !jtrim(text).is_empty() {
            parts.push(text.to_string());
        }
    }
    parts.join("\n")
}

fn grok_model(obj: &Obj) -> Option<String> {
    for key in ["model_id", "model"] {
        if let Some(text) = obj.get(key).and_then(Value::as_str) {
            let trimmed = jtrim(text);
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn line_type(obj: &Obj) -> &str {
    obj.get("type")
        .and_then(Value::as_str)
        .or_else(|| obj.get("role").and_then(Value::as_str))
        .unwrap_or("")
}

fn synthetic_skip(obj: &Obj) -> bool {
    match obj.get("synthetic_reason") {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) if text.is_empty() => false,
        Some(_) => true,
    }
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(other) => protocol::js::stringify(other),
        None => String::new(),
    }
}

impl Turn {
    pub fn user_role(role: &str, text: String) -> Self {
        let mut turn = if role == "assistant" { Self::assistant() } else { Self::user(text.clone()) };
        if role == "assistant" {
            turn.text = text;
            turn.tools = None;
        }
        turn
    }
}

