use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::fs;

use crate::error::WorkflowError;

pub(crate) const IO_TIMEOUT: Duration = Duration::from_secs(30);

async fn bound<T>(
    operation: &'static str,
    path: &Path,
    future: impl std::future::Future<Output = Result<T, WorkflowError>>,
) -> Result<T, WorkflowError> {
    match tokio::time::timeout(IO_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(WorkflowError::message(format!(
            "{operation} timed out after {}ms: {}",
            IO_TIMEOUT.as_millis(),
            path.display()
        ))),
    }
}

async fn join_blocking<T>(
    task: tokio::task::JoinHandle<Result<T, WorkflowError>>,
    what: &str,
    path: PathBuf,
) -> Result<T, WorkflowError> {
    match task.await {
        Ok(result) => result,
        Err(_) => Err(WorkflowError::message(format!(
            "{what} task failed: {}",
            path.display()
        ))),
    }
}

pub async fn create_dir_all(path: &Path) -> Result<(), WorkflowError> {
    let owned = path.to_path_buf();
    bound("create_dir", path, async move {
        fs::create_dir_all(&owned)
            .await
            .map_err(|err| WorkflowError::io("mkdir", Some(&owned), &err))
    })
    .await
}

pub async fn read_string(path: &Path) -> Result<String, WorkflowError> {
    let owned = path.to_path_buf();
    bound("read", path, async move {
        let failed = owned.clone();
        let task = tokio::task::spawn_blocking(move || {
            protocol::host::read_text(&owned).map_err(WorkflowError::from_fs)
        });
        join_blocking(task, "read", failed).await
    })
    .await
}

pub fn read_bytes(path: &Path) -> Result<Vec<u8>, WorkflowError> {
    let mut file =
        std::fs::File::open(path).map_err(|err| WorkflowError::io("open", Some(path), &err))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|err| WorkflowError::io("read", None, &err))?;
    Ok(bytes)
}

pub fn repair_torn_tail(
    path: &Path,
    tail_parses: impl FnOnce(&str) -> bool,
) -> Result<(), WorkflowError> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|err| WorkflowError::io("open", Some(path), &err))?;
    let len = file
        .metadata()
        .map_err(|err| WorkflowError::io("stat", Some(path), &err))?
        .len();
    if len == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|err| WorkflowError::io("lseek", Some(path), &err))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)
        .map_err(|err| WorkflowError::io("read", None, &err))?;
    if last[0] == b'\n' {
        return Ok(());
    }
    let tail_at = last_line_start(&mut file, path, len)?;
    let tail_len = usize::try_from(len - tail_at).map_err(|_| {
        WorkflowError::message(format!("journal tail is too large: {}", path.display()))
    })?;
    let mut tail = vec![0u8; tail_len];
    file.seek(SeekFrom::Start(tail_at))
        .map_err(|err| WorkflowError::io("lseek", Some(path), &err))?;
    file.read_exact(&mut tail)
        .map_err(|err| WorkflowError::io("read", None, &err))?;
    if let Ok(text) = std::str::from_utf8(&tail)
        && tail_parses(text)
    {
        file.seek(SeekFrom::End(0))
            .map_err(|err| WorkflowError::io("lseek", Some(path), &err))?;
        file.write_all(b"\n")
            .map_err(|err| WorkflowError::io("write", None, &err))?;
        file.flush()
            .map_err(|err| WorkflowError::io("write", None, &err))?;
        return Ok(());
    }
    file.set_len(tail_at)
        .map_err(|err| WorkflowError::io("ftruncate", Some(path), &err))
}

fn last_line_start(file: &mut std::fs::File, path: &Path, len: u64) -> Result<u64, WorkflowError> {
    let mut end = len;
    let mut buf = [0u8; 8192];
    loop {
        let start = end.saturating_sub(buf.len() as u64);
        let want = usize::try_from(end - start).map_err(|_| {
            WorkflowError::message(format!("journal tail is too large: {}", path.display()))
        })?;
        if want == 0 {
            return Ok(0);
        }
        file.seek(SeekFrom::Start(start))
            .map_err(|err| WorkflowError::io("lseek", Some(path), &err))?;
        file.read_exact(&mut buf[..want])
            .map_err(|err| WorkflowError::io("read", None, &err))?;
        if let Some(index) = buf[..want].iter().rposition(|byte| *byte == b'\n') {
            return Ok(start + index as u64 + 1);
        }
        if start == 0 {
            return Ok(0);
        }
        end = start;
    }
}

pub fn append_line_blocking(path: &Path, line: &[u8]) -> Result<(), WorkflowError> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| WorkflowError::io("open", Some(path), &err))?;
    let mut written = 0;
    while written < line.len() {
        match file.write(&line[written..]) {
            Ok(0) => {
                return Err(WorkflowError::message(format!(
                    "journal write wrote no bytes: {}",
                    path.display()
                )));
            }
            Ok(count) => written += count,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) => return Err(WorkflowError::io("write", None, &err)),
        }
    }
    file.flush()
        .map_err(|err| WorkflowError::io("write", None, &err))
}

