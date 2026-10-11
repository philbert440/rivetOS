use serde_json::Value;

use super::{JsString, JsValue, is_js_whitespace};

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn js_slice(text: &str, start: Option<f64>, end: Option<f64>) -> JsString {
    let units: Vec<u16> = text.encode_utf16().collect();
    JsString::from_units(js_slice_units(&units, start, end))
}

pub fn js_substring(text: &str, start: Option<f64>, end: Option<f64>) -> JsString {
    let units: Vec<u16> = text.encode_utf16().collect();
    JsString::from_units(js_substring_units(&units, start, end))
}

pub fn js_slice_units(units: &[u16], start: Option<f64>, end: Option<f64>) -> Vec<u16> {
    let len = units.len();
    let from = slice_index(start.unwrap_or(0.0), len);
    let to = match end {
        Some(value) => slice_index(value, len),
        None => len,
    };
    if from >= to {
        return Vec::new();
    }
    units[from..to].to_vec()
}

pub fn js_substring_units(units: &[u16], start: Option<f64>, end: Option<f64>) -> Vec<u16> {
    let len = units.len();
    let from = substring_index(start.unwrap_or(0.0), len);
    let to = match end {
        Some(value) => substring_index(value, len),
        None => len,
    };
    let (lo, hi) = if from <= to { (from, to) } else { (to, from) };
    units[lo..hi].to_vec()
}

fn to_integer_or_infinity(value: f64) -> f64 {
    if value.is_nan() || value == 0.0 {
        0.0
    } else if value.is_infinite() {
        value
    } else {
        value.trunc()
    }
}

fn slice_index(value: f64, len: usize) -> usize {
    let integer = to_integer_or_infinity(value);
    let len_f = len as f64;
    if integer < 0.0 {
        if integer.is_infinite() {
            return 0;
        }
        let shifted = len_f + integer;
        if shifted <= 0.0 {
            0
        } else if shifted >= len_f {
            len
        } else {
            shifted as usize
        }
    } else if integer >= len_f {
        len
    } else {
        integer as usize
    }
}

fn substring_index(value: f64, len: usize) -> usize {
    let integer = to_integer_or_infinity(value);
    let len_f = len as f64;
    if integer <= 0.0 {
        0
    } else if integer >= len_f {
        len
    } else {
        integer as usize
    }
}

pub fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

fn whitespace_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

pub fn js_trim_units(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|unit| !whitespace_unit(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !whitespace_unit(*unit))
        .map(|index| index + 1)
        .unwrap_or(start);
    &units[start..end]
}

pub fn js_trim_start_units(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|unit| !whitespace_unit(*unit))
        .unwrap_or(units.len());
    &units[start..]
}

pub fn js_trim_end_units(units: &[u16]) -> &[u16] {
    let end = units
        .iter()
        .rposition(|unit| !whitespace_unit(*unit))
        .map(|index| index + 1)
        .unwrap_or(0);
    &units[..end]
}

pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity".to_string()
        } else {
            "Infinity".to_string()
        };
    }
    crate::js_number::json_number(value)
}

pub fn js_string(value: &JsValue) -> JsString {
    match value {
        JsValue::Null => JsString::from_text("null"),
        JsValue::Bool(true) => JsString::from_text("true"),
        JsValue::Bool(false) => JsString::from_text("false"),
        JsValue::Number(number) => JsString::from_text(&number_to_string(*number)),
        JsValue::String(text) => text.clone(),
        JsValue::Array(items) => JsString::from_text(&join_array(items)),
        JsValue::Object(_) => JsString::from_text("[object Object]"),
    }
}

fn join_array(items: &[JsValue]) -> String {
    let mut out = String::new();
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        if !matches!(item, JsValue::Null) {
            out.push_str(js_string(item).to_utf8());
        }
    }
    out
}

pub fn js_boolean(value: &JsValue) -> bool {
    match value {
        JsValue::Null => false,
        JsValue::Bool(flag) => *flag,
        JsValue::Number(number) => *number != 0.0 && !number.is_nan(),
        JsValue::String(text) => !text.is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

pub fn js_to_string_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(number) => json_number_to_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string_json(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn json_number_to_string(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    match number.as_f64() {
        Some(float) => crate::JsNumber::from(float).to_string(),
        None => number.to_string(),
    }
}

pub fn js_boolean_json(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => match number.as_f64() {
            Some(float) => float != 0.0 && !float.is_nan(),
            None => true,
        },
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        js_boolean, js_slice, js_substring, js_trim_end, js_trim_start, js_trim_units, utf16_len,
    };
    use crate::js::{JsValue, is_js_whitespace};

    #[test]
    fn slice_and_trim_cover_edges() {
        assert_eq!(utf16_len("a😀b"), 4);
        assert_eq!(js_slice("a😀b", Some(1.5), Some(-1.0)).to_utf8(), "😀");
        assert_eq!(js_substring("abc", Some(-1.0), Some(2.2)).to_utf8(), "ab");
        assert_eq!(js_slice("abc", None, Some(f64::NAN)).to_utf8(), "");
        assert_eq!(js_slice("😀", Some(0.0), Some(1.0)).units(), &[0xD83D]);
        let mut capped = "a".repeat(199);
        capped.push('😀');
        let sliced = js_slice(&capped, Some(0.0), Some(200.0));
        assert_eq!(sliced.len(), 200);
        assert_eq!(sliced.units()[199], 0xD83D);
        assert_eq!(
            js_substring(&capped, Some(0.0), Some(200.0)).units(),
            sliced.units()
        );
        assert!(is_js_whitespace('\u{00A0}'));
        assert!(!is_js_whitespace('\u{0085}'));
        assert_eq!(js_trim_start(" \t x"), "x");
        assert_eq!(js_trim_end("x \n"), "x");
        assert_eq!(js_trim_units(&[0x85, 120, 0x85]), &[0x85, 120, 0x85]);
        assert!(!js_boolean(&JsValue::Number(-0.0)));
        assert!(js_boolean(&JsValue::Array(Vec::new())));
        assert!(!js_boolean(&JsValue::from_text("")));
    }
}
