use serde_json::Value;

pub(crate) fn is_falsy(value: &Value) -> bool {
    !protocol::js::js_boolean_json(value)
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
    protocol::js::js_to_string_json(value)
}

pub(crate) use protocol::js::js_trim;

pub(crate) fn utf16_len(text: &str) -> usize {
    protocol::js::utf16_len(text)
}

pub(crate) fn trimmed_nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !js_trim(text).is_empty())
}

pub(crate) fn non_null_objectish(value: &Value) -> bool {
    value.is_object() || value.is_array()
}
