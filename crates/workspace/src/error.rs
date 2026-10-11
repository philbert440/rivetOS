use std::io;
use std::path::Path;

use protocol::host::fs_error;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("{0}")]
    Io(String),
    #[error("file io timed out: {0}")]
    Timeout(String),
}

impl WorkspaceError {
    pub(crate) fn io(path: &str, syscall: &'static str, source: io::Error) -> Self {
        Self::Io(fs_error(syscall, Some(Path::new(path)), None, &source).to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::WorkspaceError;

    #[test]
    fn filesystem_errors_use_node_operator_text() {
        let denied = WorkspaceError::io(
            "/workspace/AGENT.md",
            "open",
            io::Error::from_raw_os_error(13),
        );
        assert_eq!(
            denied.to_string(),
            "EACCES: permission denied, open '/workspace/AGENT.md'"
        );
        let readonly = WorkspaceError::io(
            "/workspace/AGENT.md",
            "open",
            io::Error::from_raw_os_error(30),
        );
        assert_eq!(
            readonly.to_string(),
            "EROFS: read-only file system, open '/workspace/AGENT.md'"
        );
        let not_dir =
            WorkspaceError::io("/workspace/file", "mkdir", io::Error::from_raw_os_error(20));
        assert_eq!(
            not_dir.to_string(),
            "ENOTDIR: not a directory, mkdir '/workspace/file'"
        );
        let is_dir = WorkspaceError::io("/workspace/dir", "read", io::Error::from_raw_os_error(21));
        assert_eq!(
            is_dir.to_string(),
            "EISDIR: illegal operation on a directory, read '/workspace/dir'"
        );
        let missing = WorkspaceError::io("/missing", "open", io::Error::from_raw_os_error(2));
        assert_eq!(
            missing.to_string(),
            "ENOENT: no such file or directory, open '/missing'"
        );
        let unknown = WorkspaceError::io("/x", "open", io::Error::from_raw_os_error(999));
        assert_eq!(unknown.to_string(), "UNKNOWN: unknown error, open '/x'");
        assert_eq!(
            WorkspaceError::Timeout("/workspace/AGENT.md".to_string()).to_string(),
            "file io timed out: /workspace/AGENT.md"
        );
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
