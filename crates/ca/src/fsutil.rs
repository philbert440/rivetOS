use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use fd_lock::RwLock;

use crate::error::Error;

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

pub fn replace_bytes(path: &Path, bytes: &[u8], mode: u32, keep_old: bool) -> Result<(), Error> {
    reject_symlink(path)?;
    let previous = existing_mode(path)?;
    if keep_old && path.is_file() {
        backup_to_old(path)?;
    }
    protocol::host::atomic_replace(path, bytes)?;
    let applied = applied_mode(previous, mode)?;
    if applied != 0o600 {
        fs::set_permissions(path, fs::Permissions::from_mode(applied))?;
        let file = File::open(path)?;
        file.sync_all()?;
    }
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

fn existing_mode(path: &Path) -> Result<Option<u32>, Error> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(Error::msg(format!("refusing symlink {}", path.display())))
        }
        Ok(meta) => Ok(Some(meta.permissions().mode() & 0o777)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn current_umask() -> Result<u32, Error> {
    let text = fs::read_to_string("/proc/self/status")?;
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("Umask:") else {
            continue;
        };
        let value =
            u32::from_str_radix(rest.trim(), 8).map_err(|_| Error::msg("umask unavailable"))?;
        return Ok(value & 0o777);
    }
    Err(Error::msg("umask unavailable"))
}

fn applied_mode(previous: Option<u32>, requested: u32) -> Result<u32, Error> {
    let requested = requested & 0o777;
    let umask = current_umask()?;
    let base = if requested == 0o600 { 0o600 } else { 0o666 };
    let created = base & !umask;
    Ok(match previous {
        Some(existing) => {
            let existing = existing & 0o777;
            if requested == 0o600 {
                existing & 0o600
            } else {
                existing
            }
        }
        None => created,
    })
}

fn backup_to_old(path: &Path) -> Result<(), Error> {
    let bytes = match read_optional(path)? {
        Some(bytes) => bytes,
        None => return Ok(()),
    };
    replace_bytes(&old_path(path), &bytes, 0o644, false)
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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::{old_path, replace_bytes};

    fn mode(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn replace_uses_the_requested_mode_and_keeps_old() {
        let dir = std::env::temp_dir().join(format!("rr9c-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.txt");
        let public = 0o666 & !super::current_umask().unwrap();
        replace_bytes(&path, b"one\n", 0o644, true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"one\n");
        assert_eq!(mode(&path), public);
        assert!(!old_path(&path).exists());
        replace_bytes(&path, b"two\n", 0o644, true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two\n");
        assert_eq!(std::fs::read(old_path(&path)).unwrap(), b"one\n");
        assert_eq!(mode(&old_path(&path)), public);
        let secret = dir.join("ca.key");
        replace_bytes(&secret, b"secret", 0o600, false).unwrap();
        assert_eq!(mode(&secret), 0o600);
        let link = dir.join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let err = replace_bytes(&link, b"nope", 0o644, false).unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("refusing symlink {}", link.display())
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"two\n");
        let old_link = old_path(&secret);
        std::os::unix::fs::symlink(&secret, &old_link).unwrap();
        let err = replace_bytes(&secret, b"next", 0o600, true).unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("refusing symlink {}", old_link.display())
        );
        assert_eq!(std::fs::read(&secret).unwrap(), b"secret");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_keeps_script_modes_under_restrictive_umask() {
        if std::env::var_os("RR9C_UMASK_CHILD").is_some() {
            let dir = std::path::PathBuf::from(std::env::var("RR9C_UMASK_DIR").unwrap());
            replace_bytes(&dir.join("openssl.cnf"), b"new\n", 0o644, false).unwrap();
            replace_bytes(&dir.join("kept.cnf"), b"next\n", 0o644, false).unwrap();
            replace_bytes(&dir.join("wide.cnf"), b"wide\n", 0o644, false).unwrap();
            replace_bytes(&dir.join("device.p12"), b"p12", 0o600, false).unwrap();
            replace_bytes(&dir.join("tight.p12"), b"p12", 0o600, false).unwrap();
            std::process::exit(0);
        }
        let dir = std::env::temp_dir().join(format!(
            "rr9c-umask-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let kept = dir.join("kept.cnf");
        std::fs::write(&kept, b"old\n").unwrap();
        std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o600)).unwrap();
        let wide = dir.join("wide.cnf");
        std::fs::write(&wide, b"old\n").unwrap();
        std::fs::set_permissions(&wide, std::fs::Permissions::from_mode(0o644)).unwrap();
        let secret = dir.join("device.p12");
        std::fs::write(&secret, b"old").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o640)).unwrap();
        let tight = dir.join("tight.p12");
        std::fs::write(&tight, b"old").unwrap();
        std::fs::set_permissions(&tight, std::fs::Permissions::from_mode(0o400)).unwrap();
        let name = std::thread::current().name().unwrap().to_string();
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg("umask 077; exec \"$0\" \"$@\"")
            .arg(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(&name)
            .env("RR9C_UMASK_CHILD", "1")
            .env("RR9C_UMASK_DIR", &dir)
            .status()
            .unwrap();
        assert!(status.success(), "{status}");
        assert_eq!(mode(&dir.join("openssl.cnf")), 0o600);
        assert_eq!(std::fs::read(dir.join("openssl.cnf")).unwrap(), b"new\n");
        assert_eq!(mode(&kept), 0o600);
        assert_eq!(std::fs::read(&kept).unwrap(), b"next\n");
        assert_eq!(mode(&wide), 0o644);
        assert_eq!(std::fs::read(&wide).unwrap(), b"wide\n");
        assert_eq!(mode(&secret), 0o600);
        assert_eq!(mode(&tight), 0o400);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
