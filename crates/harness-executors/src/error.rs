use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ExecError {
    #[error("{0}")]
    Message(String),
}

impl ExecError {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}
