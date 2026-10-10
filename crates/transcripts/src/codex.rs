use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::error::{TranscriptError, codex_approval_keys};
use crate::text::{
    as_i64, content_text, finite_num, objects_from_lines, parse_json_value, summarize_turn_args, truthy_error,
};
use crate::turn::{LastBlock, Tool, ToolStatus, Turn, Usage, cap_thinking};
use crate::value::Obj;

pub fn codex_turns_from_lines(lines: &[Obj]) -> Vec<Turn> {
    let mut fold = Fold::default();
    for obj in lines {
        fold.line(obj);
    }
    let complete = fold.had_final_text;
    fold.finish(complete);
    fold.turns
}

pub fn codex_turns_from_text(lines: &[String]) -> Vec<Turn> {
    codex_turns_from_lines(&objects_from_lines(lines))
}

pub fn codex_reject_approval() -> Result<(), TranscriptError> {
    codex_approval_keys()
}

struct Fold {
    turns: Vec<Turn>,
    cur: Option<Turn>,
    tools: Vec<Tool>,
    by_id: HashMap<String, usize>,
    thinking: String,
    prompt: f64,
    completion: f64,
    cached: f64,
    had_text: bool,
    had_final_text: bool,
}

impl Default for Fold {
    fn default() -> Self {
        Self {
            turns: Vec::new(),
            cur: None,
            tools: Vec::new(),
            by_id: HashMap::new(),
            thinking: String::new(),
            prompt: 0.0,
            completion: 0.0,
            cached: 0.0,
            had_text: false,
            had_final_text: false,
        }
    }
}

impl Fold {
    fn ensure(&mut self) {
        if self.cur.is_none() {
            let mut turn = Turn::assistant();
            turn.tools = None;
            self.cur = Some(turn);
        }
    }

    fn finish(&mut self, complete: bool) {
        let Some(mut cur) = self.cur.take() else {
            self.reset();
            return;
        };
        if !self.thinking.is_empty() {
            cur.raw_thinking = Some(self.thinking.clone());
            cur.thinking = Some(cap_thinking(&self.thinking));
        }
        cur.tools = if self.tools.is_empty() { None } else { Some(std::mem::take(&mut self.tools)) };
        if self.prompt > 0.0 || self.completion > 0.0 {
            cur.usage = Some(Usage {
                prompt_tokens: as_i64(self.prompt),
                completion_tokens: as_i64(self.completion),
                cached_tokens: as_i64(self.cached),
            });
        }
        let running = cur
            .tools
            .as_ref()
            .is_some_and(|tools| tools.iter().any(|tool| tool.status == ToolStatus::Running));
        if running {
            cur.stop_reason = Some("tool_use".into());
        } else if complete && self.had_text {
            cur.stop_reason = Some("end_turn".into());
        }
        if complete && self.had_text && !running {
            cur.complete = Some(true);
        }
        if !cur.text.is_empty() || cur.thinking.is_some() || cur.tools.is_some() {
            self.turns.push(cur);
        }
        self.reset();
    }

    fn reset(&mut self) {
        self.cur = None;
        self.had_text = false;
        self.had_final_text = false;
        self.thinking.clear();
        self.prompt = 0.0;
        self.completion = 0.0;
        self.cached = 0.0;
        self.tools.clear();
        self.by_id.clear();
    }

