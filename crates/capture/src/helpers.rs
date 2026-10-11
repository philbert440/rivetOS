use std::path::Path;

use protocol::js::{JsString, is_js_whitespace, js_trim_start};
use serde_json::Value;

pub const CONTENT_LIMIT: usize = 16_000;

pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

pub fn as_string(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.as_str()),
        _ => None,
    }
}

pub fn safe_json(value: &Value) -> String {
    protocol::js::stringify(&protocol::js::from_serde(value))
}

pub struct CappedText {
    pub text: JsString,
    pub truncated: bool,
    pub full_length: usize,
}

pub fn cap_for_storage(text: &str, limit: Option<usize>) -> CappedText {
    let limit = limit.unwrap_or(CONTENT_LIMIT);
    let full_length = protocol::js::utf16_len(text);
    let sliced = protocol::js::js_slice(text, Some(0.0), Some(limit as f64));
    CappedText {
        text: sliced,
        truncated: full_length > limit,
        full_length,
    }
}

pub fn cap_field(text: &str) -> CappedText {
    cap_for_storage(text, Some(CONTENT_LIMIT))
}

pub fn load_env_file(path: impl AsRef<Path>) -> std::collections::BTreeMap<String, String> {
    let mut values = std::collections::BTreeMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return values;
    };
    for line in raw.split('\n') {
        let Some((key, raw_value)) = parse_env_line(line) else {
            continue;
        };
        if key.is_empty()
            || values
                .get(key)
                .is_some_and(|value: &String| !value.is_empty())
        {
            continue;
        }
        values.insert(key.to_string(), strip_one_quote(raw_value));
    }
    values
}

fn parse_env_line(line: &str) -> Option<(&str, &str)> {
    let rest = js_trim_start(line);
    let key_end = rest
        .char_indices()
        .find(|(_, ch)| !is_env_key(*ch))
        .map(|(index, _)| index)
        .unwrap_or(rest.len());
    if key_end == 0 {
        return None;
    }
    let key = &rest[..key_end];
    let rest = js_trim_start(&rest[key_end..]);
    let rest = rest.strip_prefix('=')?;
    let value = capture_env_value(rest)?;
    Some((key, value))
}

fn capture_env_value(raw: &str) -> Option<&str> {
    let value = js_trim_start(raw);
    let end = value
        .char_indices()
        .find(|(_, ch)| is_js_line_terminator(*ch))
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    if value[end..].chars().all(is_js_whitespace) {
        Some(&value[..end])
    } else {
        None
    }
}

fn is_js_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn is_env_key(ch: char) -> bool {
    ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_'
}

fn strip_one_quote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return String::new();
    }
    let mut start = 0;
    let mut end = bytes.len();
    if bytes[start] == b'"' || bytes[start] == b'\'' {
        start += 1;
    }
    if end > start && (bytes[end - 1] == b'"' || bytes[end - 1] == b'\'') {
        end -= 1;
    }
    value[start..end].to_string()
}

pub fn json_utf8_len(value: &impl serde::Serialize) -> usize {
    match serde_json::to_value(value) {
        Ok(parsed) => protocol::js::stringify(&protocol::js::from_serde(&parsed)).len(),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod env_line {
    use super::{parse_env_line, strip_one_quote};

    fn from_regex(line: &str) -> Option<(String, String)> {
        let regex = regress::Regex::new(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$").unwrap();
        let found = regex.find(line)?;
        let key = found.group(1).unwrap();
        let value = found.group(2).unwrap();
        Some((line[key].to_string(), strip_one_quote(&line[value])))
    }

    fn from_parser(line: &str) -> Option<(String, String)> {
        parse_env_line(line).map(|(key, value)| (key.to_string(), strip_one_quote(value)))
    }

    #[test]
    fn env_lines_match_the_javascript_pattern() {
        let lines = [
            "\u{FEFF}RIVETOS_PG_URL=postgres://localhost/rivet",
            "\u{00A0}TOKEN=\"secret\"",
            "\u{0085}SKIP=no",
            "# comment",
            "A=\"one\"",
            "B='two'",
            "A=ignored",
            "lower=no",
            "export C=no",
            "EMPTY=",
            "A=\"one\"  ",
            "  B = 'two'",
            "KEY=value\r",
            "KEY=value  \r",
            "KEY=\u{FEFF}value",
            "KEY=value\u{FEFF}",
            "KEY=foo\rbar",
            "KEY=foo\u{2028}",
            "KEY=\u{00A0}value\u{00A0}",
            " =NO",
            "A='",
            "A=\"",
            "A=\"one'",
            "",
            "\u{FEFF}",
            "KEY==value",
            "\u{FEFF}\u{00A0}A=\"one\"\r",
        ];
        for line in lines {
            assert_eq!(from_parser(line), from_regex(line), "{line:?}");
        }
    }
}
