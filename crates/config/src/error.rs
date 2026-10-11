use thiserror::Error;

use crate::validate::ValidationResult;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Read(#[from] protocol::host::FsError),
    #[error("{0}")]
    Parse(String),
    #[error("Config validation failed")]
    Validation {
        formatted: String,
        result: ValidationResult,
    },
    #[error("{0}")]
    EmbeddedPort(String),
}
