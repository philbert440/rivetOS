use protocol::js::{JsValue, parse, stringify};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::WorkflowError;

#[derive(Clone, Debug)]
pub struct WireJson {
    raw: String,
    value: Value,
}

impl PartialEq for WireJson {
    fn eq(&self, other: &Self) -> bool {
        self.raw == other.raw
    }
}

impl WireJson {
    pub fn parse(text: &str) -> Result<Self, WorkflowError> {
        let value = parse(text).map_err(|err| WorkflowError::message(err.to_string()))?;
        Ok(Self::from_js(&value))
    }

    pub fn from_js(value: &JsValue) -> Self {
        let raw = stringify(value);
        let view = value_from_raw(&raw);
        Self { raw, value: view }
    }

    pub fn from_value(value: &Value) -> Result<Self, WorkflowError> {
        let text =
            serde_json::to_string(value).map_err(|err| WorkflowError::message(err.to_string()))?;
        Self::parse(&text)
    }

    pub fn raw(&self) -> &str {
        &self.raw
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn to_value(&self) -> Value {
        self.value.clone()
    }

    pub fn entries(&self) -> Result<Vec<(String, String)>, WorkflowError> {
        let parsed = parse(&self.raw).map_err(|err| WorkflowError::message(err.to_string()))?;
        let Some(object) = parsed.as_object() else {
            return Err(WorkflowError::message("json value is not an object"));
        };
        Ok(object
            .iter()
            .map(|(key, value)| (key.to_utf8().to_string(), stringify(value)))
            .collect())
    }

    pub fn get_raw(&self, key: &str) -> Result<Option<String>, WorkflowError> {
        Ok(self
            .entries()?
            .into_iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value))
    }

    pub fn set_key(&self, key: &str, raw_value: &str) -> Result<Self, WorkflowError> {
        let mut entries = self.entries()?;
        if let Some(slot) = entries.iter_mut().find(|(existing, _)| existing == key) {
            slot.1 = raw_value.to_string();
        } else {
            entries.push((key.to_string(), raw_value.to_string()));
        }
        Self::from_entries(entries)
    }

    pub fn from_entries(entries: Vec<(String, String)>) -> Result<Self, WorkflowError> {
        let mut body = String::from("{");
        for (index, (key, value)) in entries.iter().enumerate() {
            if index > 0 {
                body.push(',');
            }
            body.push_str(&stringify(&JsValue::from_text(key)));
            body.push(':');
            body.push_str(value);
        }
        body.push('}');
        Self::parse(&body)
    }
}

impl Serialize for WireJson {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.value.serialize(serializer)
    }
}

pub fn typed_raw<T: Serialize>(value: &T) -> Result<String, WorkflowError> {
    let text =
        serde_json::to_string(value).map_err(|err| WorkflowError::message(err.to_string()))?;
    Ok(WireJson::parse(&text)?.raw)
}

pub fn parse_typed<T: DeserializeOwned>(value: &JsValue) -> Result<T, WorkflowError> {
    let raw = stringify(value);
    if let Ok(typed) = serde_json::from_str(&raw) {
        return Ok(typed);
    }
    serde_json::from_value(js_to_value(value))
        .map_err(|err| WorkflowError::message(format!("failed to parse journal line: {err}")))
}

pub fn js_to_value(value: &JsValue) -> Value {
    match value {
        JsValue::Null => Value::Null,
        JsValue::Bool(item) => Value::Bool(*item),
        JsValue::Number(number) => {
            let raw = stringify(&JsValue::Number(*number));
            serde_json::from_str(&raw).unwrap_or(Value::Null)
        }
        JsValue::String(text) => Value::String(text.to_utf8().to_string()),
        JsValue::Array(items) => Value::Array(items.iter().map(js_to_value).collect()),
        JsValue::Object(object) => {
            let mut map = Map::new();
            for (key, item) in object.iter() {
                map.insert(key.to_utf8().to_string(), js_to_value(item));
            }
            Value::Object(map)
        }
    }
}

fn value_from_raw(raw: &str) -> Value {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return value;
    }
    match parse(raw) {
        Ok(value) => js_to_value(&value),
        Err(_) => Value::Null,
    }
}

pub struct JsonLine {
    first: bool,
    out: String,
}

impl JsonLine {
    pub fn new() -> Self {
        Self {
            first: true,
            out: String::from("{"),
        }
    }

    pub fn raw(&mut self, key: &str, value: &str) {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        self.out.push_str(&stringify(&JsValue::from_text(key)));
        self.out.push(':');
        self.out.push_str(value);
    }

    pub fn string(&mut self, key: &str, value: &str) {
        self.raw(key, &stringify(&JsValue::from_text(value)));
    }

    pub fn i64(&mut self, key: &str, value: i64) {
        self.raw(key, &stringify(&JsValue::Number(value as f64)));
    }

    pub fn finish(mut self) -> String {
        self.out.push('}');
        self.out
    }
}
