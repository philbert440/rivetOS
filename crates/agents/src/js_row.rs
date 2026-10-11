use std::path::{Component, Path, PathBuf};

use protocol::js::{JsObject, JsString, JsValue, parse, stringify};

use crate::error::PresetError;

pub(crate) fn js_string(text: &str) -> JsValue {
    JsValue::String(JsString::from_text(text))
}

pub(crate) fn js_from(text: &JsString) -> JsValue {
    JsValue::String(text.clone())
}

pub(crate) fn js_text(value: &JsValue, key: &str) -> JsString {
    js_text_opt(value, key).unwrap_or_else(|| JsString::from_text(""))
}

pub(crate) fn js_text_opt(value: &JsValue, key: &str) -> Option<JsString> {
    value.get(key).and_then(JsValue::as_js_string).cloned()
}

pub(crate) fn js_f64(value: &JsValue) -> Option<f64> {
    match value {
        JsValue::Number(number) if number.is_finite() => Some(*number),
        _ => None,
    }
}

pub(crate) fn js_i64(value: &JsValue) -> Option<i64> {
    let number = js_f64(value)?;
    if number.fract() != 0.0 {
        return None;
    }
    if number < i64::MIN as f64 || number >= 9_223_372_036_854_775_808.0 {
        return None;
    }
    Some(number as i64)
}

pub(crate) fn is_js_integer(value: &JsValue) -> bool {
    js_f64(value).is_some_and(|number| number.fract() == 0.0)
}

pub(crate) fn object_from_pairs(pairs: Vec<(&str, JsValue)>) -> Result<JsValue, PresetError> {
    let entries = pairs
        .into_iter()
        .map(|(key, value)| (JsString::from_text(key), value))
        .collect();
    object_from_entries(entries)
}

pub(crate) fn object_from_entries(
    entries: Vec<(JsString, JsValue)>,
) -> Result<JsValue, PresetError> {
    let mut body = String::from('{');
    for (index, (key, value)) in entries.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str(&stringify(&JsValue::String(key.clone())));
        body.push(':');
        body.push_str(&stringify(value));
    }
    body.push('}');
    parse(&body).map_err(|err| PresetError::message(err.to_string()))
}

pub(crate) fn entries_of(value: &JsValue) -> Result<Vec<(JsString, JsValue)>, PresetError> {
    let Some(object) = value.as_object() else {
        return Err(PresetError::message("preset row is not an object"));
    };
    Ok(object
        .iter()
        .map(|(key, child)| (key.clone(), child.clone()))
        .collect())
}

pub(crate) fn upsert(entries: &mut Vec<(JsString, JsValue)>, key: &str, value: JsValue) {
    let needle = JsString::from_text(key);
    if let Some(slot) = entries.iter_mut().find(|(existing, _)| existing == &needle) {
        slot.1 = value;
    } else {
        entries.push((needle, value));
    }
}

pub(crate) fn remove_key(entries: &mut Vec<(JsString, JsValue)>, key: &str) {
    let needle = JsString::from_text(key);
    entries.retain(|(existing, _)| existing != &needle);
}

pub(crate) fn stringify_pretty(value: &JsValue) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

pub(crate) fn file_identity(file: &str) -> String {
    let lexical = lexical_absolute(file);
    let path = Path::new(&lexical);
    if let Ok(canon) = std::fs::canonicalize(path) {
        return canon.to_string_lossy().into_owned();
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name())
        && let Ok(parent) = std::fs::canonicalize(parent)
    {
        return parent.join(name).to_string_lossy().into_owned();
    }
    lexical
}

fn lexical_absolute(file: &str) -> String {
    let path = Path::new(file);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

fn write_pretty(value: &JsValue, depth: usize, out: &mut String) {
    match value {
        JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) | JsValue::String(_) => {
            out.push_str(&stringify(value));
        }
        JsValue::Array(items) => write_array(items, depth, out),
        JsValue::Object(object) => write_object(object, depth, out),
    }
}

fn write_array(items: &[JsValue], depth: usize, out: &mut String) {
    if items.is_empty() {
        out.push_str("[]");
        return;
    }
    out.push_str("[\n");
    for (index, item) in items.iter().enumerate() {
        out.push_str(&"  ".repeat(depth + 1));
        write_pretty(item, depth + 1, out);
        if index + 1 != items.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str(&"  ".repeat(depth));
    out.push(']');
}

fn write_object(object: &JsObject, depth: usize, out: &mut String) {
    let mut indexed = Vec::new();
    let mut rest = Vec::new();
    for (key, value) in object.iter() {
        if let Some(index) = array_index(key) {
            indexed.push((index, key.clone(), value.clone()));
        } else {
            rest.push((key.clone(), value.clone()));
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    let mut ordered = Vec::new();
    for (_, key, value) in indexed {
        ordered.push((key, value));
    }
    ordered.extend(rest);
    if ordered.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push_str("{\n");
    for (index, (key, value)) in ordered.iter().enumerate() {
        out.push_str(&"  ".repeat(depth + 1));
        out.push_str(&stringify(&JsValue::String(key.clone())));
        out.push_str(": ");
        write_pretty(value, depth + 1, out);
        if index + 1 != ordered.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str(&"  ".repeat(depth));
    out.push('}');
}

fn array_index(key: &JsString) -> Option<u32> {
    let text = key.to_utf8();
    if text.is_empty() || text.len() > 10 {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    if !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: u64 = text.parse().ok()?;
    if value > 4_294_967_294 {
        return None;
    }
    u32::try_from(value).ok()
}

pub(crate) fn serde_to_js(value: &serde_json::Value) -> JsValue {
    match value {
        serde_json::Value::Null => JsValue::Null,
        serde_json::Value::Bool(item) => JsValue::Bool(*item),
        serde_json::Value::Number(number) => JsValue::Number(number.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(text) => js_string(text),
        serde_json::Value::Array(items) => JsValue::Array(items.iter().map(serde_to_js).collect()),
        serde_json::Value::Object(map) => {
            let pairs = map
                .iter()
                .map(|(key, child)| (key.as_str(), serde_to_js(child)))
                .collect();
            object_from_pairs(pairs).unwrap_or(JsValue::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{js_string, object_from_pairs, stringify_pretty};
    use protocol::js::{parse, stringify};

    #[test]
    fn pretty_print_matches_json_stringify_spacing() {
        let row = object_from_pairs(vec![
            ("id", js_string("fixed")),
            ("name", js_string("Reviewer")),
            ("ok", protocol::js::JsValue::Bool(true)),
            ("n", protocol::js::JsValue::Number(5000.0)),
        ])
        .unwrap();
        let root =
            object_from_pairs(vec![("agents", protocol::js::JsValue::Array(vec![row]))]).unwrap();
        assert_eq!(
            stringify_pretty(&root),
            "{\n  \"agents\": [\n    {\n      \"id\": \"fixed\",\n      \"name\": \"Reviewer\",\n      \"ok\": true,\n      \"n\": 5000\n    }\n  ]\n}"
        );
    }

    #[test]
    fn rebuild_keeps_an_unpaired_surrogate() {
        let parsed = parse(r#"{"name":"\ud83d","displayMetadata":{"k":1}}"#).unwrap();
        let again = parse(&stringify(&parsed)).unwrap();
        assert_eq!(
            stringify(&again),
            r#"{"name":"\ud83d","displayMetadata":{"k":1}}"#
        );
        assert!(stringify_pretty(&parsed).contains(r"\ud83d"));
    }
}
