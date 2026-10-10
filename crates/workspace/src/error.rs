use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("{path}: {source}")]
    Io { path: String, source: io::Error },
    #[error("file io timed out: {0}")]
    Timeout(String),
}

impl WorkspaceError {
    pub(crate) fn io(path: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct PinReject {
    pub message: String,
}

impl PinReject {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct ProviderError(pub String);
