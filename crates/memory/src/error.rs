use protocol::{memory_error_json, ErrorDetails, ErrorJson, MemoryErrorCode};
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("{message}")]
    Memory {
        code: MemoryErrorCode,
        message: String,
        cause: Option<String>,
    },
    #[error("{0}")]
    Request(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0} is not implemented in this slice")]
    NotYetImplemented(&'static str),
}

impl StoreError {
    pub fn connection(cause: impl std::fmt::Display) -> Self {
        Self::Memory {
            code: MemoryErrorCode::MemoryConnectionFailed,
            message: "Failed to connect to memory database".to_string(),
            cause: Some(cause.to_string()),
        }
    }

    pub fn query(message: impl std::fmt::Display) -> Self {
        Self::Memory {
            code: MemoryErrorCode::MemoryQueryFailed,
            message: format!("Memory append failed: {message}"),
            cause: Some(message.to_string()),
        }
    }

    pub fn migration(message: impl std::fmt::Display) -> Self {
        Self::Memory {
            code: MemoryErrorCode::MemoryMigrationFailed,
            message: message.to_string(),
            cause: None,
        }
    }

    pub fn to_error_json(&self, timestamp_ms: i64) -> Option<ErrorJson> {
        let Self::Memory { code, message, cause } = self else {
            return None;
        };
        Some(memory_error_json(
            *code,
            ErrorDetails {
                message: message.clone(),
                timestamp: timestamp_ms,
                cause: cause.clone(),
                stack: None,
                context: Map::<String, Value>::new(),
            },
        ))
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
