use thiserror::Error;

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("{0}")]
    Message(String),
    #[error("acp transport closed")]
    Closed,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Protocol(#[from] agent_client_protocol::Error),
}

impl AcpError {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}
