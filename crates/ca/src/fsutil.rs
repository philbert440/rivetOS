use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use fd_lock::RwLock;

use crate::error::Error;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn reject_symlink(path: &Path) -> Result<(), Error> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(Error::msg(format!("refusing symlink {}", path.display())))
        }
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub fn ensure_dir(path: &Path) -> Result<(), Error> {
    reject_symlink(path)?;
    fs::create_dir_all(path)?;
    reject_symlink(path)?;
    Ok(())
}

pub fn read_to_string(path: &Path) -> Result<String, Error> {
    reject_symlink(path)?;
    fs::read_to_string(path).map_err(Into::into)
}

pub fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(Error::msg(format!("refusing symlink {}", path.display())))
        }
        Ok(_) => Ok(Some(fs::read(path)?)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn remove_file(path: &Path) -> Result<(), Error> {
    reject_symlink(path)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub fn old_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".old");
    PathBuf::from(name)
}

pub fn atomic_write(path: &Path, bytes: &[u8], mode: u32, keep_old: bool) -> Result<(), Error> {
    reject_symlink(path)?;
    let tmp = temp_path(path)?;
    if let Err(err) = write_new(&tmp, bytes, mode) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if keep_old
        && path.is_file()
        && let Err(err) = backup_to_old(path)
    {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = replace_file(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    fsync_dir(parent_dir(path)?)?;
    Ok(())
}

pub fn create_secret(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    reject_symlink(path)?;
    write_new(path, bytes, 0o600)?;
    fsync_dir(parent_dir(path)?)?;
    Ok(())
}

pub fn with_dir_lock<T>(dir: &Path, body: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
    let mut lock = open_lock(dir)?;
    let _guard = lock
        .write()
        .map_err(|err| Error::msg(format!("lock {}: {err}", dir.display())))?;
    body()
}

pub fn with_both_locks<T>(
    first: &Path,
    second: &Path,
    body: impl FnOnce() -> Result<T, Error>,
) -> Result<T, Error> {
    if first == second {
        return with_dir_lock(first, body);
    }
    let (left, right) = if first.as_os_str() <= second.as_os_str() {
        (first, second)
    } else {
        (second, first)
    };
    let mut lock_left = open_lock(left)?;
    let mut lock_right = open_lock(right)?;
    let _left = lock_left
        .write()
        .map_err(|err| Error::msg(format!("lock {}: {err}", left.display())))?;
    let _right = lock_right
        .write()
        .map_err(|err| Error::msg(format!("lock {}: {err}", right.display())))?;
    body()
}

fn open_lock(dir: &Path) -> Result<RwLock<File>, Error> {
    reject_symlink(dir)?;
    if !dir.is_dir() {
        return Err(Error::msg(format!("no CA directory {}", dir.display())));
    }
    let path = dir.join(".ca.lock");
    reject_symlink(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)?;
    Ok(RwLock::new(file))
}

fn backup_to_old(path: &Path) -> Result<(), Error> {
    let bytes = match read_optional(path)? {
        Some(bytes) => bytes,
        None => return Ok(()),
    };
    atomic_write(&old_path(path), &bytes, 0o644, false)
}

fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<(), Error> {
    reject_symlink(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .map_err(|err| Error::msg(format!("create {}: {err}", path.display())))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn replace_file(from: &Path, to: &Path) -> Result<(), Error> {
    reject_symlink(to)?;
    fs::rename(from, to)?;
    Ok(())
}

fn parent_dir(path: &Path) -> Result<&Path, Error> {
    path.parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| Error::msg(format!("no parent for {}", path.display())))
}

fn fsync_dir(dir: &Path) -> Result<(), Error> {
    let file = File::open(dir)?;
    file.sync_all()?;
    Ok(())
}

fn temp_path(path: &Path) -> Result<PathBuf, Error> {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .ok_or_else(|| Error::msg(format!("no file name for {}", path.display())))?;
    let dir = parent_dir(path)?;
    Ok(dir.join(format!(
        ".{}.{}.{seq}.tmp",
        name.to_string_lossy(),
        std::process::id()
    )))
}
