use std::time::{SystemTime, UNIX_EPOCH};

use protocol::{ErrorJson, provider_error_json};
use serde_json::{Map, Value};

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ProviderError {
    pub message: String,
    pub status: i64,
    pub provider_id: String,
    pub timestamp: i64,
}

impl ProviderError {
    pub fn new(message: impl Into<String>, status: i64, provider_id: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status,
            provider_id: provider_id.into(),
            timestamp: now_ms(),
        }
    }

    pub fn timeout(provider_id: &str, ms: u64) -> Self {
        Self::new(
            format!("provider timed out after {ms} ms"),
            0,
            provider_id,
        )
    }

    pub fn to_json(&self) -> ErrorJson {
        provider_error_json(
            self.message.clone(),
            self.status,
            &self.provider_id,
            self.timestamp,
            None,
            None,
            Map::new(),
        )
    }

    pub fn retryable(&self) -> bool {
        matches!(self.status, 429 | 503 | 529)
    }
}

pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

pub fn empty_map() -> Map<String, Value> {
    Map::new()
}
