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

    pub fn with_lines(self, lines: &[String]) -> Self {
        if lines.is_empty() {
            return self;
        }
        let mut text = String::new();
        for line in lines {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str(&self.to_string());
        Self::Msg(text)
    }
}

pub fn wrap(err: impl Display) -> Error {
    Error::msg(err.to_string())
}
