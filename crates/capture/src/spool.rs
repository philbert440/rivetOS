use std::io::{self, ErrorKind};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::AsyncWriteExt;

use crate::types::CaptureBatch;

const SPOOL_TIMEOUT: Duration = Duration::from_secs(30);

fn is_spool_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let Some((digits, rest)) = stem.split_once('-') else {
        return false;
    };
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && !rest.is_empty()
        && !rest.contains('/')
}

pub async fn spool_files(dir: &Path) -> io::Result<Vec<String>> {
    match with_timeout(list_files(dir)).await {
        Ok(names) => Ok(names),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn node_error(error: io::Error, syscall: &str, path: &Path) -> io::Error {
    let kind = error.kind();
    let text = match node_errno(&error) {
        Some((code, message)) => format!("{code}: {message}, {syscall} '{}'", path.display()),
        None => format!("{error}, {syscall} '{}'", path.display()),
    };
    io::Error::new(kind, text)
}

fn node_rename(error: io::Error, from: &Path, to: &Path) -> io::Error {
    let kind = error.kind();
    let rendered = format!("rename '{}' -> '{}'", from.display(), to.display());
    let text = match node_errno(&error) {
        Some((code, message)) => format!("{code}: {message}, {rendered}"),
        None => format!("{error}, {rendered}"),
    };
    io::Error::new(kind, text)
}

fn node_errno(error: &io::Error) -> Option<(&'static str, &'static str)> {
    if let Some(code) = error.raw_os_error() {
        return errno_pair(code);
    }
    kind_pair(error.kind())
}

fn errno_pair(code: i32) -> Option<(&'static str, &'static str)> {
    Some(match code {
        1 => ("EPERM", "operation not permitted"),
        2 => ("ENOENT", "no such file or directory"),
        4 => ("EINTR", "interrupted system call"),
        5 => ("EIO", "i/o error"),
        6 => ("ENXIO", "no such device or address"),
        7 => ("E2BIG", "argument list too long"),
        8 => ("ENOEXEC", "exec format error"),
        9 => ("EBADF", "bad file descriptor"),
        11 => ("EAGAIN", "resource temporarily unavailable"),
        12 => ("ENOMEM", "not enough memory"),
        13 => ("EACCES", "permission denied"),
        14 => ("EFAULT", "bad address"),
        16 => ("EBUSY", "resource busy or locked"),
        17 => ("EEXIST", "file already exists"),
        18 => ("EXDEV", "cross-device link not permitted"),
        19 => ("ENODEV", "no such device"),
        20 => ("ENOTDIR", "not a directory"),
        21 => ("EISDIR", "illegal operation on a directory"),
        22 => ("EINVAL", "invalid argument"),
        23 => ("ENFILE", "file table overflow"),
        24 => ("EMFILE", "too many open files"),
        25 => ("ENOTTY", "inappropriate ioctl for device"),
        26 => ("ETXTBSY", "text file is busy"),
        27 => ("EFBIG", "file too large"),
        28 => ("ENOSPC", "no space left on device"),
        29 => ("ESPIPE", "invalid seek"),
        30 => ("EROFS", "read-only file system"),
        31 => ("EMLINK", "too many links"),
        32 => ("EPIPE", "broken pipe"),
        36 => ("ENAMETOOLONG", "name too long"),
        39 => ("ENOTEMPTY", "directory not empty"),
        40 => ("ELOOP", "too many symbolic links encountered"),
        122 => ("EDQUOT", "quota exceeded"),
        _ => return None,
    })
}

fn kind_pair(kind: ErrorKind) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        ErrorKind::WouldBlock => ("EAGAIN", "resource temporarily unavailable"),
        ErrorKind::InvalidInput => ("EINVAL", "invalid argument"),
        ErrorKind::Interrupted => ("EINTR", "interrupted system call"),
        ErrorKind::OutOfMemory => ("ENOMEM", "not enough memory"),
        ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        ErrorKind::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        ErrorKind::FileTooLarge => ("EFBIG", "file too large"),
        ErrorKind::QuotaExceeded => ("EDQUOT", "quota exceeded"),
        ErrorKind::CrossesDevices => ("EXDEV", "cross-device link not permitted"),
        ErrorKind::TooManyLinks => ("EMLINK", "too many links"),
        ErrorKind::InvalidFilename => ("ENAMETOOLONG", "name too long"),
        ErrorKind::ResourceBusy => ("EBUSY", "resource busy or locked"),
        ErrorKind::StorageFull => ("ENOSPC", "no space left on device"),
        ErrorKind::NotSeekable => ("ESPIPE", "invalid seek"),
        ErrorKind::ArgumentListTooLong => ("E2BIG", "argument list too long"),
        ErrorKind::ExecutableFileBusy => ("ETXTBSY", "text file is busy"),
        _ => return None,
    })
}

