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

async fn list_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_spool_file_name(&name) {
            continue;
        }
        if entry.file_type().await?.is_file() {
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
    let body = serde_json::to_value(batch)
        .map(|value| protocol::js::stringify(&value))
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error.to_string()))?;
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
        return Err(error);
    }
    sync_dir(dir).await?;
    Ok(file)
}

async fn write_exclusive(path: &Path, body: &[u8]) -> io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(body).await?;
    let mut permissions = file.metadata().await?.permissions();
    permissions.set_mode(0o600);
    file.set_permissions(permissions).await?;
    file.sync_all().await?;
    Ok(())
}

async fn sync_dir(dir: &Path) -> io::Result<()> {
    let file = tokio::fs::File::open(dir).await?;
    file.sync_all().await
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
            Err(error) => return Err(error),
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
        tokio::fs::rename(dir.join(&file), dead.join(&file)).await
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
