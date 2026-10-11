use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("invalid wiki page: {0}")]
pub struct WikiParseError(pub String);

impl WikiParseError {
    pub fn new(detail: impl Into<String>) -> Self {
        Self(detail.into())
    }
}
