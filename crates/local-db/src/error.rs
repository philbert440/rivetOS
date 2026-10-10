use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum LocalDbError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Engine(String),
    #[error("{0}")]
    Extension(String),
    #[error("postgres: {0}")]
    Postgres(String),
    #[error("embedded postgres: operation timed out after {0:?}")]
    Timeout(Duration),
    #[error("{0}")]
    Json(String),
}

impl LocalDbError {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}

pub type Result<T> = std::result::Result<T, LocalDbError>;

pub fn engine_error(error: postgresql_embedded::Error) -> LocalDbError {
    LocalDbError::Engine(error.to_string())
}

pub fn extension_error(error: postgresql_extensions::Error) -> LocalDbError {
    LocalDbError::Extension(error.to_string())
}
