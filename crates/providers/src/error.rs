use protocol::js::{JsObject, date_now};
use protocol::{ErrorJson, provider_error_json};

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
            message: crate::http::redact_text(&message.into()),
            status,
            provider_id: provider_id.into(),
            timestamp: date_now() as i64,
        }
    }

    pub fn timeout(provider_id: &str, ms: u64) -> Self {
        Self::new(format!("provider timed out after {ms} ms"), 0, provider_id)
    }

    pub fn to_json(&self) -> ErrorJson {
        provider_error_json(
            self.message.clone(),
            self.status,
            &self.provider_id,
            self.timestamp,
            None,
            None,
            JsObject::new(),
        )
    }

    pub fn retryable(&self) -> bool {
        matches!(self.status, 429 | 503 | 529)
    }
}
