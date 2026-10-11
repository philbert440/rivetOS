use std::path::Path;

use serde_json::Value;

use crate::fsutil::{self, lossy};
use crate::value::{Obj, jtrim};

pub struct ParsedLine {
    pub index: usize,
    pub offset: u64,
    pub value: Value,
}

pub struct JsonlFile {
    pub lines: Vec<ParsedLine>,
    pub objects: Vec<Obj>,
    pub truncated: bool,
    pub text: String,
}

impl JsonlFile {
    pub fn empty() -> Self {
        Self {
            lines: Vec::new(),
            objects: Vec::new(),
            truncated: false,
            text: String::new(),
        }
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
            && let Some(nl) = text.find('\n')
        {
            text = text[nl + 1..].to_string();
        }
        (text, start > 0)
    } else {
        let Some(bytes) = fsutil::read_bytes(path) else {
            return JsonlFile::empty();
        };
        (lossy(&bytes), false)
    };
    let lines = parse_lines(&text);
    JsonlFile {
        objects: lines_objects(&lines),
        lines,
        truncated,
        text,
    }
}

pub fn kept_window_offset(bytes: &[u8], max_bytes: u64) -> (u64, bool) {
    let size = bytes.len() as u64;
    if size <= max_bytes {
        return (0, false);
    }
    let start = (size - max_bytes) as usize;
    let kept = bytes[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| start + index + 1)
        .unwrap_or(start);
    (fsutil::lossy(&bytes[..kept]).len() as u64, true)
}

pub fn last_line_index(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let newlines = text.bytes().filter(|byte| *byte == b'\n').count();
    let extra = usize::from(!text.ends_with('\n'));
    newlines.saturating_add(extra).saturating_sub(1)
}

pub fn parse_lines(text: &str) -> Vec<ParsedLine> {
    parse_lines_at(text, 0, 0)
}

pub fn parse_lines_at(text: &str, index_base: usize, offset_base: u64) -> Vec<ParsedLine> {
    let mut out = Vec::new();
    let mut offset = 0u64;
    for (index, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = jtrim(line);
        if trimmed.starts_with('{')
            && let Ok(value) = protocol::js::parse(trimmed)
            && value.is_object()
        {
            out.push(ParsedLine {
                index: index_base.saturating_add(index),
                offset: offset_base.saturating_add(offset),
                value,
            });
        }
        offset = offset.saturating_add(raw.len() as u64).saturating_add(1);
    }
    out
}

pub fn lines_objects(lines: &[ParsedLine]) -> Vec<Obj> {
    lines
        .iter()
        .filter_map(|line| line.value.as_object().cloned())
        .collect()
}

pub fn objects_of(text: &str) -> Vec<Obj> {
    lines_objects(&parse_lines(text))
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
    let value = protocol::js::parse(text).ok()?;
    value.as_object().cloned()
}
