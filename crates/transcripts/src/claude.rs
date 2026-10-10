use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::text::{
    as_i64, blocks_of, extract_claude_usage, extract_turn_text, field_str, is_bare_slash_command,
    message_obj, objects_from_lines, strip_pasted_content_wrapper, summarize_turn_args, tokens_label,
};
use crate::turn::{LastBlock, Role, Tool, ToolStatus, Turn, cap_thinking, is_prompt_tool_name, prompt_input};
use crate::value::{Obj, finite, jtrim};

pub fn claude_turns_from_lines(lines: &[Obj]) -> Vec<Turn> {
    claude_turns_from_lines_sourced(lines, None, false)
}

pub fn claude_turns_from_lines_sourced(lines: &[Obj], path: Option<&str>, truncated: bool) -> Vec<Turn> {
    let include_sidechain = sidechain_included(lines, path, truncated);
    let mut fold = Fold::default();
    for obj in lines {
        fold.line(obj, include_sidechain);
    }
    fold.finish();
    fold.turns
}

pub fn claude_turns_from_text(lines: &[String]) -> Vec<Turn> {
    claude_turns_from_lines(&objects_from_lines(lines))
}

#[derive(Default)]
struct Fold {
    turns: Vec<Turn>,
    cur: Option<Turn>,
    tools: Vec<Tool>,
    by_id: HashMap<String, usize>,
    output_tokens: i64,
    thinking: String,
    last_line_had_text: bool,
}


impl Fold {
    fn assistant_complete(&self) -> bool {
        let Some(cur) = &self.cur else {
            return false;
        };
        cur.stop_reason.as_deref() == Some("end_turn")
            && self.last_line_had_text
            && !self.tools.iter().any(|tool| tool.status == ToolStatus::Running)
    }

    fn finish(&mut self) {
        if let Some(mut cur) = self.cur.take() {
            if !self.thinking.is_empty() {
                cur.raw_thinking = Some(self.thinking.clone());
                cur.thinking = Some(cap_thinking(&self.thinking));
            }
            if !self.tools.is_empty() {
                cur.tools = Some(std::mem::take(&mut self.tools));
            } else {
                cur.tools = None;
            }
            if let Some(usage) = cur.usage.as_mut() {
                usage.completion_tokens = self.output_tokens;
            }
            if self.assistant_complete_saved(&cur) {
                cur.complete = Some(true);
            }
            if !cur.text.is_empty() || cur.thinking.is_some() || cur.tools.is_some() {
                self.turns.push(cur);
            }
        }
        self.output_tokens = 0;
        self.thinking.clear();
        self.last_line_had_text = false;
        self.tools.clear();
        self.by_id.clear();
    }

    fn assistant_complete_saved(&self, cur: &Turn) -> bool {
        cur.stop_reason.as_deref() == Some("end_turn")
            && self.last_line_had_text
            && !cur.tools.as_ref().is_some_and(|tools| tools.iter().any(|tool| tool.status == ToolStatus::Running))
    }

