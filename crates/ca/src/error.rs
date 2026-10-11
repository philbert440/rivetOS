use std::fmt::Display;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    pub fn msg(text: impl Into<String>) -> Self {
        Self::Msg(text.into())
    }
}

pub fn wrap(err: impl Display) -> Error {
    Error::msg(err.to_string())
}
