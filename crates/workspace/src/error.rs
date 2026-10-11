use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("{0}")]
    Io(String),
    #[error("file io timed out: {0}")]
    Timeout(String),
}

impl WorkspaceError {
    pub(crate) fn io(path: &str, syscall: &str, source: io::Error) -> Self {
        Self::Io(node_fs_message(syscall, path, &source))
    }
}

fn node_fs_message(syscall: &str, path: &str, source: &io::Error) -> String {
    let (code, detail) = match source.raw_os_error() {
        Some(errno) => node_errno(errno),
        None => ("UNKNOWN", "unknown error"),
    };
    format!("{code}: {detail}, {syscall} '{path}'")
}

fn node_errno(errno: i32) -> (&'static str, &'static str) {
    match errno {
        1 => ("EPERM", "operation not permitted"),
        2 => ("ENOENT", "no such file or directory"),
        5 => ("EIO", "i/o error"),
        11 => ("EAGAIN", "resource temporarily unavailable"),
        12 => ("ENOMEM", "not enough memory"),
        13 => ("EACCES", "permission denied"),
        16 => ("EBUSY", "device or resource busy"),
        17 => ("EEXIST", "file already exists"),
        18 => ("EXDEV", "cross-device link not permitted"),
        20 => ("ENOTDIR", "not a directory"),
        21 => ("EISDIR", "illegal operation on a directory"),
        22 => ("EINVAL", "invalid argument"),
        23 => ("ENFILE", "file table overflow"),
        24 => ("EMFILE", "too many open files"),
        26 => ("ETXTBSY", "text file busy"),
        27 => ("EFBIG", "file too large"),
        28 => ("ENOSPC", "no space left on device"),
        30 => ("EROFS", "read-only file system"),
        32 => ("EPIPE", "broken pipe"),
        36 => ("ENAMETOOLONG", "name too long"),
        39 => ("ENOTEMPTY", "directory not empty"),
        40 => ("ELOOP", "too many symbolic links encountered"),
        _ => ("UNKNOWN", "unknown error"),
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
