use std::sync::OnceLock;

use protocol::js::js_trim;
use regress::Regex;
use serde_json::Value;

use crate::slug::{PROJECT_RULE_NAME, normalize_tag_key, normalize_tag_value};
use crate::text::{utf16_len, utf16_prefix};

pub const TAG_SEED_KEYS: [&str; 2] = ["project", "topic"];
pub const TAG_MAX_PROPOSALS: usize = 8;
pub const TAG_SUMMARY_MAX_CHARS: usize = 12_000;
pub const TAG_LLM_RETRIES: i64 = 1;
pub const TAG_MAX_TOKENS: i64 = 400;
const VALUE_MAX: usize = 64;

pub const TAG_SYSTEM_PROMPT: &str = "You label engineering conversation summaries with key:value tags.\n\nRules:\n- Output ONLY a JSON array. No prose, no markdown fences.\n- Each element: {\"key\": \"...\", \"value\": \"...\", \"confidence\": 0..1, \"reason\": \"one short clause\"}.\n- Keys: prefer \"project\" (a codebase, product or repo) and \"topic\" (what the work was about). Add another key only when neither fits.\n- Values: 1-4 words, lowercase, specific. \"topic:memory-compaction\" not \"topic:software\".\n- Reuse an existing vocabulary tag whenever it fits. Propose a new value only when nothing existing applies.\n- To flag a tag already on the conversation as wrong, return {\"key\",\"value\",\"action\":\"remove\",\"confidence\",\"reason\"}. Only a tag listed under \"already on this conversation\". A removal is a suggestion: it is not applied until a person accepts it.\n- At most 8 tags, removals included. Fewer is better. Return [] when the summary is noise (heartbeats, empty sessions).\n- Never invent projects or topics that the summary does not mention.";

#[derive(Debug, Clone, PartialEq)]
pub struct TagProposal {
    pub key: String,
    pub value: String,
    pub display: Option<String>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub action: Option<String>,
}

pub struct TaggerInput<'a> {
    pub summary: &'a str,
    pub title: Option<&'a str>,
    pub agent: Option<&'a str>,
    pub accepted: &'a [String],
    pub current_tags: &'a [String],
}

fn key_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::with_flags(r"^[a-z][a-z0-9-]{0,31}$", "").ok())
        .as_ref()
}

fn ws_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::with_flags(r"\s+", "").ok())
        .as_ref()
}

fn is_cc_or_cf(ch: char) -> bool {
    if ch.is_control() {
        return true;
    }
    matches!(
        ch,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    ) || ('\u{E0000}'..='\u{E007F}').contains(&ch)
}

pub fn clean_tag_text(raw: &str, max: usize) -> String {
    let mut spaced = String::new();
    for ch in raw.chars() {
        if is_cc_or_cf(ch) {
            spaced.push(' ');
        } else {
            spaced.push(ch);
        }
    }
    let collapsed = match ws_re() {
        Some(re) => {
            let mut out = String::new();
            let mut last = 0usize;
            for hit in re.find_iter(&spaced) {
                let start = hit.start();
                let end = hit.end();
                if start >= last && spaced.is_char_boundary(start) && spaced.is_char_boundary(end) {
                    out.push_str(&spaced[last..start]);
                    out.push(' ');
                    last = end;
                }
            }
            if spaced.is_char_boundary(last) {
                out.push_str(&spaced[last..]);
            }
            out
        }
        None => spaced,
    };
    let trimmed = js_trim(&collapsed);
    trimmed.chars().take(max).collect()
}

pub fn tag_removal_is_protected(source: &str, decided_by: Option<&str>) -> bool {
    if source == "user" {
        return true;
    }
    let by = js_trim(decided_by.unwrap_or(""));
    !by.is_empty() && by != PROJECT_RULE_NAME
}

