use std::path::Path;

use serde_json::Value;

use crate::fsutil::{self, lossy};
use crate::text::object_from_line;
use crate::value::Obj;

pub struct JsonlFile {
    pub objects: Vec<Obj>,
    pub truncated: bool,
    pub text: String,
}

impl JsonlFile {
    pub fn empty() -> Self {
        Self { objects: Vec::new(), truncated: false, text: String::new() }
    }
}

pub fn read_jsonl(path: &Path, max_bytes: u64) -> JsonlFile {
    let Some(size) = fsutil::file_len(path) else {
        return JsonlFile::empty();
    };
    let (text, truncated) = if size > max_bytes {
        let start = size - max_bytes;
        let Some(bytes) = fsutil::read_range(path, start, size) else {
            return JsonlFile::empty();
        };
        let mut text = lossy(&bytes);
        if start > 0
            && let Some(nl) = text.find('\n') {
                text = text[nl + 1..].to_string();
            }
        (text, start > 0)
    } else {
        let Some(bytes) = fsutil::read_bytes(path) else {
            return JsonlFile::empty();
        };
        (lossy(&bytes), false)
    };
    JsonlFile { objects: objects_of(&text), truncated, text }
}

pub fn objects_of(text: &str) -> Vec<Obj> {
    let mut out = Vec::new();
    for line in split_lines(text) {
        if let Some(obj) = object_from_line(&line) {
            out.push(obj);
        }
    }
    out
}

pub fn split_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut rest = text;
    while let Some(idx) = rest.find('\n') {
        let mut line = &rest[..idx];
        if line.ends_with('\r') {
            line = &line[..line.len() - 1];
        }
        lines.push(line.to_string());
        rest = &rest[idx + 1..];
    }
    if !rest.is_empty() {
        let line = rest.strip_suffix('\r').unwrap_or(rest);
        lines.push(line.to_string());
    }
    lines
}

pub fn parse_object(text: &str) -> Option<Obj> {
    let value: Value = serde_json::from_str(text).ok()?;
    value.as_object().cloned()
}