pub async fn append_bytes(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    let owned = path.to_path_buf();
    let bytes = bytes.to_vec();
    bound("write", path, async move {
        let failed = owned.clone();
        let task = tokio::task::spawn_blocking(move || append_file(&owned, &bytes));
        join_blocking(task, "write", failed).await
    })
    .await
}

fn append_file(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| WorkflowError::io("open", Some(path), &err))?;
    file.write_all(bytes)
        .map_err(|err| WorkflowError::io("write", None, &err))?;
    file.flush()
        .map_err(|err| WorkflowError::io("write", None, &err))
}

pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|err| WorkflowError::io("open", Some(path), &err))?;
    file.write_all(bytes)
        .map_err(|err| WorkflowError::io("write", None, &err))
}

pub fn mkdir_all(path: &Path) -> Result<(), WorkflowError> {
    std::fs::create_dir_all(path).map_err(|err| WorkflowError::io("mkdir", Some(path), &err))
}

pub async fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    let owned = path.to_path_buf();
    let bytes = bytes.to_vec();
    bound("write", path, async move {
        let failed = owned.clone();
        let task = tokio::task::spawn_blocking(move || {
            if let Some(parent) = owned.parent() {
                mkdir_all(parent)?;
            }
            write_file(&owned, &bytes)
        });
        join_blocking(task, "write", failed).await
    })
    .await
}

pub async fn try_exists(path: &Path) -> Result<bool, WorkflowError> {
    let owned = path.to_path_buf();
    bound("stat", path, async move {
        let failed = owned.clone();
        let task = tokio::task::spawn_blocking(move || stat_exists(&owned));
        join_blocking(task, "stat", failed).await
    })
    .await
}

fn stat_exists(path: &Path) -> Result<bool, WorkflowError> {
    match protocol::host::stat(path) {
        Ok(_) => Ok(true),
        Err(err) if matches!(err.code, "ENOENT" | "ENOTDIR" | "EACCES") => Ok(false),
        Err(err) => Err(WorkflowError::from_fs(err)),
    }
}

pub(crate) fn create_empty_exclusive(path: &Path) -> Result<(), WorkflowError> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(WorkflowError::io("open", Some(path), &err)),
    }
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
            .map_err(|err| WorkflowError::io("scandir", Some(&owned), &err))?;
        let mut items = Vec::new();
        loop {
            let next = reader
                .next_entry()
                .await
                .map_err(|err| WorkflowError::io("scandir", Some(&owned), &err))?;
            let Some(entry) = next else {
                break;
            };
            let entry_path = entry.path();
            let file_type = entry
                .file_type()
                .await
                .map_err(|err| WorkflowError::io("stat", Some(&entry_path), &err))?;
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

pub fn replace_bytes(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    replace_bytes_by(path, bytes, Instant::now() + IO_TIMEOUT)
}

pub fn replace_bytes_by(path: &Path, bytes: &[u8], deadline: Instant) -> Result<(), WorkflowError> {
    if let Some(parent) = path.parent() {
        mkdir_all(parent)?;
    }
    let tmp = unique_temp(path);
    if let Err(err) = write_temp(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    if Instant::now() >= deadline {
        let _ = std::fs::remove_file(&tmp);
        return Err(write_timeout(path));
    }
    if let Err(err) = protocol::host::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(WorkflowError::from_fs(err));
    }
    sync_parent(path)
}

fn write_temp(path: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    let mut file = create_exclusive(path)?;
    file.write_all(bytes)
        .map_err(|err| WorkflowError::io("write", None, &err))?;
    file.sync_all()
        .map_err(|err| WorkflowError::io("fsync", None, &err))
}

fn create_exclusive(path: &Path) -> Result<std::fs::File, WorkflowError> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| WorkflowError::io("open", Some(path), &err))
}

fn unique_temp(path: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let ticket = NEXT.fetch_add(1, Ordering::Relaxed);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{}.{ticket}.wf.tmp", std::process::id()));
    PathBuf::from(name)
}

fn write_timeout(path: &Path) -> WorkflowError {
    WorkflowError::message(format!(
        "write timed out after {}ms: {}",
        IO_TIMEOUT.as_millis(),
        path.display()
    ))
}

