use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use std::os::unix::fs::OpenOptionsExt;

pub trait Env {
    fn var(&self, name: &str) -> Option<String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    }
}

#[derive(Clone, Debug, Default)]
pub struct MapEnv {
    vars: HashMap<String, String>,
}

impl MapEnv {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, name: impl Into<String>, value: impl Into<String>) -> &mut Self {
        self.vars.insert(name.into(), value.into());
        self
    }
}

impl Env for MapEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
}

pub fn env_trimmed(env: &dyn Env, name: &str) -> Option<String> {
    env.var(name)
        .map(|value| crate::js::js_trim(&value).to_string())
}

pub fn home_dir(env: &dyn Env) -> Option<String> {
    if let Some(home) = env.var("HOME") {
        return Some(home);
    }
    passwd_home()
}

fn passwd_home() -> Option<String> {
    let user = nix::unistd::User::from_uid(nix::unistd::Uid::current())
        .ok()
        .flatten()?;
    Some(user.dir.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct FsError {
    pub code: &'static str,
    pub errno: i32,
    pub syscall: &'static str,
    pub path: Option<String>,
    pub dest: Option<String>,
    message: String,
}

impl FsError {
    pub fn node_string(&self) -> String {
        format!("Error: {}", self.message)
    }
}

pub fn read_text(path: &Path) -> Result<String, FsError> {
    let mut file =
        std::fs::File::open(path).map_err(|err| fs_error("open", Some(path), None, &err))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|err| fs_error("read", None, None, &err))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_text_capped(path: &Path, max_bytes: u64) -> Result<String, FsError> {
    let file = std::fs::File::open(path).map_err(|err| fs_error("open", Some(path), None, &err))?;
    let mut limited = file.take(max_bytes);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|err| fs_error("read", None, None, &err))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn write_text(path: &Path, text: &str) -> Result<(), FsError> {
    let mut file = open_write(path)?;
    file.write_all(text.as_bytes())
        .map_err(|err| fs_error("write", None, None, &err))
}

pub fn mkdir(path: &Path) -> Result<(), FsError> {
    std::fs::create_dir(path).map_err(|err| fs_error("mkdir", Some(path), None, &err))
}

pub fn rmdir(path: &Path) -> Result<(), FsError> {
    std::fs::remove_dir(path).map_err(|err| fs_error("rmdir", Some(path), None, &err))
}

pub fn read_dir(path: &Path) -> Result<Vec<String>, FsError> {
    let entries =
        std::fs::read_dir(path).map_err(|err| fs_error("scandir", Some(path), None, &err))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| fs_error("scandir", Some(path), None, &err))?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

pub fn stat(path: &Path) -> Result<std::fs::Metadata, FsError> {
    std::fs::metadata(path).map_err(|err| fs_error("stat", Some(path), None, &err))
}

pub fn lstat(path: &Path) -> Result<std::fs::Metadata, FsError> {
    std::fs::symlink_metadata(path).map_err(|err| fs_error("lstat", Some(path), None, &err))
}

pub fn unlink(path: &Path) -> Result<(), FsError> {
    std::fs::remove_file(path).map_err(|err| fs_error("unlink", Some(path), None, &err))
}

pub fn rename(from: &Path, to: &Path) -> Result<(), FsError> {
    std::fs::rename(from, to).map_err(|err| fs_error("rename", Some(from), Some(to), &err))
}

pub fn copy_file(from: &Path, to: &Path) -> Result<u64, FsError> {
    std::fs::copy(from, to).map_err(|err| fs_error("copyfile", Some(from), Some(to), &err))
}

pub fn realpath(path: &Path) -> Result<PathBuf, FsError> {
    std::fs::symlink_metadata(path).map_err(|err| fs_error("lstat", Some(path), None, &err))?;
    std::fs::canonicalize(path).map_err(|err| fs_error("realpath", Some(path), None, &err))
}

pub fn access(path: &Path) -> Result<(), FsError> {
    nix::unistd::access(path, nix::unistd::AccessFlags::F_OK).map_err(|err| {
        let io = std::io::Error::from_raw_os_error(err as i32);
        fs_error("access", Some(path), None, &io)
    })
}

pub fn read_link(path: &Path) -> Result<PathBuf, FsError> {
    std::fs::read_link(path).map_err(|err| fs_error("readlink", Some(path), None, &err))
}

pub fn symlink(target: &Path, link: &Path) -> Result<(), FsError> {
    std::os::unix::fs::symlink(target, link)
        .map_err(|err| fs_error("symlink", Some(target), Some(link), &err))
}

pub fn open_read(path: &Path) -> Result<std::fs::File, FsError> {
    std::fs::File::open(path).map_err(|err| fs_error("open", Some(path), None, &err))
}

pub fn open_write(path: &Path) -> Result<std::fs::File, FsError> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|err| fs_error("open", Some(path), None, &err))
}

