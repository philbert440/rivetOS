use std::path::Path;

use thiserror::Error;

use crate::deadline::{IO_DEADLINE, within_deadline};
use crate::handler::BoxFuture;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct FileError {
    pub message: String,
}

impl FileError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn read_timed_out() -> Self {
        Self::new("file read timed out")
    }

    pub fn is_read_timeout(&self) -> bool {
        self == &Self::read_timed_out()
    }
}

impl From<std::io::Error> for FileError {
    fn from(err: std::io::Error) -> Self {
        Self::new(err.to_string())
    }
}

pub trait FileWriter: Send + Sync {
    fn write<'a>(&'a self, path: &'a str, content: &'a str)
    -> BoxFuture<'a, Result<(), FileError>>;
    fn read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<String>, FileError>>;
    fn append<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), FileError>>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct FsFileWriter;

impl FileWriter for FsFileWriter {
    fn write<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), FileError>> {
        Box::pin(async move {
            within_deadline(store_text(path, content), || {
                FileError::new("file operation timed out")
            })
            .await
        })
    }

    fn read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<String>, FileError>> {
        Box::pin(async move {
            match tokio::time::timeout(IO_DEADLINE, tokio::fs::read(path)).await {
                Ok(Ok(bytes)) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
                Ok(Err(_)) => Ok(None),
                Err(_) => {
                    tracing::warn!("file read timed out: {path}");
                    Err(FileError::read_timed_out())
                }
            }
        })
    }

    fn append<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), FileError>> {
        Box::pin(async move {
            within_deadline(append_text(path, content), || {
                FileError::new("file operation timed out")
            })
            .await
        })
    }
}

async fn store_text(path: &str, content: &str) -> Result<(), FileError> {
    ensure_parent(path).await?;
    let owned_path = path.to_string();
    let owned = content.to_string();
    match tokio::task::spawn_blocking(move || {
        protocol::host::write_text(Path::new(&owned_path), &owned)
    })
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(FileError::new(err.to_string())),
        Err(_) => Err(FileError::new("file write failed")),
    }
}

async fn append_text(path: &str, content: &str) -> Result<(), FileError> {
    ensure_parent(path).await?;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes()).await?;
    Ok(())
}

async fn ensure_parent(path: &str) -> Result<(), FileError> {
    if let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    Ok(())
}
