use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::error_json::{ErrorDetails, HarnessErrorCode, harness_error_json};
use crate::js::js_trim;

pub const HARNESS_IDS: &[&str] = &[
    "claude-code",
    "grok-build",
    "kimi-code",
    "hermes",
    "codex",
    "opencode",
    "pi",
    "qwen-code",
    "cursor",
    "cowork",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSessionId {
    pub harness_id: String,
    pub native_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SessionIdError {
    #[error("SessionId must be a string")]
    NotString,
    #[error("SessionId has leading/trailing whitespace")]
    Whitespace,
    #[error("SessionId is missing a harness-id prefix")]
    MissingPrefix,
    #[error("SessionId has an empty native session id")]
    EmptyNative,
    #[error("unknown harness id: {0}")]
    UnknownHarness(String),
}

impl SessionIdError {
    pub fn code(&self) -> &'static str {
        HarnessErrorCode::InvalidSessionId.as_str()
    }

    pub fn to_error_json(&self, id: &str) -> crate::ErrorJson {
        let mut context = Map::new();
        context.insert("id".to_string(), Value::String(id.to_string()));
        harness_error_json(
            HarnessErrorCode::InvalidSessionId,
            ErrorDetails {
                message: self.to_string(),
                timestamp: unix_millis(),
                cause: None,
                stack: None,
                context,
            },
            None,
            None,
        )
    }
}

fn unix_millis() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

pub fn parse_session_id(id: &Value) -> Result<ParsedSessionId, SessionIdError> {
    match id.as_str() {
        Some(text) => parse_session_id_str(text),
        None => Err(SessionIdError::NotString),
    }
}

pub fn parse_session_id_str(id: &str) -> Result<ParsedSessionId, SessionIdError> {
    if id != js_trim(id) {
        return Err(SessionIdError::Whitespace);
    }
    let Some(colon) = id.find(':') else {
        return Err(SessionIdError::MissingPrefix);
    };
    if colon == 0 {
        return Err(SessionIdError::MissingPrefix);
    }
    if colon + 1 == id.len() {
        return Err(SessionIdError::EmptyNative);
    }
    let harness_id = &id[..colon];
    if !HARNESS_IDS.contains(&harness_id) {
        return Err(SessionIdError::UnknownHarness(harness_id.to_string()));
    }
    Ok(ParsedSessionId {
        harness_id: harness_id.to_string(),
        native_session_id: id[colon + 1..].to_string(),
    })
}
