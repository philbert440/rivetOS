use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use crate::js::{JsString, JsValue, parse};
use crate::message::{ContentPart, content_part_from_js};

pub const BLOCKED_PREFIX: &str = "Blocked: ";
pub const TOOL_ERROR_PREFIX: &str = "Error: ";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ToolResult {
    Text(JsString),
    Parts(Vec<ContentPart>),
}

impl<'de> Deserialize<'de> for ToolResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        let text = raw.get();
        let mut value = parse(text).map_err(de::Error::custom)?;
        if let JsValue::String(slot) = &mut value {
            return Ok(Self::Text(std::mem::replace(
                slot,
                JsString::from_units(Vec::new()),
            )));
        }
        if let JsValue::Array(items) = &mut value {
            let items = std::mem::take(items);
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(content_part_from_js(item).map_err(de::Error::custom)?);
            }
            return Ok(Self::Parts(parts));
        }
        Err(de::Error::custom("tool-result"))
    }
}

pub fn is_blocked(result: &ToolResult) -> bool {
    match result {
        ToolResult::Text(text) => text.to_utf8().starts_with(BLOCKED_PREFIX),
        ToolResult::Parts(_) => false,
    }
}

pub fn is_thrown_error(result: &ToolResult) -> bool {
    match result {
        ToolResult::Text(text) => text.to_utf8().starts_with(TOOL_ERROR_PREFIX),
        ToolResult::Parts(_) => false,
    }
}