pub fn allow_protected_removals(config: Option<bool>, env_value: Option<&str>) -> bool {
    if let Some(value) = config {
        return value;
    }
    let raw = js_trim(env_value.unwrap_or(""));
    matches!(
        raw.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn bound_tag_summary(summary: &str) -> String {
    if utf16_len(summary) <= TAG_SUMMARY_MAX_CHARS {
        summary.to_string()
    } else {
        summary.chars().take(TAG_SUMMARY_MAX_CHARS).collect()
    }
}

pub fn format_tag_prompt(input: &TaggerInput<'_>) -> String {
    let mut lines = Vec::new();
    if let Some(title) = input.title {
        lines.push(format!(
            "Conversation title: {}",
            clean_tag_text(title, 200)
        ));
    }
    if let Some(agent) = input.agent {
        lines.push(format!("Agent: {}", clean_tag_text(agent, 80)));
    }
    let vocab: Vec<&String> = input.accepted.iter().take(80).collect();
    if vocab.is_empty() {
        lines.push("Existing vocabulary: (none yet)".to_string());
    } else {
        let body = vocab
            .iter()
            .map(|v| format!("- {v}"))
            .collect::<Vec<_>>()
            .join("\n");
        lines.push(format!("Existing vocabulary (reuse when it fits):\n{body}"));
    }
    let current: Vec<String> = input
        .current_tags
        .iter()
        .take(40)
        .map(|v| clean_tag_text(v, 200))
        .collect();
    if current.is_empty() {
        lines.push("Tags already on this conversation: (none)".to_string());
    } else {
        let body = current
            .iter()
            .map(|v| format!("- {v}"))
            .collect::<Vec<_>>()
            .join("\n");
        lines.push(format!(
            "Tags already on this conversation (suggest action \"remove\" only for one of these, and only when the summary shows it is wrong):\n{body}"
        ));
    }
    lines.push(format!("Summary:\n{}", bound_tag_summary(input.summary)));
    lines.push("Tags (JSON array only):".to_string());
    lines.join("\n\n")
}

pub fn parse_tag_proposals(raw: &str) -> (Vec<TagProposal>, Vec<String>) {
    let mut rejected = Vec::new();
    let mut text = js_trim(raw).to_string();
    if let Some(inner) = unwrap_fence(&text) {
        text = js_trim(&inner).to_string();
    }
    let start = ['[', '{'].into_iter().filter_map(|ch| text.find(ch)).min();
    let Some(start) = start else {
        return (Vec::new(), vec!["no JSON found".to_string()]);
    };
    text = text[start..].to_string();
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(_) => {
            let end_bracket = text.rfind(']').unwrap_or(0);
            let end_brace = text.rfind('}').unwrap_or(0);
            let end = end_bracket.max(end_brace);
            if end == 0 && !text.starts_with(']') && !text.starts_with('}') {
                return (Vec::new(), vec!["invalid JSON".to_string()]);
            }
            match serde_json::from_str::<Value>(&text[..=end]) {
                Ok(value) => value,
                Err(_) => return (Vec::new(), vec!["invalid JSON".to_string()]),
            }
        }
    };
    let mut parsed = parsed;
    if let Some(tags) = parsed
        .as_object()
        .and_then(|obj| obj.get("tags").cloned())
        .filter(|tags| tags.is_array())
    {
        parsed = tags;
    }
    let Some(items) = parsed.as_array().cloned() else {
        return (Vec::new(), vec!["not an array".to_string()]);
    };
    let mut seen = std::collections::HashSet::new();
    let mut proposals = Vec::new();
    for item in items {
        let Some(obj) = item.as_object() else {
            rejected.push("element is not an object".to_string());
            continue;
        };
        let mut key = None;
        let mut value_raw = None;
        if let (Some(k), Some(v)) = (
            obj.get("key").and_then(Value::as_str),
            obj.get("value").and_then(Value::as_str),
        ) {
            key = Some(normalize_tag_key(k));
            value_raw = Some(v.to_string());
        } else if let Some(tag) = obj.get("tag").and_then(Value::as_str)
            && let Some((k, v)) = tag.split_once(':')
        {
            key = Some(normalize_tag_key(k));
            value_raw = Some(v.to_string());
        }
        let (Some(key), Some(value_raw)) = (key, value_raw) else {
            let rendered = serde_json::to_string(&item).unwrap_or_else(|_| "null".to_string());
            let clip = utf16_prefix(&rendered, 80);
            rejected.push(format!("missing key/value: {clip}"));
            continue;
        };
        if key.is_empty() || key_re().is_none_or(|re| re.find(&key).is_none()) {
            rejected.push(format!("bad key \"{key}\""));
            continue;
        }
        let normalized = normalize_tag_value(&value_raw);
        let mut value: String = normalized.chars().take(VALUE_MAX).collect();
        while value.ends_with('-') {
            value.pop();
        }
        if value.is_empty() {
            rejected.push(format!("empty value for key \"{key}\""));
            continue;
        }
        let literal = format!("{key}:{value}");
        let action = match obj.get("action") {
            None => None,
            Some(Value::String(text)) if text == "add" => None,
            Some(Value::String(text)) if text == "remove" => Some("remove".to_string()),
            _ => {
                rejected.push(format!("bad action for \"{literal}\""));
                continue;
            }
        };
        let seen_key = format!("{}:{literal}", action.as_deref().unwrap_or("add"));
        if !seen.insert(seen_key) {
            continue;
        }
        let confidence = obj
            .get("confidence")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map(|n| n.clamp(0.0, 1.0));
        let reason = obj
            .get("reason")
            .and_then(Value::as_str)
            .map(|text| clean_tag_text(text, 200))
            .filter(|text| !text.is_empty());
        let display = clean_tag_text(&value_raw, VALUE_MAX);
        let display = (display != value && !display.is_empty()).then_some(display);
        proposals.push(TagProposal {
            key,
            value,
            display,
            confidence,
            reason,
            action,
        });
        if proposals.len() >= TAG_MAX_PROPOSALS {
            break;
        }
    }
    let _ = utf16_len;
    (proposals, rejected)
}

fn unwrap_fence(text: &str) -> Option<String> {
    let trimmed = js_trim(text);
    let rest = trimmed.strip_prefix("```")?;
    let rest = rest.strip_prefix("json").unwrap_or(rest);
    let rest = rest.trim_start_matches([' ', '\t', '\r', '\n']);
    let end = rest.rfind("```")?;
    Some(rest[..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_names_the_cap_and_removal_rule() {
        assert!(TAG_SYSTEM_PROMPT.contains("At most 8 tags"));
        assert!(TAG_SYSTEM_PROMPT.contains("action\":\"remove\""));
        assert_eq!(TAG_MAX_PROPOSALS, 8);
        assert_eq!(TAG_SEED_KEYS, ["project", "topic"]);
    }

    #[test]
    fn protects_user_and_human_decisions() {
        assert!(tag_removal_is_protected("user", None));
        assert!(tag_removal_is_protected("model", Some("alice")));
        assert!(!tag_removal_is_protected("rule", Some(PROJECT_RULE_NAME)));
        assert!(!tag_removal_is_protected("model", Some("  ")));
        assert!(allow_protected_removals(Some(true), Some("no")));
        assert!(!allow_protected_removals(Some(false), Some("1")));
        assert!(allow_protected_removals(None, Some("YES")));
        assert!(!allow_protected_removals(None, Some("nope")));
    }

    #[test]
    fn parses_fenced_and_wrapped_proposals() {
        let raw = "```json\n[{\"key\":\"Topic\",\"value\":\"Memory Compaction\",\"confidence\":1.4,\"reason\":\"yes\",\"action\":\"add\"}]\n```";
        let (proposals, rejected) = parse_tag_proposals(raw);
        assert!(rejected.is_empty());
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].key, "topic");
        assert_eq!(proposals[0].confidence, Some(1.0));
        assert!(proposals[0].action.is_none());
        let wrapped = r#"noise {"tags":[{"tag":"project:rivetos","action":"remove"}]} trailing"#;
        let (proposals, rejected) = parse_tag_proposals(wrapped);
        assert!(rejected.is_empty(), "{rejected:?}");
        assert_eq!(proposals[0].action.as_deref(), Some("remove"));
        assert_eq!(proposals[0].key, "project");
        let (empty, rejected) = parse_tag_proposals("no json here");
        assert!(empty.is_empty());
        assert_eq!(rejected, vec!["no JSON found".to_string()]);
        let (empty, rejected) = parse_tag_proposals("[1]");
        assert!(empty.is_empty());
        assert_eq!(rejected, vec!["element is not an object".to_string()]);
        let (empty, rejected) = parse_tag_proposals(r#"[{"key":"1bad","value":"x"}]"#);
        assert!(empty.is_empty());
        assert!(rejected[0].starts_with("bad key"));
        let (empty, rejected) =
            parse_tag_proposals(r#"[{"key":"topic","value":"---","action":"nope"}]"#);
        assert!(empty.is_empty());
        assert!(rejected[0].contains("empty value") || rejected[0].contains("bad action"));
    }
}
