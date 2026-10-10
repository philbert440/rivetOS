use std::collections::HashMap;

use serde_json::Value;

use crate::text::{extract_turn_text, field_str, parse_json_value, summarize_turn_args};
use crate::turn::{LastBlock, Tool, ToolStatus, Turn, cap_result, cap_thinking, is_prompt_tool_name, prompt_input};
use crate::value::{Obj, jtrim};

pub fn hermes_turns_from_rows(rows: &[Obj]) -> Vec<Turn> {
    let mut fold = Fold::default();
    for row in rows {
        fold.line(row);
    }
    fold.finish();
    fold.turns
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
    fn ensure(&mut self) {
        if self.cur.is_none() {
            let mut turn = Turn::assistant();
            turn.tools = None;
            self.cur = Some(turn);
        }
    }

    fn finish(&mut self) {
        let Some(mut cur) = self.cur.take() else {
            return;
        };
        if !self.thinking.is_empty() {
            cur.raw_thinking = Some(self.thinking.clone());
            cur.thinking = Some(cap_thinking(&self.thinking));
        }
        cur.tools = if self.tools.is_empty() { None } else { Some(std::mem::take(&mut self.tools)) };
        let running = cur
            .tools
            .as_ref()
            .is_some_and(|tools| tools.iter().any(|tool| tool.status == ToolStatus::Running));
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

    fn line(&mut self, row: &Obj) {
        let role = row.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "user" {
            self.user(row);
        } else if role == "tool" {
            self.tool(row);
        } else if role == "assistant" {
            self.assistant(row);
        }
    }

    fn user(&mut self, row: &Obj) {
        let Some(text) = extract_turn_text(row.get("content").unwrap_or(&Value::Null), "user") else {
            return;
        };
        self.finish();
        self.turns.push(Turn::user(text));
    }

    fn tool(&mut self, row: &Obj) {
        if let Some(cur) = self.cur.as_mut() {
            cur.last_block = Some(LastBlock::ToolResult);
        }
        let call_id = field_str(row, "tool_call_id");
        let mut index = call_id.as_ref().and_then(|id| self.by_id.get(id).copied());
        if index.is_none() && (call_id.is_some() || field_str(row, "tool_name").is_some()) {
            let name = field_str(row, "tool_name").unwrap_or_else(|| "unknown".into());
            let entry = Tool {
                name,
                status: ToolStatus::Done,
                args: None,
                id: call_id.clone(),
                input: None,
                result_text: None,
            };
            index = Some(self.tools.len());
            if let Some(id) = call_id.clone() {
                self.by_id.insert(id, self.tools.len());
            }
            self.tools.push(entry);
            self.ensure();
        }
        if let Some(index) = index
            && let Some(entry) = self.tools.get_mut(index) {
                entry.status = ToolStatus::Done;
                if is_prompt_tool_name(&entry.name)
                    && let Some(text) = row.get("content").and_then(Value::as_str)
                        && !text.is_empty() {
                            entry.result_text = Some(cap_result(text));
                        }
            }
        self.last_final = false;
    }

    fn assistant(&mut self, row: &Obj) {
        self.ensure();
        let thought = hermes_thinking(row);
        if !thought.is_empty() {
            self.thinking.push_str(&thought);
        }
        let text = extract_turn_text(row.get("content").unwrap_or(&Value::Null), "assistant");
        if let Some(text) = text.clone()
            && let Some(cur) = self.cur.as_mut() {
                if cur.text.is_empty() {
                    cur.text = text;
                } else {
                    cur.text = format!("{}\n\n{text}", cur.text);
                }
            }
        let calls = parse_hermes_tool_calls(row.get("tool_calls"));
        if !calls.is_empty() {
            for parsed in &calls {
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
                if let Some(id) = parsed.id.clone() {
                    self.by_id.insert(id, self.tools.len());
                }
                self.tools.push(entry);
            }
            if let Some(cur) = self.cur.as_mut() {
                cur.last_block = Some(LastBlock::ToolUse);
                cur.stop_reason = Some("tool_use".into());
            }
            self.last_final = false;
        } else if !thought.is_empty() && text.is_none() {
            if let Some(cur) = self.cur.as_mut() {
                cur.last_block = Some(LastBlock::Thinking);
                if cur.stop_reason.as_deref() != Some("end_turn") {
                    cur.stop_reason = Some("tool_use".into());
                }
            }
            self.last_final = false;
        } else if text.is_some()
            && let Some(cur) = self.cur.as_mut() {
                cur.last_block = Some(LastBlock::Text);
            }
        let finish = row.get("finish_reason").and_then(Value::as_str).unwrap_or("");
        if finish == "stop" {
            if let Some(cur) = self.cur.as_mut() {
                cur.stop_reason = Some("end_turn".into());
            }
            if text.is_some() {
                self.last_final = true;
            }
        } else if finish == "tool_calls" {
            if let Some(cur) = self.cur.as_mut() {
                cur.stop_reason = Some("tool_use".into());
            }
            self.last_final = false;
        } else if calls.is_empty() && text.is_some() && finish.is_empty() {
            if let Some(cur) = self.cur.as_mut() {
                cur.stop_reason = Some("end_turn".into());
            }
            self.last_final = true;
        }
    }
}

struct Parsed {
    id: Option<String>,
    name: String,
    args: Value,
}

fn parse_hermes_tool_calls(raw: Option<&Value>) -> Vec<Parsed> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let value = if let Some(text) = raw.as_str() {
        let trimmed = jtrim(text);
        if trimmed.is_empty() {
            return Vec::new();
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        }
    } else {
        raw.clone()
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let function = obj.get("function").and_then(Value::as_object);
        let Some(name) = field_str(obj, "name").or_else(|| function.and_then(|item| field_str(item, "name")))
        else {
            continue;
        };
        let args = obj
            .get("arguments")
            .or_else(|| function.and_then(|item| item.get("arguments")))
            .map(parse_json_value)
            .unwrap_or(Value::Null);
        out.push(Parsed { id: field_str(obj, "id"), name, args });
    }
    out
}

fn hermes_thinking(row: &Obj) -> String {
    let a = row.get("reasoning").and_then(Value::as_str).unwrap_or("");
    let b = row.get("reasoning_content").and_then(Value::as_str).unwrap_or("");
    jtrim(if a.is_empty() { b } else { a }).to_string()
}
