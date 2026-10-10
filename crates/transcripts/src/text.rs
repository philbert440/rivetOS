use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::turn::Usage;
use crate::value::{Obj, finite, js_len, js_slice, jtrim};

pub fn objects_from_lines(lines: &[String]) -> Vec<Obj> {
    let mut out = Vec::new();
    for line in lines {
        if let Some(obj) = object_from_line(line) {
            out.push(obj);
        }
    }
    out
}

pub fn objects_from_text(text: &str) -> Vec<Obj> {
    text.split('\n').filter_map(object_from_line).collect()
}

pub fn object_from_line(line: &str) -> Option<Obj> {
    let trimmed = jtrim(line);
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok().and_then(|value| value.as_object().cloned())
}

pub fn summarize_turn_args(raw: &Value) -> Option<Obj> {
    let obj = raw.as_object()?;
    let mut out = Obj::new();
    let mut keys = 0usize;
    for (key, value) in obj {
        if keys >= 12 {
            break;
        }
        if let Some(text) = value.as_str() {
            let stored = if js_len(text) > 200 {
                format!("{}…", js_slice(text, 0, Some(200)))
            } else {
                text.to_string()
            };
            out.insert(key.clone(), Value::String(stored));
        } else if value.is_number() || value.is_boolean() {
            out.insert(key.clone(), value.clone());
        } else {
            continue;
        }
        keys += 1;
    }
    if keys > 0 { Some(out) } else { None }
}

