use std::collections::HashMap;

use serde_json::Value;

use crate::text::{extract_turn_text, field_str, finite_num, objects_from_lines, summarize_turn_args};
use crate::text::as_i64;
use crate::turn::{LastBlock, Role, Tool, ToolStatus, Turn, Usage, cap_thinking, thinking_for_delta};
use crate::value::Obj;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KimiLiveDelta {
    pub kind: &'static str,
    pub text: String,
}

pub fn kimi_turns_from_lines(lines: &[Obj]) -> Vec<Turn> {
    let mut fold = Fold::default();
    for obj in lines {
        fold.line(obj);
    }
    fold.finish();
    fold.turns
}

pub fn kimi_turns_from_text(lines: &[String]) -> Vec<Turn> {
    kimi_turns_from_lines(&objects_from_lines(lines))
}

pub fn kimi_deltas_from_turns(prev: Option<&[Turn]>, next: &[Turn]) -> Vec<KimiLiveDelta> {
    let Some(prev) = prev else {
        return Vec::new();
    };
    if prev.is_empty() || next.len() < prev.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (index, last) in next.iter().enumerate() {
        if last.role != Role::Assistant {
            continue;
        }
        let prior = prev.get(index).filter(|turn| turn.role == Role::Assistant);
        let prior_text = prior.map(|turn| turn.text.as_str()).unwrap_or("");
        let prior_thinking = prior.map(thinking_for_delta_one).unwrap_or_default();
        let reasoning = grown_suffix(&prior_thinking, &thinking_for_delta_one(last));
        let text = grown_suffix(prior_text, &last.text);
        if !reasoning.is_empty() {
            out.push(KimiLiveDelta { kind: "reasoning", text: reasoning });
        }
        if !text.is_empty() {
            out.push(KimiLiveDelta { kind: "assistant", text });
        }
    }
    out
}

fn thinking_for_delta_one(turn: &Turn) -> String {
    thinking_for_delta(Some(turn))
}

fn grown_suffix(prev: &str, next: &str) -> String {
    if next.is_empty() || next == prev {
        return String::new();
    }
    if prev.is_empty() {
        return next.to_string();
    }
    if let Some(rest) = next.strip_prefix(prev) {
        return rest.to_string();
    }
    next.to_string()
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
    model: String,
    had_text: bool,
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
            model: String::new(),
            had_text: false,
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

    fn finish(&mut self) {
        let Some(mut cur) = self.cur.take() else {
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
        if !self.model.is_empty() {
            cur.model = Some(self.model.clone());
        }
        let running = cur
            .tools
            .as_ref()
            .is_some_and(|tools| tools.iter().any(|tool| tool.status == ToolStatus::Running));
        if cur.stop_reason.as_deref() == Some("end_turn") && self.had_text && !running {
            cur.complete = Some(true);
        }
        if !cur.text.is_empty() || cur.thinking.is_some() || cur.tools.is_some() {
            self.turns.push(cur);
        }
        self.had_text = false;
        self.thinking.clear();
        self.prompt = 0.0;
        self.completion = 0.0;
        self.cached = 0.0;
        self.tools.clear();
        self.by_id.clear();
    }

    fn line(&mut self, obj: &Obj) {
        if obj.get("type").and_then(Value::as_str) == Some("llm.request")
            && let Some(model) = field_str(obj, "model") {
                self.model = model;
            }
        if obj.get("type").and_then(Value::as_str) == Some("context.append_message") {
            self.message(obj);
            return;
        }
        if obj.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
            return;
        }
        let Some(event) = obj.get("event").and_then(Value::as_object) else {
            return;
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "content.part" => self.part(event),
            "tool.call" => self.tool_call(event),
            "tool.result" => self.tool_result(event),
            "step.end" => self.step_end(event),
            _ => {}
        }
    }

    fn message(&mut self, obj: &Obj) {
        let Some(msg) = obj.get("message").and_then(Value::as_object) else {
            return;
        };
        if msg.get("role").and_then(Value::as_str) != Some("user") {
            return;
        }
        let origin = msg.get("origin").and_then(Value::as_object);
        if origin.and_then(|item| item.get("kind")).and_then(Value::as_str) != Some("user") {
            return;
        }
        let Some(text) = extract_turn_text(msg.get("content").unwrap_or(&Value::Null), "user") else {
            return;
        };
        self.finish();
        self.turns.push(Turn::user(text));
    }

    fn part(&mut self, event: &Obj) {
        let Some(part) = event.get("part").and_then(Value::as_object) else {
            return;
        };
        self.ensure();
        if part.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                let trimmed = crate::value::jtrim(text);
                if !trimmed.is_empty() {
                    if let Some(cur) = self.cur.as_mut() {
                        if cur.text.is_empty() {
                            cur.text = trimmed.to_string();
                        } else {
                            cur.text = format!("{}\n\n{trimmed}", cur.text);
                        }
                        cur.last_block = Some(LastBlock::Text);
                    }
                    self.had_text = true;
                }
            }
        } else if part.get("type").and_then(Value::as_str) == Some("think") {
            if let Some(think) = part.get("think").and_then(Value::as_str) {
                self.thinking.push_str(think);
            }
            if let Some(cur) = self.cur.as_mut() {
                cur.last_block = Some(LastBlock::Thinking);
            }
        }
    }

    fn tool_call(&mut self, event: &Obj) {
        let Some(name) = field_str(event, "name") else {
            return;
        };
        self.ensure();
        let entry = Tool {
            name,
            status: ToolStatus::Running,
            args: event.get("args").and_then(summarize_turn_args),
            id: field_str(event, "toolCallId"),
            input: None,
            result_text: None,
        };
        if let Some(id) = entry.id.clone() {
            self.by_id.insert(id, self.tools.len());
        }
        self.tools.push(entry);
        if let Some(cur) = self.cur.as_mut() {
            cur.last_block = Some(LastBlock::ToolUse);
        }
    }

    fn tool_result(&mut self, event: &Obj) {
        let Some(index) = field_str(event, "toolCallId").and_then(|id| self.by_id.get(&id).copied()) else {
            return;
        };
        let error = event
            .get("result")
            .and_then(Value::as_object)
            .and_then(|result| result.get("isError"))
            == Some(&Value::Bool(true));
        if let Some(entry) = self.tools.get_mut(index) {
            entry.status = if error { ToolStatus::Error } else { ToolStatus::Done };
        }
        if let Some(cur) = self.cur.as_mut() {
            cur.last_block = Some(LastBlock::ToolResult);
        }
    }

    fn step_end(&mut self, event: &Obj) {
        if let Some(cur) = self.cur.as_mut() {
            let running = self.tools.iter().any(|tool| tool.status == ToolStatus::Running);
            cur.stop_reason = Some(if running { "tool_use" } else { "end_turn" }.into());
        }
        let Some(usage) = event.get("usage").and_then(Value::as_object) else {
            return;
        };
        let read = finite_num(usage.get("inputCacheRead"));
        self.prompt += finite_num(usage.get("inputOther")) + read + finite_num(usage.get("inputCacheCreation"));
        self.completion += finite_num(usage.get("output"));
        self.cached += read;
    }
}

