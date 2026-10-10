use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use transcripts::fsutil::set_mtime;
use transcripts::roots::Roots;
use transcripts::value::Obj;

pub fn objs(value: Value) -> Vec<Obj> {
    value.as_array().expect("array").iter().map(|item| item.as_object().expect("object").clone()).collect()
}

pub fn obj(value: Value) -> Obj {
    value.as_object().expect("object").clone()
}

pub struct Tmp(PathBuf);

impl Tmp {
    pub fn new(label: &str) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("rr4a-{label}-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("tmpdir");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn roots(&self) -> Roots {
        Roots::isolated(&self.0)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn write(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parents");
    }
    std::fs::write(path, body).expect("write");
}

pub fn touch(path: &Path, ms: u64) {
    assert!(set_mtime(path, ms), "mtime {}", path.display());
}

pub fn sqlite(path: &Path, sql: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parents");
    }
    let conn = rusqlite::Connection::open(path).expect("sqlite");
    conn.pragma_update(None, "journal_mode", "DELETE").expect("journal");
    conn.execute_batch(sql).expect("sql");
}