pub fn extract_claude_usage(msg: Option<&Obj>) -> (Option<Usage>, Option<String>) {
    let Some(msg) = msg else {
        return (None, None);
    };
    let model = msg
        .get("model")
        .and_then(Value::as_str)
        .map(jtrim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    let Some(usage) = msg.get("usage").and_then(Value::as_object) else {
        return (None, model);
    };
    let input = num_field(usage, "input_tokens");
    let cache_read = num_field(usage, "cache_read_input_tokens");
    let cache_create = num_field(usage, "cache_creation_input_tokens");
    let output = num_field(usage, "output_tokens");
    let prompt = input + cache_read + cache_create;
    if prompt <= 0.0 && output <= 0.0 {
        return (None, model);
    }
    let prompt_tokens = if prompt > 0.0 { prompt } else { input };
    (
        Some(Usage {
            prompt_tokens: as_i64(prompt_tokens),
            completion_tokens: as_i64(output),
            cached_tokens: as_i64(cache_read),
        }),
        model,
    )
}

fn num_field(obj: &Obj, key: &str) -> f64 {
    obj.get(key).and_then(finite).unwrap_or(0.0)
}

pub fn as_i64(number: f64) -> i64 {
    if number.is_finite() { number.trunc() as i64 } else { 0 }
}

pub fn extract_turn_text(content: &Value, role: &str) -> Option<String> {
    let mut text = if let Some(raw) = content.as_str() {
        raw.to_string()
    } else if let Some(blocks) = content.as_array() {
        blocks
            .iter()
            .filter_map(|block| {
                let obj = block.as_object()?;
                if obj.get("type").and_then(Value::as_str) != Some("text") {
                    return None;
                }
                let text = obj.get("text").and_then(Value::as_str)?;
                if text.is_empty() { None } else { Some(text.to_string()) }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };
    text = jtrim(&text).to_string();
    if text.is_empty() {
        return None;
    }
    if role == "user" && is_user_wrapper(&text) {
        return None;
    }
    if role == "user" && text.starts_with("<user_query>") {
        let rest = &text["<user_query>".len()..];
        let inner = match rest.find("</user_query>") {
            Some(end) => &rest[..end],
            None => rest,
        };
        text = jtrim(inner).to_string();
        if text.is_empty() {
            return None;
        }
    }
    if role == "assistant" {
        text = split_hermes_reasoning(&text).text;
        if text.is_empty() {
            return None;
        }
    }
    Some(text)
}

fn is_user_wrapper(text: &str) -> bool {
    text.starts_with("<command-")
        || text.starts_with("<local-command")
        || text.starts_with("<system-reminder")
        || text.starts_with("<task-notification")
        || text.starts_with("<user_info")
        || text.starts_with("<environment_context>")
        || text.starts_with("<skills_instructions>")
        || text.starts_with("<multi_agent_")
        || text.starts_with("Caveat:")
}

pub fn is_codex_wrapper(text: &str) -> bool {
    text.starts_with("<environment_context>")
        || text.starts_with("<skills_instructions>")
        || text.starts_with("<multi_agent_")
}

pub struct HermesSplit {
    pub reasoning: String,
    pub text: String,
}

pub fn split_hermes_reasoning(input: &str) -> HermesSplit {
    if input.is_empty() {
        return HermesSplit { reasoning: String::new(), text: String::new() };
    }
    let lines: Vec<&str> = split_lines(input);
    let mut reasoning: Vec<String> = Vec::new();
    let mut text: Vec<String> = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let visible = strip_ansi(lines[index]);
        if !header_matches(&visible) {
            text.push(lines[index].to_string());
            index += 1;
            continue;
        }
        let header_idx = index;
        index += 1;
        let mut saw_box = false;
        let mut has_terminator = false;
        let mut box_lines: Vec<String> = Vec::new();
        while index < lines.len() {
            let visible = strip_ansi(lines[index]);
            if footer_matches(&visible) {
                has_terminator = true;
                index += 1;
                break;
            }
            if body_matches(&visible) {
                saw_box = true;
                box_lines.push(strip_body(&visible));
                index += 1;
                continue;
            }
            if saw_box {
                box_lines.push(visible);
                index += 1;
                continue;
            }
            if jtrim(&visible).is_empty() {
                has_terminator = true;
                index += 1;
                break;
            }
            box_lines.push(visible);
            index += 1;
        }
        if !saw_box && !has_terminator {
            text.push(lines[header_idx].to_string());
            text.extend(box_lines);
        } else {
            reasoning.extend(box_lines);
        }
    }
    HermesSplit {
        reasoning: jtrim(&reasoning.join("\n")).to_string(),
        text: jtrim(&text.join("\n")).to_string(),
    }
}

fn split_lines(input: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = input;
    while let Some(pos) = rest.find('\n') {
        let (line, tail) = rest.split_at(pos);
        let line = line.strip_suffix('\r').unwrap_or(line);
        out.push(line);
        rest = &tail[1..];
    }
    out.push(rest.strip_suffix('\r').unwrap_or(rest));
    out
}

pub fn strip_ansi(text: &str) -> String {
    let Some(csi) = csi_re() else {
        return text.to_string();
    };
    let stripped = csi.replace_all(text, "");
    match osc_re() {
        Some(osc) => osc.replace_all(&stripped, "").into_owned(),
        None => stripped.into_owned(),
    }
}

fn csi_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new("\u{001b}\\[[0-9;?]*[ -/]*[@-~]").ok()).as_ref()
}

fn osc_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new("\u{001b}\\][^\u{0007}\u{001b}]*(?:\u{0007}|\u{001b}\\\\)").ok())
        .as_ref()
}

fn header_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^[\s]*[┌╭][─━\s]*\b(Reasoning|Thought|Thinking)\b").ok()
    })
    .as_ref()
}

fn footer_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\s]*[└╰][─━\s]+[┘╯][\s]*$").ok()).as_ref()
}

fn body_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\s]*[│┃├┤]").ok()).as_ref()
}

fn body_strip_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\s]*[│┃├┤]\s?").ok()).as_ref()
}

fn header_matches(text: &str) -> bool {
    header_re().is_some_and(|re| re.is_match(text))
}

fn footer_matches(text: &str) -> bool {
    footer_re().is_some_and(|re| re.is_match(text))
}

fn body_matches(text: &str) -> bool {
    body_re().is_some_and(|re| re.is_match(text))
}

fn strip_body(text: &str) -> String {
    match body_strip_re() {
        Some(re) => re.replace(text, "").into_owned(),
        None => text.to_string(),
    }
}

pub fn is_bare_slash_command(text: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^/[A-Za-z][A-Za-z0-9_:-]*(?:[ \t][^\n]*)?$").ok());
    re.as_ref().is_some_and(|re| re.is_match(text))
}