async fn list_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|error| node_error(error, "scandir", dir))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| node_error(error, "scandir", dir))?
    {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_spool_file_name(&name) {
            continue;
        }
        let path = entry.path();
        if entry
            .file_type()
            .await
            .map_err(|error| node_error(error, "stat", &path))?
            .is_file()
        {
            names.push(name);
        }
    }
    names.sort_by(|left, right| {
        prefix_num(left)
            .cmp(&prefix_num(right))
            .then_with(|| left.cmp(right))
    });
    Ok(names)
}

fn prefix_num(name: &str) -> u128 {
    name.split('-').next().unwrap_or("0").parse().unwrap_or(0)
}

pub async fn spool_batch(dir: &Path, batch: &CaptureBatch, now_ms: i64) -> io::Result<PathBuf> {
    let body = protocol::js::stringify(&crate::wire::batch_to_js(batch));
    spool_text(dir, &body, now_ms).await
}

pub(crate) async fn spool_text(dir: &Path, body: &str, now_ms: i64) -> io::Result<PathBuf> {
    let dir = dir.to_path_buf();
    let body = body.to_string();
    with_timeout(async move { write_text(&dir, &body, now_ms).await }).await
}

async fn write_text(dir: &Path, body: &str, now_ms: i64) -> io::Result<PathBuf> {
    ensure_dir(dir, 0o700).await?;
    let file = dir.join(format!("{now_ms}-{}.json", uuid::Uuid::new_v4()));
    let temp = PathBuf::from(format!("{}.tmp", file.display()));
    let write_result = write_exclusive(&temp, body.as_bytes()).await;
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::rename(&temp, &file).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(node_rename(error, &temp, &file));
    }
    sync_dir(dir).await?;
    Ok(file)
}

async fn write_exclusive(path: &Path, body: &[u8]) -> io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut file = options
        .open(path)
        .await
        .map_err(|error| node_error(error, "open", path))?;
    file.write_all(body)
        .await
        .map_err(|error| node_error(error, "write", path))?;
    let mut permissions = file
        .metadata()
        .await
        .map_err(|error| node_error(error, "stat", path))?
        .permissions();
    permissions.set_mode(0o600);
    file.set_permissions(permissions)
        .await
        .map_err(|error| node_error(error, "fchmod", path))?;
    file.sync_all()
        .await
        .map_err(|error| node_error(error, "fsync", path))?;
    Ok(())
}

async fn sync_dir(dir: &Path) -> io::Result<()> {
    let file = tokio::fs::File::open(dir)
        .await
        .map_err(|error| node_error(error, "open", dir))?;
    file.sync_all()
        .await
        .map_err(|error| node_error(error, "fsync", dir))
}

async fn ensure_dir(path: &Path, mode: u32) -> io::Result<()> {
    if path.as_os_str().is_empty() || tokio::fs::metadata(path).await.is_ok() {
        return Ok(());
    }
    let mut missing = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        if cursor.as_os_str().is_empty() {
            break;
        }
        if tokio::fs::metadata(&cursor).await.is_ok() {
            break;
        }
        missing.push(cursor.clone());
        match cursor.parent() {
            Some(parent) if parent != cursor.as_path() => cursor = parent.to_path_buf(),
            _ => break,
        }
    }
    for dir in missing.iter().rev() {
        let mut builder = tokio::fs::DirBuilder::new();
        builder.mode(mode);
        match builder.create(dir).await {
            Ok(()) => {
                let _ =
                    tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode)).await;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(node_error(error, "mkdir", dir)),
        }
    }
    Ok(())
}

pub async fn dead_letter(dir: &Path, file: &str) -> io::Result<()> {
    let dir = dir.to_path_buf();
    let file = file.to_string();
    with_timeout(async move {
        let dead = dir.join("dead");
        ensure_dir(&dead, 0o700).await?;
        let from = dir.join(&file);
        let to = dead.join(&file);
        tokio::fs::rename(&from, &to)
            .await
            .map_err(|error| node_rename(error, &from, &to))
    })
    .await
}

async fn with_timeout<T>(
    operation: impl std::future::Future<Output = io::Result<T>>,
) -> io::Result<T> {
    match tokio::time::timeout(SPOOL_TIMEOUT, operation).await {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            ErrorKind::TimedOut,
            "capture spool timed out",
        )),
    }
}
