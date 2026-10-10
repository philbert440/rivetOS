use serde_json::{Number, Value};

pub(crate) fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n == 0.0 || n.is_nan()),
        Value::String(text) => text.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

pub(crate) fn js_typeof(value: &Value) -> &'static str {
    match value {
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    }
}

pub(crate) fn js_i64(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    if let Some(integer) = number.as_i64() {
        return Some(integer);
    }
    let float = number.as_f64()?;
    if float.is_finite()
        && float.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&float)
    {
        let integer = float as i64;
        if integer as f64 == float {
            return Some(integer);
        }
    }
    None
}

pub(crate) fn is_positive_number(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| number >= 1.0)
}

pub(crate) fn is_int_between(value: &Value, min: i64, max: i64) -> bool {
    js_i64(value).is_some_and(|number| (min..=max).contains(&number))
}

pub(crate) fn is_non_negative_int(value: &Value) -> bool {
    js_i64(value).is_some_and(|number| number >= 0)
}

pub(crate) fn hour_ok(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| !(number < 0.0 || number > 23.0))
}

pub(crate) fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(number) => number_to_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn number_to_string(number: &Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    match number.as_f64() {
        Some(float) => float_to_string(float),
        None => number.to_string(),
    }
}

fn float_to_string(float: f64) -> String {
    if float.is_nan() {
        return "NaN".to_string();
    }
    if float.is_infinite() {
        return if float.is_sign_positive() {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if float.fract() == 0.0 && float.abs() < 1e21 {
        let integer = float as i64;
        if integer as f64 == float {
            return integer.to_string();
        }
    }
    format!("{float}")
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_trim_whitespace)
}

fn is_js_trim_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn trimmed_nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !js_trim(text).is_empty())
}

pub(crate) fn non_null_objectish(value: &Value) -> bool {
    value.is_object() || value.is_array()
}
