use protocol::js::JsObject;
use protocol::{ErrorDetails, ErrorJson, MemoryErrorCode, memory_error_json};
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
        let Self::Memory {
            code,
            message,
            cause,
        } = self
        else {
            return None;
        };
        Some(memory_error_json(
            *code,
            ErrorDetails {
                message: message.clone(),
                timestamp: timestamp_ms,
                cause: cause.clone(),
                stack: None,
                context: JsObject::new(),
            },
        ))
    }
}