fn sync_parent(path: &Path) -> Result<(), WorkflowError> {
    let parent = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let dir =
        std::fs::File::open(parent).map_err(|err| WorkflowError::io("open", Some(parent), &err))?;
    dir.sync_all()
        .map_err(|err| WorkflowError::io("fsync", Some(parent), &err))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    use super::{replace_bytes, replace_bytes_by};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(label: &str) -> PathBuf {
        let n = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("wf-{label}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut found: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        found.sort();
        found
    }

    #[test]
    fn replace_within_the_deadline_commits_mode_0600() {
        let dir = temp_dir("replace-ok");
        let dest = dir.join("case.json");
        std::fs::write(&dest, b"old").unwrap();
        replace_bytes(&dest, b"new\n").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new\n");
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(names(&dir).iter().all(|name| !name.contains(".tmp")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_after_the_deadline_drops_the_temp_and_keeps_the_file() {
        let dir = temp_dir("replace-late");
        let dest = dir.join("case.json");
        std::fs::write(&dest, b"newer-terminal").unwrap();
        let err = replace_bytes_by(
            &dest,
            b"STALE-SNAPSHOT\n",
            Instant::now() - Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("write timed out after 30000ms"),
            "{err}"
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"newer-terminal");
        assert!(names(&dir).iter().all(|name| !name.contains(".tmp")));
        replace_bytes_by(
            &dest,
            b"failed-later\n",
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"failed-later\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_failure_removes_only_its_temp() {
        let dir = temp_dir("replace-fail");
        let dest = dir.join("adir");
        std::fs::create_dir(&dest).unwrap();
        let err = replace_bytes(&dest, b"ours").unwrap_err();
        assert!(dest.is_dir(), "{err}");
        assert!(names(&dir).iter().all(|name| !name.contains(".tmp")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn exclusive_create_leaves_existing_bytes() {
        let dir = temp_dir("exclusive");
        let path = dir.join("journal.jsonl");
        std::fs::write(&path, b"line\n").unwrap();
        super::create_empty_exclusive(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"line\n");
        let fresh = dir.join("new.jsonl");
        super::create_empty_exclusive(&fresh).unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"");
        super::create_empty_exclusive(&fresh).unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stat_treats_enotdir_like_enoent() {
        let dir = temp_dir("enotdir");
        let file = dir.join("hello-world");
        std::fs::write(&file, b"x").unwrap();
        let nested = file.join("workflow.yaml");
        assert!(!super::stat_exists(&nested).unwrap());
        assert!(super::stat_exists(&file).unwrap());
        assert!(!super::stat_exists(&dir.join("missing")).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stat_treats_eacces_like_absent() {
        let dir = temp_dir("eacces");
        let blocked = dir.join("secret");
        std::fs::create_dir(&blocked).unwrap();
        let hidden = blocked.join("workflow.yaml");
        std::fs::write(&hidden, b"id: hidden\n").unwrap();
        let visible = dir.join("visible.txt");
        std::fs::write(&visible, b"ok").unwrap();
        let mut permissions = std::fs::metadata(&blocked).unwrap().permissions();
        let original = permissions.mode();
        permissions.set_mode(0o0);
        std::fs::set_permissions(&blocked, permissions.clone()).unwrap();
        assert!(super::stat_exists(&blocked).unwrap());
        assert!(super::stat_exists(&visible).unwrap());
        assert!(!super::stat_exists(&dir.join("missing")).unwrap());
        match std::fs::metadata(&hidden) {
            Ok(_) => {
                eprintln!(
                    "skipping EACCES existence assertion: process can still stat {}",
                    hidden.display()
                );
            }
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                assert!(!super::stat_exists(&hidden).unwrap());
            }
            Err(err) => panic!("expected EACCES or a successful stat, got {err}"),
        }
        permissions.set_mode(original);
        std::fs::set_permissions(&blocked, permissions).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn read_string_matches_node_read_file_utf8() {
        let golden: serde_json::Value = serde_json::from_str(
            &protocol::host::read_text(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let dir = temp_dir("lossy-read");
        for (index, case) in golden["read_file_utf8"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let bytes = decode_hex(case["hex"].as_str().unwrap());
            let path = dir.join(format!("file-{index}"));
            std::fs::write(&path, &bytes).unwrap();
            let text = super::read_string(&path).await.unwrap();
            let units: Vec<u16> = text.encode_utf16().collect();
            assert_eq!(units, units_of(&case["units"]), "{}", case["hex"]);
        }
        let missing = dir.join("missing.txt");
        let missing_err = super::read_string(&missing).await.unwrap_err();
        let missing_text = missing_err.to_string();
        assert!(
            missing_text.starts_with("ENOENT: no such file or directory, open '"),
            "{missing_text}"
        );
        assert!(missing_text.contains("missing.txt"), "{missing_text}");
        let dir_err = super::read_string(&dir).await.unwrap_err();
        assert_eq!(
            dir_err.to_string(),
            "EISDIR: illegal operation on a directory, read"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn units_of(value: &serde_json::Value) -> Vec<u16> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_u64().unwrap() as u16)
            .collect()
    }

    fn decode_hex(text: &str) -> Vec<u8> {
        let bytes = text.as_bytes();
        let mut out = Vec::with_capacity(bytes.len() / 2);
        let mut index = 0;
        while index + 1 < bytes.len() {
            out.push((hex_nibble(bytes[index]) << 4) | hex_nibble(bytes[index + 1]));
            index += 2;
        }
        out
    }

    fn hex_nibble(byte: u8) -> u8 {
        match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => panic!("hex"),
        }
    }
}
