use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn system_ms(time: SystemTime) -> Option<i64> {
    let dur = time.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(dur.as_millis()).ok()
}

pub fn mtime_ms(path: &Path) -> Option<i64> {
    system_ms(fs::metadata(path).ok()?.modified().ok()?)
}

pub fn birth_ms(path: &Path) -> i64 {
    let Ok(meta) = fs::metadata(path) else {
        return 0;
    };
    let created = meta.created().ok().and_then(system_ms).filter(|ms| *ms > 0);
    created.or_else(|| meta.modified().ok().and_then(system_ms)).unwrap_or(0)
}

pub fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|meta| meta.len())
}

pub struct FileStamp {
    pub size: u64,
    pub mtime_ms: i64,
    pub ino: u64,
    pub dev: u64,
}

pub fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    Some(FileStamp {
        size: meta.len(),
        mtime_ms: system_ms(meta.modified().ok()?).unwrap_or(0),
        ino: meta.ino(),
        dev: meta.dev(),
    })
}

pub fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

pub fn is_dir(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_dir())
}

pub fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

pub fn read_dir_names(path: &Path) -> Option<Vec<String>> {
    let entries = fs::read_dir(path).ok()?;
    let mut names = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Some(names)
}

pub fn read_bytes(path: &Path) -> Option<Vec<u8>> {
    fs::read(path).ok()
}

pub fn read_range(path: &Path, start: u64, end: u64) -> Option<Vec<u8>> {
    if end <= start {
        return Some(Vec::new());
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let len = usize::try_from(end - start).ok()?;
    let mut buf = vec![0_u8; len];
    let mut off = 0;
    while off < len {
        match file.read(&mut buf[off..]) {
            Ok(0) => break,
            Ok(n) => off += n,
            Err(_) => return None,
        }
    }
    buf.truncate(off);
    Some(buf)
}

pub fn read_prefix_lossy(path: &Path, max: usize) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buf = vec![0_u8; max];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub fn read_lossy(path: &Path) -> Option<String> {
    let bytes = read_bytes(path)?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn set_mtime(path: &Path, ms: u64) -> bool {
    let Some(time) = UNIX_EPOCH.checked_add(std::time::Duration::from_millis(ms)) else {
        return false;
    };
    OpenOptions::new().write(true).open(path).and_then(|file| file.set_modified(time)).is_ok()
}

pub fn node_resolve(base: &Path, input: &str) -> PathBuf {
    let raw = Path::new(input);
    let joined = if input.is_empty() {
        base.to_path_buf()
    } else if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        base.join(raw)
    };
    normalize_path(&joined)
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

pub fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
