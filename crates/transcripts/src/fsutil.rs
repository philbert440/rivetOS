use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn file_clock_ms(time: SystemTime) -> Option<i64> {
    let dur = time.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(dur.as_millis()).ok()
}

pub fn mtime_ms(path: &Path) -> Option<i64> {
    file_clock_ms(fs::metadata(path).ok()?.modified().ok()?)
}

pub fn birth_ms(path: &Path) -> i64 {
    let Ok(meta) = fs::metadata(path) else {
        return 0;
    };
    let created = meta
        .created()
        .ok()
        .and_then(file_clock_ms)
        .filter(|ms| *ms > 0);
    created
        .or_else(|| meta.modified().ok().and_then(file_clock_ms))
        .unwrap_or(0)
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
        mtime_ms: file_clock_ms(meta.modified().ok()?).unwrap_or(0),
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
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(time))
        .is_ok()
}

pub fn node_resolve(base: &Path, input: &str) -> PathBuf {
    PathBuf::from(protocol::js::posix_resolve(
        &base.to_string_lossy(),
        &[input],
    ))
}

pub fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[derive(Clone, Debug, Default)]
pub struct RewriteMark {
    pub head: Vec<u8>,
    pub boundary: Vec<u8>,
}

pub fn rewrite_mark(path: &Path, offset: u64) -> RewriteMark {
    if offset == 0 {
        return RewriteMark::default();
    }
    let head_len = offset.min(64);
    let head = read_range(path, 0, head_len).unwrap_or_default();
    let boundary_len = offset.min(64);
    let boundary_start = offset - boundary_len;
    let boundary = if boundary_start == 0 {
        head.clone()
    } else {
        read_range(path, boundary_start, offset).unwrap_or_default()
    };
    RewriteMark { head, boundary }
}

#[derive(Clone, Debug)]
pub struct CursorIdentity {
    pub offset: u64,
    pub dev: u64,
    pub ino: u64,
    pub mark: RewriteMark,
}

impl CursorIdentity {
    pub fn fresh(dev: u64, ino: u64) -> Self {
        Self {
            offset: 0,
            dev,
            ino,
            mark: RewriteMark::default(),
        }
    }
}

pub fn cursor_was_replaced(
    path: &Path,
    prior: &CursorIdentity,
    len: u64,
    now_dev: u64,
    now_ino: u64,
) -> bool {
    if len < prior.offset {
        return true;
    }
    if prior.offset == 0 {
        return false;
    }
    if prior.dev != now_dev || prior.ino != now_ino {
        return true;
    }
    region_changed(path, 0, &prior.mark.head)
        || region_changed(
            path,
            prior
                .offset
                .saturating_sub(prior.mark.boundary.len() as u64),
            &prior.mark.boundary,
        )
}

fn region_changed(path: &Path, start: u64, expected: &[u8]) -> bool {
    if expected.is_empty() {
        return true;
    }
    let end = start.saturating_add(expected.len() as u64);
    read_range(path, start, end).is_none_or(|got| got.as_slice() != expected)
}
