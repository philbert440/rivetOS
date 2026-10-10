use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::fs;

use crate::error::WorkflowError;

const IO_TIMEOUT: Duration = Duration::from_secs(30);

static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

async fn bound<T>(
    operation: &'static str,
    path: &Path,
    future: impl std::future::Future<Output = Result<T, WorkflowError>>,
) -> Result<T, WorkflowError> {
    match tokio::time::timeout(IO_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(WorkflowError::message(format!(
            "{operation} timed out after 30000ms: {}",
            path.display()
        ))),
    }
}

pub async fn create_dir_all(path: &Path) -> Result<(), WorkflowError> {
    let owned = path.to_path_buf();
    bound("create_dir", path, async move {
        fs::create_dir_all(&owned)
            .await
            .map_err(|err| WorkflowError::io(&owned, err))
    })
    .await
}

pub async fn read_string(path: &Path) -> Result<String, WorkflowError> {
    let owned = path.to_path_buf();
    bound("read", path, async move {
        fs::read_to_string(&owned)
            .await
            .map_err(|err| WorkflowError::io(&owned, err))
    })
    .await
}

pub async fn append_bytes(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    let owned = path.to_path_buf();
    let bytes = bytes.to_vec();
    bound("write", path, async move {
        use tokio::io::AsyncWriteExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&owned)
            .await
            .map_err(|err| WorkflowError::io(&owned, err))?;
        file.write_all(&bytes)
            .await
            .map_err(|err| WorkflowError::io(&owned, err))?;
        file.flush()
            .await
            .map_err(|err| WorkflowError::io(&owned, err))?;
        Ok(())
    })
    .await
}

pub async fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    let owned = path.to_path_buf();
    let bytes = bytes.to_vec();
    bound("write", path, async move {
        if let Some(parent) = owned.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|err| WorkflowError::io(parent, err))?;
        }
        fs::write(&owned, bytes)
            .await
            .map_err(|err| WorkflowError::io(&owned, err))
    })
    .await
}

pub async fn rename(from: &Path, to: &Path) -> Result<(), WorkflowError> {
    let from_owned = from.to_path_buf();
    let to_owned = to.to_path_buf();
    bound("rename", to, async move {
        fs::rename(&from_owned, &to_owned)
            .await
            .map_err(|err| WorkflowError::io(&to_owned, err))
    })
    .await
}

pub async fn try_exists(path: &Path) -> Result<bool, WorkflowError> {
    let owned = path.to_path_buf();
    bound("stat", path, async move {
        fs::try_exists(&owned)
            .await
            .map_err(|err| WorkflowError::io(&owned, err))
    })
    .await
}

pub struct DirItem {
    pub name: String,
    pub is_dir: bool,
    pub is_file: bool,
}

pub async fn read_dir(path: &Path) -> Result<Vec<DirItem>, WorkflowError> {
    let owned = path.to_path_buf();
    bound("read_dir", path, async move {
        let mut reader = fs::read_dir(&owned)
            .await
            .map_err(|err| WorkflowError::io(&owned, err))?;
        let mut items = Vec::new();
        loop {
            let next = reader
                .next_entry()
                .await
                .map_err(|err| WorkflowError::io(&owned, err))?;
            let Some(entry) = next else {
                break;
            };
            let file_type = entry
                .file_type()
                .await
                .map_err(|err| WorkflowError::io(&owned, err))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            items.push(DirItem {
                name,
                is_dir: file_type.is_dir(),
                is_file: file_type.is_file(),
            });
        }
        Ok(items)
    })
    .await
}

pub fn unique_tmp(path: &Path) -> PathBuf {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.{n}.tmp", std::process::id()));
    PathBuf::from(tmp)
}

pub async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent).await?;
    }
    let tmp = unique_tmp(path);
    write_bytes(&tmp, bytes).await?;
    rename(&tmp, path).await
}
