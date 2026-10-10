use thiserror::Error;

use crate::transport::MissingUserToken;

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("capture HTTP {status}")]
    Client { status: u16 },
    #[error("capture HTTP {status} (not accepted for this user)")]
    TokenRefused { status: u16 },
    #[error("capture HTTP {status}")]
    Server { status: u16 },
    #[error("{0}")]
    Transport(String),
    #[error("{0}")]
    Io(String),
    #[error(transparent)]
    User(#[from] MissingUserToken),
}

impl CaptureError {
    pub fn log_line(&self) -> String {
        match self {
            Self::Client { status } => format!("Error: capture HTTP {status}"),
            Self::TokenRefused { status } => {
                format!("Error: capture HTTP {status} (not accepted for this user)")
            }
            Self::Server { status } => format!("Error: capture HTTP {status}"),
            Self::Transport(message) | Self::Io(message) => format!("Error: {message}"),
            Self::User(error) => format!("Error: {error}"),
        }
    }

    pub fn is_client(&self) -> bool {
        matches!(self, Self::Client { .. })
    }

    pub fn is_token_refused(&self) -> bool {
        matches!(self, Self::TokenRefused { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteOutcome {
    Delivered {
        ok: bool,
        conversation_id: String,
        inserted: u64,
        skipped: u64,
    },
    Spooled {
        file: String,
        files: Vec<String>,
    },
    NotSaved {
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayReport {
    pub replayed: u64,
    pub remaining: u64,
    pub dead: u64,
}
