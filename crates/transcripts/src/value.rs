use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

pub fn as_obj(value: &Value) -> Option<&Obj> {
    value.as_object()
}

pub fn as_obj_mut(value: &mut Value) -> Option<&mut Obj> {
    value.as_object_mut()
}

pub fn obj_of(value: &Value) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

pub fn get<'a>(obj: &'a Obj, key: &str) -> Option<&'a Value> {
    obj.get(key)
}

pub fn str_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

pub fn str_field(obj: &Obj, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn non_empty_str(obj: &Obj, key: &str) -> Option<String> {
    str_field(obj, key).filter(|text| !text.is_empty())
}

pub fn pick_str(obj: &Obj, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| non_empty_str(obj, key))
}

pub fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

pub fn num(value: Option<&Value>) -> f64 {
    value.and_then(finite).unwrap_or(0.0)
}

pub fn js_i64(number: f64) -> i64 {
    if number.is_finite() {
        number.trunc() as i64
    } else {
        0
    }
}

pub fn bool_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

pub fn field_is_nullish_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) if text.is_empty() => true,
        _ => false,
    }
}

pub fn slice_text(text: &str, start: isize, end: Option<isize>) -> protocol::js::JsString {
    protocol::js::js_slice(text, Some(start as f64), end.map(|value| value as f64))
}

pub fn slice_utf8(text: &str, start: isize, end: Option<isize>) -> String {
    slice_text(text, start, end).to_utf8().to_string()
}

pub fn clip(text: &str, max: usize) -> String {
    slice_utf8(text, 0, Some(max as isize))
}

pub fn arr<'a>(obj: &'a Obj, key: &str) -> Option<&'a Vec<Value>> {
    obj.get(key).and_then(Value::as_array)
}

pub fn obj_field<'a>(obj: &'a Obj, key: &str) -> Option<&'a Obj> {
    obj.get(key).and_then(Value::as_object)
}

pub fn jtrim(text: &str) -> &str {
    protocol::js::js_trim(text)
}

pub fn parse_json(text: &str) -> Result<Value, protocol::js::ParseError> {
    protocol::js::parse(text).map(|value| value_from_js(&value))
}

pub fn stringify_json(value: &Value) -> String {
    protocol::js::stringify(&protocol::js::from_serde(value))
}

pub fn js_norm(value: &Value) -> Value {
    parse_json(&stringify_json(value)).unwrap_or_else(|_| value.clone())
}

fn value_from_js(value: &protocol::js::JsValue) -> Value {
    match value {
        protocol::js::JsValue::Null => Value::Null,
        protocol::js::JsValue::Bool(flag) => Value::Bool(*flag),
        protocol::js::JsValue::Number(number) => number_value(*number),
        protocol::js::JsValue::String(text) => Value::String(text.to_utf8().to_string()),
        protocol::js::JsValue::Array(items) => {
            Value::Array(items.iter().map(value_from_js).collect())
        }
        protocol::js::JsValue::Object(object) => {
            let mut map = Map::new();
            for (key, child) in object.iter() {
                map.insert(key.to_utf8().to_string(), value_from_js(child));
            }
            Value::Object(map)
        }
    }
}

fn number_value(number: f64) -> Value {
    if number.is_finite()
        && number.fract() == 0.0
        && number >= i64::MIN as f64
        && number < 9223372036854775808.0
    {
        Value::Number((number as i64).into())
    } else {
        serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

pub fn whitespace_collapse(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            gap = !out.is_empty();
        } else {
            if gap {
                out.push(' ');
            }
            gap = false;
            out.push(ch);
        }
    }
    out
}
