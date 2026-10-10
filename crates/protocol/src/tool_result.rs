use serde::{Deserialize, Serialize};

use crate::message::ContentPart;

pub const BLOCKED_PREFIX: &str = "Blocked: ";
pub const TOOL_ERROR_PREFIX: &str = "Error: ";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolResult {
    Text(String),
    Parts(Vec<ContentPart>),
}

pub fn is_blocked(result: &ToolResult) -> bool {
    match result {
        ToolResult::Text(text) => text.starts_with(BLOCKED_PREFIX),
        ToolResult::Parts(_) => false,
    }
}

pub fn is_thrown_error(result: &ToolResult) -> bool {
    match result {
        ToolResult::Text(text) => text.starts_with(TOOL_ERROR_PREFIX),
        ToolResult::Parts(_) => false,
    }
}