pub fn atomic_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = unique_temp(path);
    let mut file = create_exclusive(&tmp)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(err) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    sync_parent(path)
}

fn unique_temp(path: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let ticket = NEXT.fetch_add(1, Ordering::Relaxed);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{}.{ticket}.tmp", std::process::id()));
    PathBuf::from(name)
}

fn create_exclusive(path: &Path) -> std::io::Result<std::fs::File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

pub fn fs_error(
    syscall: &'static str,
    path: Option<&Path>,
    dest: Option<&Path>,
    err: &std::io::Error,
) -> FsError {
    let raw = err.raw_os_error().unwrap_or(0);
    let (code, description) = node_code(raw);
    let path = path.map(|item| item.display().to_string());
    let dest = dest.map(|item| item.display().to_string());
    let mut message = format!("{code}: {description}, {syscall}");
    if let Some(path) = &path {
        message.push_str(" '");
        message.push_str(path);
        message.push('\'');
    }
    if let Some(dest) = &dest {
        message.push_str(" -> '");
        message.push_str(dest);
        message.push('\'');
    }
    FsError {
        code,
        errno: -raw,
        syscall,
        path,
        dest,
        message,
    }
}

fn node_code(errno: i32) -> (&'static str, &'static str) {
    match errno {
        1 => ("EPERM", "operation not permitted"),
        2 => ("ENOENT", "no such file or directory"),
        4 => ("EINTR", "interrupted system call"),
        5 => ("EIO", "i/o error"),
        6 => ("ENXIO", "no such device or address"),
        7 => ("E2BIG", "argument list too long"),
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
        38 => ("ENOSYS", "function not implemented"),
        39 => ("ENOTEMPTY", "directory not empty"),
        40 => ("ELOOP", "too many symbolic links encountered"),
        61 => ("ENODATA", "no data available"),
        75 => ("EOVERFLOW", "value too large for defined data type"),
        84 => ("EILSEQ", "illegal byte sequence"),
        95 => ("ENOTSUP", "operation not supported on socket"),
        116 => ("ESTALE", "stale file handle"),
        121 => ("EREMOTEIO", "remote I/O error"),
        122 => ("EDQUOT", "disk quota exceeded"),
        125 => ("ECANCELED", "operation canceled"),
        _ => ("UNKNOWN", "unknown error"),
    }
}