    fn line(&mut self, obj: &Obj) {
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = obj.get("payload").and_then(Value::as_object);
        if kind == "token_usage_record" {
            if let Some(payload) = payload {
                self.prompt = finite_num(payload.get("input_tokens"));
                self.cached = finite_num(payload.get("cached_input_tokens"));
                self.completion = finite_num(payload.get("output_tokens"))
                    + finite_num(payload.get("reasoning_output_tokens"));
            }
            return;
        }
        if kind == "event_msg" && payload.and_then(|item| item.get("type")).and_then(Value::as_str) == Some("task_complete")
        {
            self.finish(true);
            return;
        }
        let Some(payload) = payload else {
            return;
        };
        if kind != "response_item" {
            return;
        }
        match payload.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => self.message(payload),
            "reasoning" => self.reasoning(payload),
            "function_call" | "custom_tool_call" => self.tool_call(payload),
            "function_call_output" | "custom_tool_call_output" => self.tool_output(payload),
            _ => {}
        }
    }

    fn message(&mut self, payload: &Obj) {
        let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "developer" {
            return;
        }
        if role == "user" {
            let Some(text) = payload.get("content").and_then(|content| content_text(content, "input_text")) else {
                return;
            };
            self.finish(true);
            self.turns.push(Turn::user(text));
            return;
        }
        if role != "assistant" {
            return;
        }
        let Some(text) = payload.get("content").and_then(|content| content_text(content, "output_text")) else {
            return;
        };
        self.ensure();
        if let Some(asst) = self.cur.as_mut() {
            if asst.text.is_empty() {
                asst.text = text;
            } else {
                asst.text = format!("{}\n\n{text}", asst.text);
            }
            asst.last_block = Some(LastBlock::Text);
        }
        self.had_text = true;
        if payload.get("phase").and_then(Value::as_str) != Some("commentary") {
            self.had_final_text = true;
        }
    }

    fn reasoning(&mut self, payload: &Obj) {
        let chunk = reasoning_text(payload);
        if chunk.is_empty() {
            return;
        }
        self.ensure();
        if let Some(asst) = self.cur.as_mut() {
            asst.last_block = Some(LastBlock::Thinking);
        }
        self.thinking.push_str(&chunk);
    }

    fn tool_call(&mut self, payload: &Obj) {
        let Some(name) = field_name(payload) else {
            return;
        };
        let input = parse_json_value(
            payload.get("input").or_else(|| payload.get("arguments")).unwrap_or(&Value::Null),
        );
        let args_value = if input.is_string() {
            let mut map = Map::new();
            map.insert("input".into(), input.clone());
            Value::Object(map)
        } else {
            input
        };
        let entry = Tool {
            name,
            status: ToolStatus::Running,
            args: summarize_turn_args(&args_value),
            id: field_call_id(payload),
            input: None,
            result_text: None,
        };
        self.ensure();
        if let Some(id) = entry.id.clone() {
            self.by_id.insert(id, self.tools.len());
        }
        self.tools.push(entry);
        if let Some(cur) = self.cur.as_mut() {
            cur.last_block = Some(LastBlock::ToolUse);
        }
    }

    fn tool_output(&mut self, payload: &Obj) {
        let Some(index) = field_call_id(payload).and_then(|id| self.by_id.get(&id).copied()) else {
            return;
        };
        if let Some(entry) = self.tools.get_mut(index) {
            entry.status = if truthy_error(payload.get("error")) { ToolStatus::Error } else { ToolStatus::Done };
        }
        if let Some(cur) = self.cur.as_mut() {
            cur.last_block = Some(LastBlock::ToolResult);
        }
    }
}

fn field_name(payload: &Obj) -> Option<String> {
    payload
        .get("name")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| payload.get("tool").and_then(Value::as_str).filter(|text| !text.is_empty()))
        .map(str::to_string)
}

fn field_call_id(payload: &Obj) -> Option<String> {
    payload
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| payload.get("id").and_then(Value::as_str).filter(|text| !text.is_empty()))
        .map(str::to_string)
}

fn reasoning_text(payload: &Obj) -> String {
    if let Some(text) = payload.get("text").and_then(Value::as_str)
        && !text.is_empty() {
            return text.to_string();
        }
    let mut parts = Vec::new();
    collect_text(payload.get("summary"), &mut parts);
    collect_text(payload.get("content"), &mut parts);
    parts.join("")
}

fn collect_text(raw: Option<&Value>, parts: &mut Vec<String>) {
    let Some(items) = raw.and_then(Value::as_array) else {
        return;
    };
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        if let Some(text) = obj.get("text").and_then(Value::as_str)
            && !text.is_empty() {
                parts.push(text.to_string());
            }
    }
}
