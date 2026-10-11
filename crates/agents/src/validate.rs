use std::path::Path;

use protocol::HARNESS_IDS;
use protocol::js::{js_slice, js_trim, posix_join, posix_normalize, utf16_len};
use serde_json::{Number, Value};

pub const SLUG_MAX: usize = 48;
pub const DIRECTORY_INSIDE_SHARED: &str = "directory is inside the shared directory; the rivet-shared link would point at an ancestor and loop recursive tools";

pub fn is_harness_id(value: &str) -> bool {
    HARNESS_IDS.contains(&value)
}

pub fn is_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.first() != Some(&b'#') {
        return false;
    }
    let hex = &bytes[1..];
    if hex.len() != 3 && hex.len() != 6 {
        return false;
    }
    hex.iter().all(|byte| byte.is_ascii_hexdigit())
}

pub fn is_effort(value: &str) -> bool {
    let count = value.chars().count();
    if count > 64 {
        return false;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '[' | ']' | ':' | '-'))
}

pub fn parse_effort(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let effort = js_trim(text);
    if !is_effort(effort) {
        return None;
    }
    Some(effort.to_string())
}

pub fn parse_color(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let color = js_trim(text);
    if color.is_empty() {
        return Some(String::new());
    }
    if !is_color(color) {
        return None;
    }
    Some(color.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedHarness {
    Absent,
    Bad,
    Id(&'static str),
}

pub fn parse_harness_id(value: Option<&Value>) -> ParsedHarness {
    match value {
        None => ParsedHarness::Absent,
        Some(Value::Null) => ParsedHarness::Absent,
        Some(Value::String(text)) => match HARNESS_IDS.iter().copied().find(|item| *item == text) {
            Some(id) => ParsedHarness::Id(id),
            None => ParsedHarness::Bad,
        },
        Some(_) => ParsedHarness::Bad,
    }
}

pub fn is_record(value: &Value) -> bool {
    value.as_object().is_some()
}

pub fn json_is_integer(number: &Number) -> bool {
    if number.is_i64() || number.is_u64() {
        return true;
    }
    number
        .as_f64()
        .is_some_and(|value| value.is_finite() && value.fract() == 0.0)
}

pub fn json_is_integer_value(value: &Value) -> bool {
    value.as_number().is_some_and(json_is_integer)
}

pub fn is_agent_preset(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    if let Some(harness) = map.get("harnessId") {
        match harness.as_str() {
            Some(text) if is_harness_id(text) => {}
            _ => return false,
        }
    }
    if let Some(sort_order) = map.get("sortOrder")
        && !json_is_integer_value(sort_order)
    {
        return false;
    }
    let Some(id) = map.get("id").and_then(Value::as_str) else {
        return false;
    };
    if id.is_empty() {
        return false;
    }
    map.get("name").and_then(Value::as_str).is_some()
        && map.get("color").and_then(Value::as_str).is_some()
        && map.get("model").and_then(Value::as_str).is_some()
        && map
            .get("effort")
            .and_then(Value::as_str)
            .is_some_and(is_effort)
        && map.get("systemPrompt").and_then(Value::as_str).is_some()
        && map.get("nodeBaseUrl").and_then(Value::as_str).is_some()
        && map.get("createdAt").and_then(Value::as_f64).is_some()
        && map.get("updatedAt").and_then(Value::as_f64).is_some()
}

pub fn cap_text(text: &str, max_units: usize) -> protocol::js::JsString {
    js_slice(text, Some(0.0), Some(max_units as f64))
}

pub fn slugify(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut slug = String::new();
    let mut pending_dash = false;
    let mut started = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && started {
                slug.push('-');
            }
            pending_dash = false;
            started = true;
            slug.push(ch);
        } else {
            pending_dash = true;
        }
    }
    let sliced = js_slice(&slug, Some(0.0), Some(SLUG_MAX as f64));
    let trimmed = sliced.to_utf8().trim_matches('-');
    if trimmed.is_empty() {
        "agent".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn without_trailing_sep(path: &str) -> String {
    if path.len() > 1 && path.ends_with('/') {
        path.trim_end_matches('/').to_string()
    } else {
        path.to_string()
    }
}

pub(crate) fn resolve_fs(path: &str) -> String {
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir.to_string_lossy().into_owned(),
        Err(_) => "/".to_string(),
    };
    protocol::js::posix_resolve(&cwd, &[path])
}

pub fn default_directory_for(root: &str, name: &str) -> String {
    posix_join(&[root, &slugify(name)])
}

pub fn validate_directory_str(raw: Option<&str>) -> Option<String> {
    let text = raw?;
    if text.contains('\0') {
        return None;
    }
    let trimmed = js_trim(text);
    if trimmed.is_empty() || !trimmed.starts_with('/') {
        return None;
    }
    let normalized = without_trailing_sep(&posix_normalize(trimmed));
    if normalized.is_empty() || normalized.contains('\0') {
        return None;
    }
    if normalized == "/" {
        return None;
    }
    if normalized.split('/').any(|segment| segment == "..") {
        return None;
    }
    if utf16_len(&normalized) > crate::error::DIRECTORY_MAX_UNITS {
        return None;
    }
    Some(normalized)
}

pub fn validate_directory(raw: &Value) -> Option<String> {
    match raw {
        Value::String(text) => validate_directory_str(Some(text)),
        _ => None,
    }
}

pub fn canonical_path(path: &str) -> String {
    let normalized = without_trailing_sep(&posix_normalize(path));
    if normalized.is_empty() {
        return normalized;
    }
    let std_path = Path::new(&normalized);
    if std::fs::metadata(std_path).is_err() {
        return normalized;
    }
    match std::fs::canonicalize(std_path) {
        Ok(real) => without_trailing_sep(&real.to_string_lossy()),
        Err(_) => normalized,
    }
}

pub fn directory_warnings(directory: &str, shared_dir: Option<&str>) -> Vec<String> {
    let Some(shared) = shared_dir.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let dir = canonical_path(directory);
    let root = canonical_path(shared);
    if dir.is_empty() || root.is_empty() {
        return Vec::new();
    }
    let inside = dir == root || dir.starts_with(&format!("{root}/"));
    if !inside {
        return Vec::new();
    }
    vec![DIRECTORY_INSIDE_SHARED.to_string()]
}

pub fn has_dot_dot(path: &str) -> bool {
    path.split(['/', '\\']).any(|segment| segment == "..")
}

pub fn expand_home(raw: &str, home: &str) -> String {
    if let Some(rest) = raw.strip_prefix("~/") {
        posix_join(&[home, rest])
    } else {
        raw.to_string()
    }
}

pub fn is_codex_default_model(harness_id: &str, model: &str) -> bool {
    harness_id == "codex" && model == "default"
}

#[cfg(test)]
mod cap_tests {
    use protocol::js::{JsValue, stringify};

    use super::cap_text;

    #[test]
    fn cap_keeps_a_surrogate_that_crosses_the_boundary() {
        let mut text = "a".repeat(127);
        text.push('\u{1F600}');
        let capped = cap_text(&text, 128);
        assert_eq!(capped.len(), 128);
        assert_eq!(capped.units()[127], 0xD83D);
        let encoded = stringify(&JsValue::String(capped));
        assert!(encoded.contains("\\ud83d"));
    }
}
