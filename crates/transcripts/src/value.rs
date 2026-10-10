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

pub fn js_slice(text: &str, start: isize, end: Option<isize>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let len = units.len() as isize;
    let from = if start < 0 { (len + start).max(0) } else { start.min(len) } as usize;
    let to = match end {
        Some(end) if end < 0 => (len + end).max(0) as usize,
        Some(end) => (end as usize).min(units.len()),
        None => units.len(),
    };
    let to = to.max(from).min(units.len());
    String::from_utf16_lossy(&units[from..to])
}

pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn clip(text: &str, max: usize) -> String {
    js_slice(text, 0, Some(max as isize))
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