    fn line(&mut self, obj: &Obj, include_sidechain: bool) {
        if (obj.get("isSidechain") == Some(&Value::Bool(true)) && !include_sidechain)
            || obj.get("isMeta") == Some(&Value::Bool(true))
            || obj.get("isCompactSummary") == Some(&Value::Bool(true))
        {
            return;
        }
        if obj.get("type").and_then(Value::as_str) == Some("system")
            && obj.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
        {
            self.compact(obj);
            return;
        }
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            return;
        }
        let msg = message_obj(obj);
        let content = msg.get("content").cloned().unwrap_or(Value::Null);
        if kind == "user" {
            self.user_line(obj, &content);
            return;
        }
        self.assistant_line(&msg, &content);
    }

    fn compact(&mut self, obj: &Obj) {
        let skip = if self.cur.is_some() {
            !self.assistant_complete()
        } else {
            self.turns.last().is_some_and(|turn| turn.role == Role::User)
        };
        if skip {
            return;
        }
        self.finish();
        self.turns.push(compact_marker(obj.get("compactMetadata")));
    }

    fn user_line(&mut self, obj: &Obj, content: &Value) {
        if let Some(blocks) = content.as_array() {
            for block in blocks.iter().filter_map(Value::as_object) {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                if let Some(cur) = self.cur.as_mut() {
                    cur.last_block = Some(LastBlock::ToolResult);
                }
                let id = block.get("tool_use_id").and_then(Value::as_str);
                let Some(index) = id.and_then(|id| self.by_id.get(id).copied()) else {
                    continue;
                };
                let error = block.get("is_error") == Some(&Value::Bool(true));
                if let Some(entry) = self.tools.get_mut(index) {
                    entry.status = if error { ToolStatus::Error } else { ToolStatus::Done };
                    if is_prompt_tool_name(&entry.name) {
                        let text = prompt_result_text(block, obj.get("toolUseResult"));
                        if !text.is_empty() {
                            entry.result_text = Some(text);
                        }
                    }
                }
            }
        }
        let Some(raw) = extract_turn_text(content, "user") else {
            return;
        };
        let text = strip_pasted_content_wrapper(&raw);
        if text.is_empty() || is_bare_slash_command(&text) {
            return;
        }
        self.finish();
        self.turns.push(Turn::user(text));
    }

    fn assistant_line(&mut self, msg: &Obj, content: &Value) {
        if self.cur.is_none() {
            self.cur = Some(blank_assistant());
        }
        if let Some(reason) = msg.get("stop_reason").and_then(Value::as_str)
            && let Some(cur) = self.cur.as_mut() {
                cur.stop_reason = Some(reason.to_string());
            }
        let blocks = if content.is_array() || content.is_string() { blocks_of(content) } else { Vec::new() };
        let mut line_had_text = false;
        for block in &blocks {
            line_had_text |= self.absorb_block(block);
        }
        self.last_line_had_text = line_had_text;
        let (usage, model) = extract_claude_usage(Some(msg));
        if let Some(usage) = usage {
            self.output_tokens += usage.completion_tokens;
            if let Some(cur) = self.cur.as_mut() {
                cur.usage = Some(usage);
            }
        }
        if let Some(model) = model
            && let Some(cur) = self.cur.as_mut() {
                cur.model = Some(model);
            }
    }

    fn absorb_block(&mut self, block: &Obj) -> bool {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "text" {
            let Some(text) = block.get("text").and_then(Value::as_str) else {
                return false;
            };
            let trimmed = jtrim(text);
            if trimmed.is_empty() {
                return false;
            }
            if let Some(cur) = self.cur.as_mut() {
                if cur.text.is_empty() {
                    cur.text = trimmed.to_string();
                } else {
                    cur.text = format!("{}\n\n{trimmed}", cur.text);
                }
                cur.last_block = Some(LastBlock::Text);
            }
            return true;
        }
        if kind == "thinking" {
            let piece = block
                .get("thinking")
                .and_then(Value::as_str)
                .or_else(|| block.get("text").and_then(Value::as_str));
            if let Some(piece) = piece {
                self.thinking.push_str(piece);
            }
            if let Some(cur) = self.cur.as_mut() {
                cur.last_block = Some(LastBlock::Thinking);
            }
            return false;
        }
        if kind == "tool_use" {
            let Some(name) = field_str(block, "name") else {
                return false;
            };
            let mut entry = Tool {
                name: name.clone(),
                status: ToolStatus::Running,
                args: block.get("input").and_then(summarize_turn_args),
                id: field_str(block, "id"),
                input: None,
                result_text: None,
            };
            if is_prompt_tool_name(&name) {
                entry.input = block.get("input").map(prompt_input);
            }
            if let Some(id) = entry.id.clone() {
                self.by_id.insert(id, self.tools.len());
            }
            self.tools.push(entry);
            if let Some(cur) = self.cur.as_mut() {
                cur.last_block = Some(LastBlock::ToolUse);
            }
        }
        false
    }
}

fn blank_assistant() -> Turn {
    let mut turn = Turn::assistant();
    turn.tools = None;
    turn
}

fn prompt_result_text(block: &Obj, tool_use_result: Option<&Value>) -> String {
    if let Some(text) = block.get("content").and_then(Value::as_str) {
        return crate::turn::cap_result(text);
    }
    if let Some(parts) = block.get("content").and_then(Value::as_array) {
        for part in parts {
            if let Some(text) = part.as_object().and_then(|obj| obj.get("text")).and_then(Value::as_str) {
                return crate::turn::cap_result(text);
            }
        }
    }
    let Some(raw) = tool_use_result else {
        return String::new();
    };
    let text = if let Some(text) = raw.as_str() {
        text.to_string()
    } else {
        protocol::js::stringify(raw)
    };
    crate::turn::cap_result(&text)
}

fn compact_marker(meta: Option<&Value>) -> Turn {
    let meta = meta.and_then(Value::as_object);
    let post = meta.and_then(|obj| obj.get("postTokens")).and_then(finite).filter(|number| *number >= 0.0);
    let pre = meta.and_then(|obj| obj.get("preTokens")).and_then(finite).filter(|number| *number > 0.0);
    let text = match (pre, post) {
        (Some(pre), Some(post)) => {
            format!("Conversation compacted ({} → {})", tokens_label(pre), tokens_label(post))
        }
        _ => "Conversation compacted".to_string(),
    };
    let mut turn = blank_assistant();
    turn.text = text;
    turn.stop_reason = Some("end_turn".into());
    turn.last_block = Some(LastBlock::Text);
    turn.complete = Some(true);
    turn.compact = Some(true);
    if let Some(post) = post {
        turn.usage = Some(crate::turn::Usage {
            prompt_tokens: as_i64(post),
            completion_tokens: 0,
            cached_tokens: 0,
        });
    }
    turn
}

fn sidechain_included(lines: &[Obj], path: Option<&str>, truncated: bool) -> bool {
    if path.is_some_and(is_agent_transcript) {
        return true;
    }
    if truncated {
        return false;
    }
    transcript_is_sidechain(lines)
}

fn is_agent_transcript(path: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?:^|/)agent-[^/]+\.jsonl$").ok());
    re.as_ref().is_some_and(|re| re.is_match(path))
}

fn transcript_is_sidechain(lines: &[Obj]) -> bool {
    let mut saw = false;
    for obj in lines {
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        saw = true;
        if obj.get("isSidechain") != Some(&Value::Bool(true)) {
            return false;
        }
    }
    saw
}

pub fn cowork_turns_from_lines(lines: &[Obj]) -> Vec<Turn> {
    claude_turns_from_lines(lines)
}
