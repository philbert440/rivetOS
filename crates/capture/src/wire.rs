use protocol::js::{JsObject, JsString, JsValue};
use serde_json::{Map, Value};

use crate::types::{CaptureBatch, CaptureMessage};

pub(crate) fn batch_to_js(batch: &CaptureBatch) -> JsValue {
    let mut object = JsObject::new();
    object.insert(key("session_key"), JsValue::from_text(&batch.session_key));
    object.insert(key("agent"), JsValue::from_text(&batch.agent));
    if let Some(channel) = &batch.channel {
        object.insert(key("channel"), JsValue::from_text(channel));
    }
    if let Some(title) = &batch.title {
        object.insert(key("title"), JsValue::from_text(title));
    }
    if let Some(settings) = &batch.settings {
        object.insert(key("settings"), protocol::js::from_serde(settings));
    }
    if let Some(task_id) = &batch.task_id {
        object.insert(key("task_id"), JsValue::from_text(task_id));
    }
    if let Some(finalize) = batch.finalize {
        object.insert(key("finalize"), JsValue::Bool(finalize));
    }
    if let Some(created_at) = &batch.created_at {
        object.insert(key("created_at"), JsValue::from_text(created_at));
    }
    if let Some(updated_at) = &batch.updated_at {
        object.insert(key("updated_at"), JsValue::from_text(updated_at));
    }
    let messages = batch.messages.iter().map(message_to_js).collect();
    object.insert(key("messages"), JsValue::Array(messages));
    JsValue::Object(object)
}

pub(crate) fn message_to_js(message: &CaptureMessage) -> JsValue {
    let mut object = JsObject::new();
    object.insert(key("event_id"), JsValue::from_text(&message.event_id));
    object.insert(key("role"), JsValue::from_text(message.role.as_str()));
    object.insert(key("content"), JsValue::from_text(&message.content));
    if let Some(tool_name) = &message.tool_name {
        object.insert(key("tool_name"), JsValue::from_text(tool_name));
    }
    if let Some(tool_args) = &message.tool_args {
        object.insert(key("tool_args"), protocol::js::from_serde(tool_args));
    }
    if let Some(tool_result) = &message.tool_result {
        object.insert(key("tool_result"), JsValue::from_text(tool_result));
    }
    if let Some(metadata) = &message.metadata {
        object.insert(key("metadata"), map_to_js(metadata));
    }
    if let Some(created_at) = &message.created_at {
        object.insert(key("created_at"), JsValue::from_text(created_at));
    }
    JsValue::Object(object)
}

fn map_to_js(map: &Map<String, Value>) -> JsValue {
    protocol::js::from_serde(&Value::Object(map.clone()))
}

pub(crate) fn key(name: &str) -> JsString {
    JsString::from_text(name)
}

pub(crate) fn number_value(value: usize) -> JsValue {
    JsValue::Number(value as f64)
}