pub fn strip_pasted_content_wrapper(text: &str) -> String {
    if !text.contains("pasted_content") {
        return text.to_string();
    }
    let stripped = unwrap_pasted_blocks(text);
    if stripped == text { text.to_string() } else { jtrim(&stripped).to_string() }
}

fn pasted_close(body: &str, id: &str) -> Option<(usize, usize)> {
    let needle = "</pasted_content";
    let id_form = format!(" id=\"{id}\">");
    let mut offset = 0;
    while let Some(at) = body[offset..].find(needle) {
        let abs = offset + at;
        let after = &body[abs + needle.len()..];
        if after.starts_with(&id_form) {
            return Some((abs, needle.len() + id_form.len()));
        }
        if after.starts_with('>') {
            return Some((abs, needle.len() + 1));
        }
        offset = abs + needle.len();
    }
    None
}

fn unwrap_pasted_blocks(text: &str) -> String {
    let open = "<pasted_content id=\"";
    let mut out = String::new();
    let mut rest = text;
    let mut changed = false;
    while let Some(start) = rest.find(open) {
        let after = &rest[start + open.len()..];
        let Some(id_end) = after.find('"') else {
            break;
        };
        let id = &after[..id_end];
        let after_id = &after[id_end + 1..];
        if !after_id.starts_with('>') {
            out.push_str(&rest[..start + open.len()]);
            rest = &rest[start + open.len()..];
            continue;
        }
        let mut body = &after_id[1..];
        if let Some(stripped) = body.strip_prefix('\n') {
            body = stripped;
        }
        let Some((at, close_len)) = pasted_close(body, id) else {
            out.push_str(&rest[..start + open.len()]);
            rest = &rest[start + open.len()..];
            continue;
        };
        let mut inner = &body[..at];
        if inner.ends_with('\n') {
            inner = &inner[..inner.len() - 1];
        }
        out.push_str(&rest[..start]);
        out.push_str(inner);
        rest = &body[at + close_len..];
        changed = true;
    }
    if !changed {
        return text.to_string();
    }
    out.push_str(rest);
    out
}

pub fn content_text(content: &Value, want: &str) -> Option<String> {
    let mut text = if let Some(raw) = content.as_str() {
        raw.to_string()
    } else if let Some(blocks) = content.as_array() {
        blocks
            .iter()
            .filter_map(|block| {
                let obj = block.as_object()?;
                let piece = obj.get("text").and_then(Value::as_str)?;
                let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
                if kind != want && kind != "text" {
                    return None;
                }
                if piece.is_empty() { None } else { Some(piece.to_string()) }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };
    text = jtrim(&text).to_string();
    if text.is_empty() || is_codex_wrapper(&text) { None } else { Some(text) }
}

pub fn parse_json_value(raw: &Value) -> Value {
    let Some(text) = raw.as_str() else {
        return raw.clone();
    };
    serde_json::from_str(text).unwrap_or_else(|_| raw.clone())
}

pub fn tokens_label(number: f64) -> String {
    if number >= 1_000_000.0 {
        format!("{:.1}M tokens", number / 1_000_000.0)
    } else if number >= 1000.0 {
        format!("{}k tokens", (number / 1000.0).round() as i64)
    } else if number.fract() == 0.0 {
        format!("{} tokens", number as i64)
    } else {
        format!("{number} tokens")
    }
}

pub fn blocks_of(content: &Value) -> Vec<Obj> {
    if let Some(text) = content.as_str() {
        if text.is_empty() {
            return Vec::new();
        }
        let mut obj = Obj::new();
        obj.insert("type".into(), Value::String("text".into()));
        obj.insert("text".into(), Value::String(text.to_string()));
        return vec![obj];
    }
    content
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_object().cloned()).collect())
        .unwrap_or_default()
}

pub fn message_obj(obj: &Obj) -> Obj {
    obj.get("message").and_then(Value::as_object).cloned().unwrap_or_default()
}

pub fn field_str(obj: &Obj, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string)
}

pub fn pick_nonempty(obj: &Obj, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| field_str(obj, key))
}

pub fn finite_num(value: Option<&Value>) -> f64 {
    value.and_then(finite).unwrap_or(0.0)
}

pub fn truthy_error(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) if text.is_empty() => false,
        Some(_) => true,
    }
}