fn sync_parent(path: &Path) -> std::io::Result<()> {
    let parent = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let dir = std::fs::File::open(parent)?;
    dir.sync_all()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use std::path::Path;

    use super::{
        MapEnv, atomic_replace, env_trimmed, fs_error, home_dir, read_text, read_text_capped,
        write_text,
    };

    #[test]
    fn trimmed_home_and_files() {
        let mut env = MapEnv::new();
        assert_eq!(env_trimmed(&env, "HOME"), None);
        env.set("HOME", "  x  ");
        assert_eq!(env_trimmed(&env, "HOME").as_deref(), Some("x"));
        env.set("EMPTY", "");
        assert_eq!(env_trimmed(&env, "EMPTY").as_deref(), Some(""));
        env.set("BLANK", " \n");
        assert_eq!(env_trimmed(&env, "BLANK").as_deref(), Some(""));
        env.set("HOME", "");
        assert_eq!(home_dir(&env).as_deref(), Some(""));
        env.set("HOME", "relative/dir");
        assert_eq!(home_dir(&env).as_deref(), Some("relative/dir"));

        let dir = std::env::temp_dir();
        let path = dir.join(format!("rr0-host-{}", std::process::id()));
        write_text(&path, "héllo").unwrap();
        assert_eq!(read_text(&path).unwrap(), "héllo");
        assert_eq!(read_text_capped(&path, 1).unwrap(), "h");
        atomic_replace(&path, b"next").unwrap();
        assert_eq!(read_text(&path).unwrap(), "next");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let mut tmp_name = path.as_os_str().to_os_string();
        tmp_name.push(".tmp");
        assert!(!std::path::PathBuf::from(tmp_name).exists());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn atomic_replace_leaves_another_writers_temp() {
        let dir = std::env::temp_dir().join(format!("rr0-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("state.json");
        let mut decoy_name = target.as_os_str().to_os_string();
        decoy_name.push(".tmp");
        let decoy = std::path::PathBuf::from(decoy_name);
        std::fs::write(&decoy, b"other").unwrap();
        atomic_replace(&target, b"ours").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"ours");
        assert_eq!(std::fs::read(&decoy).unwrap(), b"other");
        atomic_replace(&target, b"second").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert_eq!(std::fs::read(&decoy).unwrap(), b"other");
        let names = dir_names(&dir);
        assert!(names.iter().any(|name| name == "state.json"));
        assert!(names.iter().any(|name| name == "state.json.tmp"));
        assert_eq!(names.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn atomic_replace_failure_removes_only_its_temp() {
        let dir = std::env::temp_dir().join(format!("rr0-atomic-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("adir");
        std::fs::create_dir(&target).unwrap();
        let mut decoy_name = target.as_os_str().to_os_string();
        decoy_name.push(".tmp");
        let decoy = std::path::PathBuf::from(decoy_name);
        std::fs::write(&decoy, b"other").unwrap();
        let keep = dir.join("keep");
        std::fs::write(&keep, b"safe").unwrap();
        assert!(atomic_replace(&target, b"ours").is_err());
        assert!(target.is_dir());
        assert_eq!(std::fs::read(&decoy).unwrap(), b"other");
        assert_eq!(std::fs::read(&keep).unwrap(), b"safe");
        let missing = dir.join("missing").join("state.json");
        assert!(atomic_replace(&missing, b"x").is_err());
        assert_eq!(std::fs::read(&decoy).unwrap(), b"other");
        assert_eq!(std::fs::read(&keep).unwrap(), b"safe");
        let leftovers: Vec<_> = dir_names(&dir)
            .into_iter()
            .filter(|name| name.contains(".tmp") && name != "adir.tmp")
            .collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_failure_uses_the_write_syscall() {
        let path = Path::new("/dev/full");
        let err = write_text(path, "x").unwrap_err();
        assert_eq!(err.code, "ENOSPC");
        assert_eq!(err.errno, -28);
        assert_eq!(err.syscall, "write");
        assert_eq!(err.path, None);
        assert_eq!(err.to_string(), "ENOSPC: no space left on device, write");
        assert_eq!(
            err.node_string(),
            "Error: ENOSPC: no space left on device, write"
        );
    }

    fn dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn filesystem_errno_text_matches_libuv() {
        let io = fs_error(
            "open",
            Some(Path::new("/tmp/x")),
            None,
            &std::io::Error::from_raw_os_error(5),
        );
        assert_eq!(io.code, "EIO");
        assert_eq!(io.errno, -5);
        assert_eq!(io.syscall, "open");
        assert_eq!(io.to_string(), "EIO: i/o error, open '/tmp/x'");
        assert_eq!(io.node_string(), "Error: EIO: i/o error, open '/tmp/x'");
        let space = fs_error(
            "write",
            Some(Path::new("/tmp/full")),
            None,
            &std::io::Error::from_raw_os_error(28),
        );
        assert_eq!(
            space.to_string(),
            "ENOSPC: no space left on device, write '/tmp/full'"
        );
        let link = fs_error(
            "open",
            Some(Path::new("a")),
            Some(Path::new("b")),
            &std::io::Error::from_raw_os_error(40),
        );
        assert_eq!(
            link.to_string(),
            "ELOOP: too many symbolic links encountered, open 'a' -> 'b'"
        );
        assert_eq!(
            link.node_string(),
            "Error: ELOOP: too many symbolic links encountered, open 'a' -> 'b'"
        );
        let unknown = fs_error("stat", None, None, &std::io::Error::from_raw_os_error(3));
        assert_eq!(unknown.code, "UNKNOWN");
        assert_eq!(unknown.to_string(), "UNKNOWN: unknown error, stat");
    }
}
