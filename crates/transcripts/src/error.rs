use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TranscriptError {
    #[error("{message}")]
    CapabilityUnsupported { code: &'static str, message: &'static str },
}

impl TranscriptError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CapabilityUnsupported { code, .. } => code,
        }
    }
}

pub fn codex_approval_keys() -> Result<(), TranscriptError> {
    Err(TranscriptError::CapabilityUnsupported {
        code: "capability_unsupported",
        message: "codex: PTY approvals are not supported — Codex TUI key bindings are unverified; approvals are served by the protocol driver (codexAppServerUrl) only.",
    })
}
